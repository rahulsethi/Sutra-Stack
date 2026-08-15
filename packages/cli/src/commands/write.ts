// SPDX-License-Identifier: Apache-2.0
/**
 * The write commands: `capture` · `reveal` · `review`.
 *
 * `reveal` is the ONLY path in the entire product by which secret-tier content
 * is rendered anywhere, and it is worth reading closely — see the header on
 * `cmdReveal` below.
 */

import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  writeCapture, auditLog, authorizeSecretEgress, secretRevealCeiling,
  resolveOverrideSecret, isHostedContext, pendingRequests, loadPolicy,
  resolveExpiry, Brain, VaultClient, TIER_DISPLAY, ALLOWLIST_REL, REQUESTS_REL,
} from "@sutra/core";
import { EXIT, SutraError, type ExitCode } from "../exit.js";
import { say, emitJson, heading, table, warn, c, type OutputMode } from "../output.js";
import { flagString, type ParsedArgs } from "../args.js";
import type { Ctx } from "./read.js";

/** `sutra capture "<text>" [--tier private|secret] [--title T] [--tags a,b]` */
export function cmdCapture(ctx: Ctx, args: ParsedArgs): ExitCode {
  const text = args.positional.join(" ").trim();
  if (!text) {
    throw new SutraError("nothing to capture", EXIT.USAGE, 'sutra capture "the thing worth keeping"');
  }

  const tier = flagString(args, "tier");
  const title = flagString(args, "title");
  const tags = flagString(args, "tags")?.split(",").map((t) => t.trim()).filter(Boolean);

  const res = writeCapture(ctx.cfg.vaultRoot.path, {
    text,
    ...(title !== undefined ? { title } : {}),
    sensitivity: tier,
    tags: tags ?? [],
    source: "cli",
  });

  auditLog(ctx.cfg.vaultRoot.path, {
    kind: "capture.write", message: res.relPath, tier: res.tier, clamped: res.clamped, surface: "cli",
  });

  emitJson(ctx.mode, res);
  if (!ctx.mode.json) {
    say(ctx.mode, `${c.green("captured")} ${c.dim(res.relPath)} at tier ${c.bold(res.display)}`);
    if (res.clamped) {
      // Never a silent clamp. The user asked for something and got something else.
      say(ctx.mode, c.dim("  (clamped up — a capture can never be public; it is queued for review)"));
    }
  }
  return EXIT.OK;
}

/**
 * `sutra reveal <id>` — THE SECRET BREAK-GLASS.
 *
 * The only path by which `local_only` content is rendered. Every constraint
 * below is load-bearing:
 *
 *   1. **Direct-render only.** Refuses outright under `SUTRA_HOSTED=1`. If this
 *      process is a child of a gateway, stdout is an egress and no passphrase
 *      changes that. This is checked FIRST, before the passphrase is even read,
 *      so a hosted caller cannot learn whether a guess was right.
 *
 *   2. **Passphrase, compared constant-time, in-process.** No model verifies
 *      anything; a model could only ever relay what the user typed.
 *
 *   3. **Explicit y/N.** A typed confirmation, after being told what will
 *      happen. Not a flag, because a flag ends up in a shell script.
 *
 *   4. **Audited either way.** The DENIED line is the more interesting one.
 *
 *   5. **Per-item, single-use.** No flag is written, no TTL is set, nothing is
 *      cached. The next reveal starts from zero.
 *
 * It is imported by this file and nothing else. No cron job, no capability
 * runner, no MCP tool can reach `authorizeSecretEgress`, and
 * `tests/defects/secret-floor.test.ts` asserts that import graph — because the
 * guarantee "secret never reaches a model" is only as strong as the list of
 * callers of this function.
 */
export async function cmdReveal(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const id = args.positional[0];
  if (!id) throw new SutraError("no note id given", EXIT.USAGE, "sutra reveal <path|id>");

  if (isHostedContext()) {
    throw new SutraError(
      "refusing to reveal secret content in a hosted context",
      EXIT.HOSTED_CONTAINMENT,
      "SUTRA_HOSTED=1 means this output is an egress. Secret content is revealable only on a\n" +
      "  direct-render surface — your own terminal, with no model in the loop. No passphrase changes this.",
    );
  }

  const root = ctx.cfg.vaultRoot.path;
  const secret = resolveOverrideSecret(root);
  if (!secret) {
    throw new SutraError(
      "no override passphrase is configured on this node",
      EXIT.SENSITIVITY_BLOCK,
      `write one to ${join("state", "secrets", "override.key")} (gitignored), or set SUTRA_OVERRIDE_PASSPHRASE`,
    );
  }

  // Read the note at the reveal ceiling FIRST, so we can tell the user what
  // they are about to unlock before asking them to prove who they are.
  const trusted = new Brain(new VaultClient(root), secretRevealCeiling(), ctx.cfg.walkRoots);
  const note = trusted.getNote(id);
  if (note.status === "not_found") throw new SutraError(`no note matches "${id}"`, EXIT.NOT_FOUND);
  if (note.status === "withheld") {
    // Reachable only for do_not_learn, which the break-glass does NOT lift.
    throw new SutraError(
      `"${id}" is marked do_not_learn`,
      EXIT.LOCAL_ONLY_FLOOR,
      "That marking is absolute and is not what the break-glass is for. Edit the note's frontmatter\n" +
      "  yourself if you meant to remove it.",
    );
  }

  say(ctx.mode, "",
    c.yellow("BREAK-GLASS REVEAL"),
    `  note:  ${c.bold(note.note.title)} ${c.dim(note.note.relPath)}`,
    `  tier:  ${c.bold(TIER_DISPLAY[note.note.sensitivity])}`,
    "",
    c.dim("  This renders secret-tier content to this terminal, once. It is recorded in"),
    c.dim("  logs/oplog.md whether or not it succeeds. Nothing is cached and no flag is set."),
    "",
  );

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const question = (q: string): Promise<string> => new Promise((res) => rl.question(q, res));

  try {
    const answer = (await question("  Proceed? [y/N] ")).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      say(ctx.mode, c.dim("  cancelled"));
      return EXIT.OK;
    }
    const passphrase = (await question("  Passphrase: ")).trim();
    const auth = authorizeSecretEgress(root, passphrase, note.note.relPath);
    if (!auth.ok) {
      throw new SutraError(
        "passphrase not recognised",
        EXIT.SENSITIVITY_BLOCK,
        "The attempt has been recorded in logs/oplog.md.",
      );
    }
    say(ctx.mode, "", c.bold(`# ${note.note.title}`), c.dim(note.note.relPath), "", note.note.body, "",
      c.dim("  — end of reveal. This authorisation is spent; the next reveal starts from zero."));
    return EXIT.OK;
  } finally {
    rl.close();
  }
}

/**
 * `sutra review [--resolve <id>]` — the exposure request queue.
 *
 * D22's lesson applies here directly: the upstream review queue was 97%
 * machine artifacts, so nobody could act on it and it stopped being read. This
 * queue is DECISION-BEARING BY CONSTRUCTION — every entry is a specific note a
 * specific client asked for and was refused. There is nothing else in it.
 */
export async function cmdReview(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const root = ctx.cfg.vaultRoot.path;
  const pending = pendingRequests(root);
  const resolve = flagString(args, "resolve");

  if (!resolve) {
    emitJson(ctx.mode, { pending });
    if (!ctx.mode.json) {
      if (!pending.length) {
        say(ctx.mode, c.dim("no pending exposure requests"));
        return EXIT.OK;
      }
      heading(ctx.mode, `${pending.length} pending exposure request(s)`);
      table(ctx.mode, pending.map((r) => [r.at.slice(0, 16), `${r.note}  ${c.dim(`(${r.surface_hint ?? "unknown surface"})`)}`]));
      say(ctx.mode, "", c.dim("  sutra review --resolve <note-path>   to grant a time-boxed exposure"));
    }
    return EXIT.OK;
  }

  const req = pending.find((r) => r.note === resolve);
  if (!req) throw new SutraError(`no pending request for "${resolve}"`, EXIT.NOT_FOUND);

  const trusted = new Brain(new VaultClient(root), "local_only", ctx.cfg.walkRoots);
  const note = trusted.getNote(req.note);
  if (note.status !== "ok") throw new SutraError(`cannot read "${req.note}"`, EXIT.NOT_FOUND);

  // A promotion can only ever lift PRIVATE. Refuse early and say why, rather
  // than writing a promotion that is silently inert (which is what would happen
  // — `Brain.visible()` only consults promotions for review_required).
  if (note.note.sensitivity === "local_only") {
    throw new SutraError(
      `"${req.note}" is secret-tier`,
      EXIT.LOCAL_ONLY_FLOOR,
      "A promotion cannot lift the secret floor. Nothing can. If this note should be shareable,\n" +
      "  its tier is wrong — edit the note, and understand why it was classified that way first.",
    );
  }

  say(ctx.mode, "",
    `  note:   ${c.bold(note.note.title)} ${c.dim(note.note.relPath)}`,
    `  tier:   ${TIER_DISPLAY[note.note.sensitivity]}`,
    `  asked:  ${req.at} by ${req.surface_hint ?? "unknown surface"}`,
    "",
    c.dim("  Granting makes this ONE note visible to hosted clients until it expires."),
    "");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((res) => rl.question("  Grant? [y/N] ", res));
    if (answer.trim().toLowerCase() !== "y") {
      say(ctx.mode, c.dim("  denied"));
      return EXIT.OK;
    }

    const policy = loadPolicy(root);
    const granted = new Date().toISOString().slice(0, 10);
    const expires = resolveExpiry(policy, granted, flagString(args, "expires"));
    policy.promotions.push({
      id: `${granted}-${req.note.replace(/[^\w.-]/g, "_")}`,
      note: req.note,
      scope: req.scope,
      reason: flagString(args, "reason") ?? "granted via `sutra review`",
      granted,
      expires,
      granted_by: "cli",
    });

    const allowPath = join(root, ALLOWLIST_REL);
    mkdirSync(dirname(allowPath), { recursive: true });
    writeFileSync(allowPath, JSON.stringify(policy, null, 2) + "\n", "utf8");

    // Mark the request resolved so it stops reappearing.
    const reqPath = join(root, REQUESTS_REL);
    if (existsSync(reqPath)) {
      const store = JSON.parse(readFileSync(reqPath, "utf8")) as { requests: Array<{ note: string; status: string }> };
      for (const r of store.requests) if (r.note === req.note && r.status === "pending") r.status = "approved";
      writeFileSync(reqPath, JSON.stringify(store, null, 2) + "\n", "utf8");
    }

    auditLog(root, { kind: "exposure.granted", message: req.note, expires, surface: "cli" });
    say(ctx.mode, `  ${c.green("granted")} until ${expires}`,
      c.dim("  It expires on its own. Revoke early by deleting the entry from the allowlist."));
    return EXIT.OK;
  } finally {
    rl.close();
  }
}

// `sutra rescan` (I15) lives in `pipeline.ts` — it is a corpus operation, and
// it must use exactly the classifier the gate uses.
