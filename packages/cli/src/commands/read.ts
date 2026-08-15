// SPDX-License-Identifier: Apache-2.0
/**
 * The read commands: `ask` · `search` · `get` · `read` · `gate` · `status`.
 *
 * ── THE LOCAL CLI RUNS AT THE SECRET CEILING, AND THAT IS CORRECT ──────────
 * A local `sutra` invocation renders to the user's own terminal. No model is in
 * the loop, so there is no egress and the ceiling is `local_only` — the user
 * can see their own notes.
 *
 * The exception, and it is not optional: `SUTRA_HOSTED=1`. When this process is
 * a child of a hosted gateway, stdout IS an egress, and the ceiling drops to
 * whatever the gateway registered. That check lives in `ceilingForCli()` below
 * and is the reason the CLI is not simply "trusted".
 */

import {
  loadConfig, VaultClient, Brain, ask, hybridSearch, semanticSearch,
  extractSection, isHostedContext, ceilingFromEnv, TIER_DISPLAY, type Tier, type SutraConfig,
} from "@sutra/core";
import { EXIT, SutraError, type ExitCode } from "../exit.js";
import { say, emitJson, heading, table, degraded, c, type OutputMode } from "../output.js";
import { flagString, flagNumber, flagBool, type ParsedArgs } from "../args.js";

/**
 * The ceiling for a local CLI invocation.
 *
 * `local_only` — the user reading their own vault on their own screen — UNLESS
 * this process is running inside a hosted context, in which case whatever
 * ceiling the gateway set applies. A CLI that assumed "local means trusted"
 * would become a gate bypass the moment someone wired it behind a chat bot,
 * which is exactly the shape of thing people do wire.
 */
export function ceilingForCli(): { ceiling: Tier; reason: string } {
  if (isHostedContext()) {
    const ceiling = ceilingFromEnv();
    return {
      ceiling,
      reason:
        `SUTRA_HOSTED=1 — this process is running inside a hosted context, so its output is an ` +
        `egress. Ceiling is ${TIER_DISPLAY[ceiling]}, not secret.`,
    };
  }
  return { ceiling: "local_only", reason: "local terminal, no model in the loop" };
}

export interface Ctx {
  cfg: SutraConfig;
  vc: VaultClient;
  brain: Brain;
  ceiling: Tier;
  ceilingReason: string;
  mode: OutputMode;
}

export function makeContext(args: ParsedArgs, mode: OutputMode): Ctx {
  const explicitVault = flagString(args, "vault");
  if (explicitVault) process.env["SUTRA_VAULT"] = explicitVault;
  const explicitConfig = flagString(args, "config");
  if (explicitConfig) process.env["SUTRA_CONFIG"] = explicitConfig;

  const cfg = loadConfig();
  const { ceiling, reason } = ceilingForCli();
  const vc = new VaultClient(cfg.vaultRoot.path);
  return { cfg, vc, brain: new Brain(vc, ceiling, cfg.walkRoots), ceiling, ceilingReason: reason, mode };
}

/**
 * `sutra ask "<question>"`
 *
 * Works with no key, no model and no network — the M2 decision. What comes back
 * is the cited source material from the user's own notes, and that is a real
 * answer rather than a placeholder for one.
 */
export function cmdAsk(ctx: Ctx, args: ParsedArgs): ExitCode {
  const question = args.positional.join(" ").trim();
  if (!question) {
    throw new SutraError("no question given", EXIT.USAGE, 'sutra ask "what do I know about X?"');
  }

  const r = ask(ctx.cfg.vaultRoot.path, ctx.cfg.installRoot.path, ctx.brain, question, {
    k: flagNumber(args, "k", 6),
    rerank: flagBool(args, "rerank"),
    graphBoost: flagBool(args, "graph-boost"),
  });

  emitJson(ctx.mode, r);
  if (!ctx.mode.json) {
    if (r.answer) say(ctx.mode, r.answer, "");
    say(ctx.mode, r.context_block);
    if (r.sources.length) {
      heading(ctx.mode, "Sources");
      table(ctx.mode, r.sources.map((s) => [`[${s.n}] ${s.tier}`, `${s.title}  ${c.dim(s.relPath)}`]));
    }
    say(
      ctx.mode, "",
      c.dim(`ceiling ${r.exposure_display} · retrieval ${r.retrieval_mode} · synthesis ${r.synthesis_mode} · ${r.withheld} withheld`),
    );
    degraded(ctx.mode, ...r.degraded);
  }
  return EXIT.OK;
}

/** `sutra search <query>` */
export function cmdSearch(ctx: Ctx, args: ParsedArgs): ExitCode {
  const query = args.positional.join(" ").trim();
  if (!query) throw new SutraError("no query given", EXIT.USAGE, 'sutra search "term"');

  const limit = flagNumber(args, "limit", 10);

  if (flagBool(args, "semantic")) {
    const r = semanticSearch(ctx.cfg.vaultRoot.path, ctx.cfg.installRoot.path, query, ctx.ceiling, limit);
    emitJson(ctx.mode, r);
    if (r.status !== "ok") {
      degraded(ctx.mode, r.message);
      // Not an error: an unbuilt index is a state, and the remedy is printed.
      return EXIT.OK;
    }
    if (!ctx.mode.json) {
      table(ctx.mode, r.hits.map((h) => [h.score.toFixed(3), `${h.title}  ${c.dim(h.relPath)} (${TIER_DISPLAY[h.sensitivity]})`]));
      say(ctx.mode, "", c.dim(`${r.hits.length} shown · ${r.scanned} indexed · ${r.withheld} withheld · model ${r.model}`));
    }
    return EXIT.OK;
  }

  if (flagBool(args, "hybrid")) {
    const r = hybridSearch(ctx.cfg.vaultRoot.path, ctx.cfg.installRoot.path, ctx.brain, query, limit);
    emitJson(ctx.mode, r);
    if (!ctx.mode.json) {
      table(ctx.mode, r.hits.map((h) => [h.via, `${h.title}  ${c.dim(h.relPath)} (${TIER_DISPLAY[h.sensitivity]})`]));
      say(ctx.mode, "", c.dim(`${r.hits.length} shown · ${r.scanned} scanned · ${r.withheld} withheld · ${r.retrieval}`));
      degraded(ctx.mode, ...r.degraded);
    }
    return EXIT.OK;
  }

  const r = ctx.brain.search(query, limit);
  emitJson(ctx.mode, r);
  if (!ctx.mode.json) {
    for (const h of r.hits) {
      say(ctx.mode, `${c.bold(h.title)}  ${c.dim(h.relPath)} ${c.dim(`(${TIER_DISPLAY[h.sensitivity]})`)}`);
      say(ctx.mode, c.dim("  " + h.snippet));
    }
    if (!r.hits.length) say(ctx.mode, c.dim("no visible note matched"));
    say(ctx.mode, "", c.dim(`${r.hits.length} shown · ${r.scanned} scanned · ${r.withheld} withheld`));
  }
  return EXIT.OK;
}

/** `sutra get <id>` */
export function cmdGet(ctx: Ctx, args: ParsedArgs): ExitCode {
  const id = args.positional[0];
  if (!id) throw new SutraError("no note id given", EXIT.USAGE, "sutra get <path|id|filename>");

  const r = ctx.brain.getNote(id);
  emitJson(ctx.mode, r);

  if (r.status === "not_found") {
    throw new SutraError(`no note matches "${id}"`, EXIT.NOT_FOUND, "sutra search to find it");
  }
  if (r.status === "withheld") {
    // EXIT 4, not 1. The caller must be able to tell "the gate said no" from
    // "something broke", because only one of those is worth retrying.
    throw new SutraError(
      `"${id}" is withheld at the current ceiling (${TIER_DISPLAY[ctx.ceiling]})`,
      EXIT.SENSITIVITY_BLOCK,
      ctx.ceiling === "local_only"
        ? "it is marked do_not_learn — nothing lifts that, by design"
        : "run `sutra review` to grant an exposure, or run locally without SUTRA_HOSTED",
    );
  }

  if (!ctx.mode.json) {
    say(ctx.mode, c.bold(`# ${r.note.title}`), c.dim(`${r.note.relPath} · ${r.note.type} · ${TIER_DISPLAY[r.note.sensitivity]}`), "", r.note.body);
  }
  return EXIT.OK;
}

/** `sutra read <id> --section <s>` */
export function cmdRead(ctx: Ctx, args: ParsedArgs): ExitCode {
  const id = args.positional[0];
  const section = flagString(args, "section") ?? args.positional[1];
  if (!id || !section) {
    throw new SutraError("need a note and a section", EXIT.USAGE, 'sutra read <id> --section "Heading"');
  }

  const note = ctx.brain.getNote(id);
  if (note.status === "not_found") throw new SutraError(`no note matches "${id}"`, EXIT.NOT_FOUND);
  if (note.status === "withheld") {
    throw new SutraError(`"${id}" is withheld at the current ceiling`, EXIT.SENSITIVITY_BLOCK);
  }

  const sec = extractSection(note.note.body, section);
  emitJson(ctx.mode, sec);
  if (sec.status === "not_found") {
    if (!ctx.mode.json) {
      say(ctx.mode, c.dim(`no section "${section}". Headings in this note:`));
      for (const h of sec.headings) say(ctx.mode, `  ${"  ".repeat(h.level - 1)}${h.text}`);
    }
    throw new SutraError(`no section "${section}"`, EXIT.NOT_FOUND);
  }
  if (!ctx.mode.json) say(ctx.mode, sec.section);
  return EXIT.OK;
}

/**
 * `sutra gate` — THE TRUST DEMO.
 *
 * The one command that makes the product's central claim checkable rather than
 * merely asserted. It prints what is visible, what is withheld, and why.
 */
export function cmdGate(ctx: Ctx, _args: ParsedArgs): ExitCode {
  const g = ctx.brain.gateInspect(8);
  emitJson(ctx.mode, { ...g, ceiling_reason: ctx.ceilingReason });

  if (!ctx.mode.json) {
    heading(ctx.mode, `Ceiling: ${g.ceiling_display}`);
    say(ctx.mode, c.dim(`  ${ctx.ceilingReason}`), "");
    say(ctx.mode, `  ${c.green("Visible")}:  ${c.bold(String(g.visible))} of ${g.scanned} notes`);
    say(
      ctx.mode,
      `  ${c.yellow("Withheld")}: private ${c.bold(String(g.withheld_by_tier.private))} · ` +
      `secret ${c.bold(String(g.withheld_by_tier.secret))} · ` +
      `do_not_learn ${c.bold(String(g.withheld_by_tier.do_not_learn))}`,
    );
    if (g.sample.length) {
      heading(ctx.mode, "A sample of what IS visible");
      for (const s of g.sample) say(ctx.mode, c.dim(`  · ${s}`));
    }
    say(
      ctx.mode, "",
      c.dim("  Secret content and anything marked do_not_learn never reaches any model —"),
      c.dim("  not under an override, not under a flag, not at any ceiling."),
    );
  }
  return EXIT.OK;
}

/** `sutra status` — what ran, what was skipped, and why. */
export function cmdStatus(ctx: Ctx, _args: ParsedArgs): ExitCode {
  const inbox = ctx.vc.inboxCounts();
  const last = ctx.vc.lastRun();
  const contra = ctx.vc.contradictions();
  const gate = ctx.brain.gateInspect(0);

  const payload = {
    vault: ctx.cfg.vaultRoot.path,
    vault_origin: ctx.cfg.vaultRoot.origin,
    ceiling: gate.ceiling,
    notes: { scanned: gate.scanned, visible: gate.visible, withheld: gate.withheld_by_tier },
    inbox,
    last_run: last.iso,
    contradictions: contra.total,
    warnings: ctx.cfg.warnings,
  };
  emitJson(ctx.mode, payload);

  if (!ctx.mode.json) {
    heading(ctx.mode, "Vault");
    table(ctx.mode, [
      ["path", `${ctx.cfg.vaultRoot.path} ${c.dim(`(from ${ctx.cfg.vaultRoot.origin})`)}`],
      ["notes", `${gate.scanned} scanned · ${gate.visible} visible at ${gate.ceiling_display}`],
      ["withheld", `private ${gate.withheld_by_tier.private} · secret ${gate.withheld_by_tier.secret} · do_not_learn ${gate.withheld_by_tier.do_not_learn}`],
      ["inbox", `${inbox.vault_inbox} note(s) · ${inbox.raw_inbox} raw · ${inbox.review_queue} in review`],
      ["last run", last.iso ?? c.yellow("never")],
      ["contradictions", String(contra.total)],
    ]);
    if (ctx.cfg.warnings.length) {
      heading(ctx.mode, "Warnings");
      for (const w of ctx.cfg.warnings) say(ctx.mode, c.yellow("  ! ") + w);
    }
  }
  return EXIT.OK;
}
