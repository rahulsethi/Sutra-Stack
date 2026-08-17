// SPDX-License-Identifier: Apache-2.0
/**
 * `sutra init` — THE GUIDED ONBOARDING.
 *
 * 00-MASTER-BUILD-BRIEF.md §6 calls this "the only genuinely new UX" in the
 * whole extraction, and §10.2 makes it a release gate: *fresh clone → prove-it,
 * unaided, on Windows and macOS/Linux, in ≤15 minutes, from the README.*
 *
 * Four properties, each of which the spec names explicitly:
 *
 *   **Interactive** — it asks, in plain words, and explains each trade-off in
 *   one sentence at the moment the choice is made.
 *
 *   **Idempotent** — running it twice is safe. Every step checks before it
 *   writes and reports "already done" rather than clobbering.
 *
 *   **Resumable** — "each step records a blocker on failure and LATER SAFE
 *   STEPS STILL RUN". A missing `uv` must not prevent identity being written.
 *   That is why `runStep` collects blockers instead of throwing.
 *
 *   **Agent-drivable** — `--yes` takes every default, so an LLM pointed at the
 *   repo can run the whole thing and report what it could not do.
 *
 * ── THE COLD-START PROBLEM IS ANSWERED HERE, NOT DEFERRED ──────────────────
 * "A brand-new vault has nothing to answer FROM." Step 7 seeds the user's own
 * identity plus one real capture, so the first answer is genuinely grounded in
 * their material — and the no-model path degrades to the deterministic cited
 * context block rather than an error. A first run that only announces its own
 * limitations is not a product.
 */

import { createInterface, type Interface } from "node:readline";
import { existsSync, mkdirSync, writeFileSync, readFileSync, cpSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  loadConfig, VaultClient, Brain, ask, writeCapture, classify, loadPatternSet,
  TIER_DISPLAY, CONFIG_FILENAME, findPwsh, type Tier,
} from "@sutra/aatma-core";
import { EXIT, type ExitCode } from "../exit.js";
import { say, heading, check, emitJson, c, type OutputMode } from "../output.js";
import { flagBool, flagString, type ParsedArgs } from "../args.js";
import { checkPrereqs } from "./doctor.js";

interface StepResult {
  step: string;
  status: "done" | "already" | "blocked" | "skipped";
  detail: string;
  /** What the user must do themselves. Collected and reprinted at the end. */
  blocker?: string;
}

class Prompter {
  private rl: Interface | null = null;
  constructor(private readonly auto: boolean, private readonly mode: OutputMode) {}

  private get io(): Interface {
    this.rl ??= createInterface({ input: process.stdin, output: process.stdout });
    return this.rl;
  }

  async ask(question: string, fallback: string): Promise<string> {
    if (this.auto) {
      say(this.mode, c.dim(`  ${question} ${c.bold(fallback)} (--yes)`));
      return fallback;
    }
    const a = await new Promise<string>((res) => this.io.question(`  ${question} `, res));
    return a.trim() || fallback;
  }

  async confirm(question: string, fallback = true): Promise<boolean> {
    const hint = fallback ? "[Y/n]" : "[y/N]";
    const a = await this.ask(`${question} ${hint}`, fallback ? "y" : "n");
    return a.toLowerCase().startsWith("y");
  }

  close(): void {
    this.rl?.close();
  }
}

export async function cmdInit(args: ParsedArgs, mode: OutputMode): Promise<ExitCode> {
  const auto = flagBool(args, "yes");
  const p = new Prompter(auto, mode);
  const results: StepResult[] = [];
  const cfg = loadConfig();
  const installRoot = cfg.installRoot.path;

  const record = (r: StepResult): StepResult => {
    results.push(r);
    const status = r.status === "blocked" ? "fail" : r.status === "skipped" ? "warn" : "ok";
    check(mode, status, `${r.step} — ${r.detail}`);
    if (r.blocker) say(mode, c.yellow(`      → ${r.blocker}`));
    return r;
  };

  try {
    say(mode, "",
      c.bold("  Sutra") + c.dim(" — a governed knowledge substrate for your AI."),
      "",
      c.dim("  Your notes stay plain markdown in a git repo you own. Every note carries a"),
      c.dim("  sensitivity tier. A gate sits between those notes and every model, and the"),
      c.dim("  model cannot lift it."),
      "",
      c.dim("  Seven steps. You can stop at any point and re-run this safely."),
    );

    // ── 1 · doctor ────────────────────────────────────────────────────────
    heading(mode, "1 · Prerequisites");
    const prereqs = checkPrereqs();
    for (const f of prereqs) check(mode, f.status, f.label, f.detail);
    const hardFails = prereqs.filter((f) => f.status === "fail");
    record(
      hardFails.length
        ? {
            step: "doctor", status: "blocked",
            detail: `${hardFails.length} required tool(s) missing`,
            blocker: hardFails.map((f) => `install ${f.id}: ${f.remedy ?? "see docs"}`).join("; "),
          }
        : { step: "doctor", status: "done", detail: "all required tools present" },
    );
    // Deliberately NOT a return. Later steps still run — that is what "resumable"
    // means, and a missing optional tool must not block identity capture.

    // ── 2 · vault ─────────────────────────────────────────────────────────
    heading(mode, "2 · Your vault");
    say(mode, c.dim("  A vault is a plain directory of markdown, version-controlled with git."),
             c.dim("  It is YOURS: Sutra points at it by path and never takes ownership of it."));

    const defaultVault = join(homedir(), "sutra-vault");
    const vaultPath = flagString(args, "vault") ?? (await p.ask(`Where should it live?  [${defaultVault}]`, defaultVault));

    const vaultExisted = existsSync(join(vaultPath, "vault"));
    if (vaultExisted) {
      record({ step: "vault", status: "already", detail: `${vaultPath} already exists — left untouched` });
    } else {
      const template = join(installRoot, "vault-template");
      if (!existsSync(template)) {
        record({ step: "vault", status: "blocked", detail: "vault-template/ not found in this install", blocker: `expected ${template}` });
      } else {
        mkdirSync(vaultPath, { recursive: true });
        cpSync(template, vaultPath, { recursive: true });
        const git = spawnSync("git", ["init", "-q"], { cwd: vaultPath, encoding: "utf8", shell: process.platform === "win32" });
        if (git.status === 0) {
          spawnSync("git", ["add", "-A"], { cwd: vaultPath, shell: process.platform === "win32" });
          spawnSync("git", ["commit", "-q", "-m", "vault: skeleton from sutra init"], { cwd: vaultPath, shell: process.platform === "win32" });
        }
        record({ step: "vault", status: "done", detail: `created at ${vaultPath}, git-initialised, 0 notes` });
      }
    }
    process.env["SUTRA_VAULT"] = vaultPath;

    // Write the config so every later step and every later invocation finds it.
    const configPath = join(vaultPath, CONFIG_FILENAME);
    if (!existsSync(configPath)) {
      writeFileSync(configPath, JSON.stringify({
        vault_root: ".",
        install_root: installRoot,
        skills_root: join(installRoot, "skills"),
        provider: { review_required: "local", hosted_allowed: "hosted" },
      }, null, 2) + "\n", "utf8");
    }
    process.env["SUTRA_CONFIG"] = configPath;

    // ── 3 · tiers ─────────────────────────────────────────────────────────
    heading(mode, "3 · The three tiers");
    say(mode,
      `  ${c.green("public")}   your assistant may see it, including a cloud model.`,
      `  ${c.yellow("private")}  the default. Stays local unless you release one note, once.`,
      `  ${c.red("secret")}   never reaches ANY model. Credentials, finance, health, ID.`,
      "",
      c.dim("  Anything unlabelled is private. That is deliberate: an unlabelled note is not"),
      c.dim("  one you decided was safe to share — it is one nobody has looked at yet."),
      "",
    );

    // The behavioural proof, run in front of the user. §6 step 3's verify:
    // "a secret-shaped test note auto-classifies local_only".
    try {
      // The probe comes from the pattern set's own fixtures — see the same
      // reasoning in `doctor.ts`. A literal typed here would be a second mental
      // model of the rules, free to drift from the rules actually loaded.
      const patterns = loadPatternSet(installRoot);
      const probe = patterns.rules.find((r) => r.band === "definite");
      const planted = classify({ text: `credential = ${probe?.fixture ?? ""}` }, patterns);
      const ordinary = classify({ text: "Notes on guitar practice: work on the E-shape barre." }, patterns);
      const correct = planted.tier === "local_only" && ordinary.tier === "review_required";
      record(
        correct
          ? { step: "tiers", status: "done", detail: "verified live: a credential-shaped string floors to secret; an ordinary note does not" }
          : { step: "tiers", status: "blocked", detail: "THE CLASSIFIER DID NOT BEHAVE AS SPECIFIED", blocker: "run `sutra doctor` — do not use this install until the gate section is green" },
      );
      if (correct) {
        say(mode, c.dim(`      a ${probe?.provider ?? "credential"}-shaped string → ${c.bold(TIER_DISPLAY[planted.tier])}`));
        say(mode, c.dim(`      "Notes on guitar practice…"        → ${TIER_DISPLAY[ordinary.tier]}`));
      }
    } catch (e) {
      record({ step: "tiers", status: "blocked", detail: "could not load the pattern set", blocker: e instanceof Error ? e.message : String(e) });
    }

    // ── 4 · identity ──────────────────────────────────────────────────────
    heading(mode, "4 · Who you are");
    say(mode, c.dim("  Your assistant answers better when it knows who it is answering for."),
             c.dim("  Three short files, in your words. You can edit them later — and skip now."));

    const identityDir = join(vaultPath, "vault", "11-identity");
    const principalPath = join(identityDir, "principal.md");

    if (existsSync(principalPath) && readFileSync(principalPath, "utf8").length > 200) {
      record({ step: "identity", status: "already", detail: "identity notes already written — left untouched" });
    } else if (!auto && (await p.confirm("Write them now?", true))) {
      const who = await p.ask("In one line, who are you (role, what you build)?", "");
      const doing = await p.ask("What are you trying to do over the next year?", "");
      const voice = await p.ask("How should your assistant sound? (e.g. direct, no preamble)", "direct, concise, no preamble");

      mkdirSync(identityDir, { recursive: true });
      writeIdentity(principalPath, "Principal", "review_required", who || "_(not yet written — `sutra ask` works better once this is filled in)_");
      writeIdentity(join(identityDir, "telos.md"), "TELOS", "review_required", doing || "_(not yet written)_");
      writeIdentity(join(identityDir, "persona.md"), "Assistant persona", "hosted_allowed", voice);
      record({
        step: "identity", status: "done",
        detail: `3 files under vault/11-identity — principal and telos are ${c.yellow("private")}, persona is ${c.green("public")}`,
      });
      say(mode, c.dim("      The persona is public because how your assistant SOUNDS is not sensitive."),
                c.dim("      Who you are and what you are doing default to private."));
    } else {
      record({ step: "identity", status: "skipped", detail: "skipped — `sutra ask` will work, with less context" });
    }

    // ── 5 · harness ───────────────────────────────────────────────────────
    heading(mode, "5 · Your AI harness");
    const detected = detectHarnesses();
    if (!detected.length) {
      record({
        step: "harness", status: "skipped",
        detail: "no harness detected — Sutra works fine as a plain CLI (shape (a))",
        blocker: "install Claude Code, Hermes or Codex, then run `sutra wire <harness>`",
      });
    } else {
      say(mode, c.dim(`  Found: ${detected.join(", ")}`), "");
      say(mode,
        `  ${c.bold("public")}  the assistant sees only public notes. Safe with any cloud model.`,
        `  ${c.bold("private")} it also sees private notes. Only if you accept a cloud provider processing them.`,
        `  ${c.bold("secret")}  everything. Only defensible when the model runs on THIS machine.`,
        "");
      const ceiling = await p.ask(`Ceiling for these? [public]`, "public");
      record({
        step: "harness", status: "done",
        detail: `run: ${detected.map((h) => `sutra wire ${h} --exposure ${ceiling}`).join("  ·  ")}`,
      });
      say(mode, c.dim("      init prints the wiring command rather than running it — registering an MCP"),
                c.dim("      server edits YOUR harness config, and you should see the exact command first."));
    }

    // ── 6 · schedule ──────────────────────────────────────────────────────
    heading(mode, "6 · Keeping it fresh");
    record({
      step: "schedule", status: "skipped",
      detail: "run `sutra schedule install` to see the exact OS commands",
      blocker: "ONE scheduler per cadence (§9.5) — a job registered in both a harness cron AND the OS scheduler double-runs, and two runs writing one derived file corrupt it",
    });

    // ── 7 · PROVE IT ──────────────────────────────────────────────────────
    heading(mode, "7 · Prove it");
    say(mode, c.dim("  Capture something, ask about it, and watch the gate withhold a secret."), "");

    // Seed the cold start: a real capture, in the user's own words.
    //
    // Note what is NOT passed here: a `sensitivity`. A capture is floored to
    // PRIVATE and cannot be public — that is invariant 6, and it is the whole
    // reason the write path is safe to expose to a model. Asking for `public`
    // would be clamped up anyway, and writing that here would teach a reader of
    // this file the wrong thing about the floor.
    const seedText = auto
      ? "Sutra keeps my notes as plain markdown in a git repo I own. Every note carries a sensitivity tier, and a gate sits between those notes and every model."
      : await p.ask("Type one thing worth remembering:", "Sutra keeps my notes as plain markdown in a git repo I own.");

    writeCapture(vaultPath, { text: seedText, title: "First capture", source: "sutra init" });

    // And a secret-shaped one, so the withholding is DEMONSTRATED, not described.
    writeCapture(vaultPath, {
      text: "Production database password: hunter2-not-a-real-password. This note exists to prove the gate holds.",
      title: "Secret smoke test",
      sensitivity: "secret",
      source: "sutra init",
    });

    const vc = new VaultClient(vaultPath);
    const query = seedText.split(/\s+/).slice(0, 6).join(" ");

    // ── The two views. This contrast IS the product. ──────────────────────
    //
    // A demo that showed a public note being visible to a public ceiling would
    // prove nothing. What has to be shown is that the SAME QUESTION, asked from
    // the user's own terminal and from a cloud assistant, returns different
    // material — and that the difference is exactly what they marked.
    const local = new Brain(vc, "local_only", cfg.walkRoots);
    const hosted = new Brain(vc, "hosted_allowed", cfg.walkRoots);

    const yours = ask(vaultPath, installRoot, local, query, { k: 3 });
    const theirs = ask(vaultPath, installRoot, hosted, query, { k: 3 });
    const gateLocal = local.gateInspect(0);
    const gateHosted = hosted.gateInspect(0);

    say(mode, "");
    say(mode, c.bold("  ① What YOU see (your terminal, no model in the loop):"));
    say(mode, c.dim("  " + yours.context_block.split("\n").slice(0, 8).join("\n  ")));
    say(mode, `  ${c.green("visible")} ${gateLocal.visible}  ·  ${c.dim("cited sources")} ${yours.sources.length}`);

    say(mode, "");
    say(mode, c.bold("  ② What a CLOUD ASSISTANT sees (public ceiling):"));
    say(mode, `  ${c.green("visible")} ${gateHosted.visible}  ·  ${c.yellow("withheld")} ` +
      `secret ${gateHosted.withheld_by_tier.secret}, private ${gateHosted.withheld_by_tier.private}`);
    say(mode, c.dim(`  cited sources ${theirs.sources.length}`));

    // The three things that must be true for the product's claim to hold.
    const grounded = yours.sources.length > 0;                      // you get an answer
    const secretWithheld = gateHosted.withheld_by_tier.secret >= 1;  // the secret never leaves
    const gateBites = gateHosted.visible < gateLocal.visible;        // the ceiling actually differs

    say(mode, "");
    say(mode, c.dim("  Your capture landed at ") + c.bold("private") + c.dim(" — a capture is floored, and cannot be"));
    say(mode, c.dim("  made public by anything, including your assistant. That is why the write path"));
    say(mode, c.dim("  is safe to hand a model at all."));

    record(
      grounded && secretWithheld && gateBites
        ? {
            step: "prove-it", status: "done",
            detail: `you see ${gateLocal.visible} notes and get a cited answer; a cloud assistant sees ${gateHosted.visible} and the secret is withheld`,
          }
        : {
            step: "prove-it", status: "blocked",
            detail: `grounded=${grounded} secret-withheld=${secretWithheld} ceiling-differs=${gateBites}`,
            blocker: "run `sutra doctor` — the gate section is what matters",
          },
    );

    // ── Summary ───────────────────────────────────────────────────────────
    const blockers = results.filter((r) => r.status === "blocked");
    const skipped = results.filter((r) => r.status === "skipped");

    emitJson(mode, { vault: vaultPath, results, ok: blockers.length === 0 });

    say(mode, "");
    if (blockers.length === 0) {
      say(mode, c.green(c.bold("  Onboarding complete.")));
      say(mode, "",
        c.dim("  Your vault:      ") + vaultPath,
        c.dim("  Try:             ") + "sutra ask \"what do I know about sutra?\"",
        c.dim("  The trust demo:  ") + "sutra gate",
        c.dim("  Health:          ") + "sutra doctor",
      );
    } else {
      say(mode, c.yellow(`  ${blockers.length} step(s) need you:`));
      for (const b of blockers) say(mode, `    · ${b.step}: ${b.blocker ?? b.detail}`);
      say(mode, "", c.dim("  Everything else was set up. Re-run `sutra init` after fixing these — it is idempotent."));
    }
    if (skipped.length) {
      say(mode, "", c.dim(`  Skipped (optional): ${skipped.map((s) => s.step).join(", ")}`));
    }

    return blockers.length ? EXIT.ERROR : EXIT.OK;
  } finally {
    p.close();
  }
}

function writeIdentity(path: string, title: string, tier: Tier, body: string): void {
  if (existsSync(path) && readFileSync(path, "utf8").length > 200) return; // idempotent
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, [
    "---",
    "type: Identity",
    "status: active",
    `sensitivity: ${TIER_DISPLAY[tier]}`,
    `created: ${new Date().toISOString().slice(0, 10)}`,
    "---",
    "",
    `# ${title}`,
    "",
    body,
    "",
  ].join("\n"), "utf8");
}

/** Detect harnesses by their config, not by a binary on PATH. */
function detectHarnesses(): string[] {
  const found: string[] = [];
  const home = homedir();
  if (existsSync(join(home, ".claude.json")) || existsSync(join(home, ".claude"))) found.push("claude");
  if (existsSync(join(home, ".hermes"))) found.push("hermes");
  if (existsSync(join(home, ".codex"))) found.push("codex");
  return found;
}
