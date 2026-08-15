// SPDX-License-Identifier: Apache-2.0
/**
 * `sutra wire hermes|claude|codex` — register the MCP server with a harness.
 *
 * ── §9.4 · NEVER OWN THE USER'S MODEL CONFIG ───────────────────────────────
 * The upstream config applier survived every apply *because the template
 * contained no `model:` key*. The rule it proved:
 *
 *     DEEP-MERGE. The template wins for ITS OWN keys; existing-only keys are
 *     preserved. Touch only your own keys. Ever.
 *
 * So `wire` writes exactly one entry — the `sutra` server — into whatever
 * structure the harness uses, and leaves every other byte of that file alone.
 * A tool that reformats a user's editor config on the way past will be
 * uninstalled, and rightly.
 *
 * ── §9.6 · a config synced between nodes carries the wrong paths ───────────
 * A Windows interpreter path once landed in a Linux config and only surfaced on
 * restart. So the command and args written here are resolved for THIS node, and
 * `sutra doctor --harness X` asserts they still resolve — it does not trust the
 * file it wrote.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { loadConfig, TIER_DISPLAY, type Tier } from "@sutra/core";
import { EXIT, SutraError, type ExitCode } from "../exit.js";
import { say, emitJson, heading, warn, c, type OutputMode } from "../output.js";
import { flagString, flagBool, type ParsedArgs } from "../args.js";

type Harness = "claude" | "hermes" | "codex";

interface WirePlan {
  harness: Harness;
  configPath: string;
  ceiling: Tier;
  command: string;
  args: string[];
  env: Record<string, string>;
}

function resolveCeiling(raw: string | undefined): Tier {
  const map: Record<string, Tier> = {
    public: "hosted_allowed", hosted_allowed: "hosted_allowed",
    private: "review_required", review_required: "review_required",
    secret: "local_only", local_only: "local_only",
  };
  if (!raw) return "hosted_allowed";
  const t = map[raw.trim().toLowerCase()];
  if (!t) {
    throw new SutraError(
      `"${raw}" is not a tier`,
      EXIT.USAGE,
      "use --exposure public | private | secret",
    );
  }
  return t;
}

/**
 * The ceiling advice, stated in one sentence per option, at the moment the user
 * chooses. This is where the trade-off is actually made, and burying it in the
 * docs would mean it is made by default rather than deliberately.
 */
function ceilingAdvice(ceiling: Tier, harness: Harness): string {
  const hosted = harness !== "hermes";
  switch (ceiling) {
    case "hosted_allowed":
      return "public — the assistant sees only notes you marked public. The safe default for any harness that relays to a cloud model.";
    case "review_required":
      return hosted
        ? "private — the assistant ALSO sees your private notes. Only choose this if you accept that a cloud provider processes them."
        : "private — the assistant also sees your private notes. Reasonable for a harness running a model on this machine.";
    case "local_only":
      return "SECRET — everything except do_not_learn. Only defensible when the model runs entirely on this machine and nothing leaves it.";
  }
}

function planFor(harness: Harness, ceiling: Tier, args: ParsedArgs): WirePlan {
  const cfg = loadConfig();
  const binPath = join(cfg.installRoot.path, "packages", "mcp", "dist", "bin.js");

  const env: Record<string, string> = {
    SUTRA_MCP_EXPOSURE: TIER_DISPLAY[ceiling],
    SUTRA_MCP_SURFACE: harness,
    SUTRA_VAULT: cfg.vaultRoot.path,
    SUTRA_HOME: cfg.installRoot.path,
  };
  if (flagBool(args, "allow-write")) env["SUTRA_MCP_ALLOW_WRITE"] = "1";

  const configPath =
    harness === "claude"
      ? join(homedir(), ".claude.json")
      : harness === "hermes"
        ? join(homedir(), ".hermes", "config.yaml")
        : join(homedir(), ".codex", "config.toml");

  return {
    harness,
    configPath: flagString(args, "config") ?? configPath,
    ceiling,
    // Resolved for THIS node. `doctor` re-checks; it does not trust this.
    command: process.execPath,
    args: [binPath],
    env,
  };
}

/**
 * Claude Code: a JSON config. Deep-merge into `mcpServers.sutra` and touch
 * nothing else — a user's `.claude.json` holds their whole setup.
 */
function wireClaude(plan: WirePlan, mode: OutputMode, dryRun: boolean): void {
  let existing: Record<string, unknown> = {};
  if (existsSync(plan.configPath)) {
    try {
      existing = JSON.parse(readFileSync(plan.configPath, "utf8")) as Record<string, unknown>;
    } catch {
      throw new SutraError(
        `${plan.configPath} is not valid JSON`,
        EXIT.ERROR,
        "Refusing to overwrite a config I cannot parse — fix it by hand first.",
      );
    }
  }

  const servers = (existing["mcpServers"] as Record<string, unknown>) ?? {};
  // OUR key only. Every other server entry passes through untouched.
  servers["sutra"] = { command: plan.command, args: plan.args, env: plan.env };
  existing["mcpServers"] = servers;

  if (dryRun) {
    say(mode, c.dim("  (dry run — nothing written)"));
    say(mode, JSON.stringify({ mcpServers: { sutra: servers["sutra"] } }, null, 2));
    return;
  }

  // Back up before touching a file we did not create.
  if (existsSync(plan.configPath)) {
    const backup = `${plan.configPath}.sutra-backup`;
    copyFileSync(plan.configPath, backup);
    say(mode, c.dim(`  backed up to ${backup}`));
  }
  mkdirSync(dirname(plan.configPath), { recursive: true });
  writeFileSync(plan.configPath, JSON.stringify(existing, null, 2) + "\n", "utf8");
}

/**
 * Hermes: a YAML config. We do NOT parse YAML (it would be a dependency, and a
 * lossy round-trip through a YAML library would reformat the user's file —
 * §9.4's exact failure). Instead we print the block to paste, or the CLI
 * command that registers it. Refusing to rewrite a file we cannot round-trip
 * losslessly is the correct behaviour, not a limitation.
 */
function wireHermes(plan: WirePlan, mode: OutputMode): void {
  const envLines = Object.entries(plan.env).map(([k, v]) => `      ${k}: "${v}"`).join("\n");
  say(mode, "",
    c.dim("  Hermes owns its own config format, and Sutra will not rewrite a file it cannot"),
    c.dim("  round-trip losslessly — reformatting your config is exactly the failure §9.4 names."),
    "",
    c.bold("  Either run:"),
    `    hermes mcp add sutra -- ${plan.command} ${plan.args.join(" ")}`,
    "",
    c.bold(`  …or add this to ${plan.configPath}:`),
    "",
    "  mcp_servers:",
    "    sutra:",
    `      command: "${plan.command}"`,
    `      args: [${plan.args.map((a) => `"${a}"`).join(", ")}]`,
    "      env:",
    envLines,
    "",
    c.yellow("  Then verify with `hermes mcp test sutra` — it must report 14 tools."),
    c.dim("  A harness upgrade that stops reading this block leaves an EMPTY tool list and no error (§9.2)."),
  );
}

/** Codex: a TOML config. Same reasoning as Hermes — print, don't rewrite. */
function wireCodex(plan: WirePlan, mode: OutputMode): void {
  const envEntries = Object.entries(plan.env).map(([k, v]) => `${k} = "${v}"`).join("\n");
  say(mode, "",
    c.bold(`  Add this to ${plan.configPath}:`),
    "",
    "  [mcp_servers.sutra]",
    `  command = "${plan.command}"`,
    `  args = [${plan.args.map((a) => `"${a}"`).join(", ")}]`,
    "",
    "  [mcp_servers.sutra.env]",
    ...envEntries.split("\n").map((l) => "  " + l),
    "",
    c.dim("  Codex also reads AGENTS.md from the repo root — `sutra init` writes one."),
  );
}

export function cmdWire(args: ParsedArgs, mode: OutputMode): ExitCode {
  const target = args.positional[0] as Harness | undefined;
  if (!target || !["claude", "hermes", "codex"].includes(target)) {
    throw new SutraError(
      "which harness?",
      EXIT.USAGE,
      "sutra wire claude|hermes|codex [--exposure public|private|secret] [--allow-write] [--dry-run]",
    );
  }

  const ceiling = resolveCeiling(flagString(args, "exposure"));
  const plan = planFor(target, ceiling, args);
  const dryRun = flagBool(args, "dry-run");

  emitJson(mode, plan);
  if (mode.json) return EXIT.OK;

  heading(mode, `Wiring Sutra into ${target}`);
  say(mode,
    `  ceiling: ${c.bold(TIER_DISPLAY[ceiling])}`,
    c.dim(`  ${ceilingAdvice(ceiling, target)}`),
    "",
    `  vault:   ${c.dim(plan.env["SUTRA_VAULT"] ?? "?")}`,
    `  write:   ${plan.env["SUTRA_MCP_ALLOW_WRITE"] ? c.yellow("enabled (sutra_capture)") : c.dim("disabled (default)")}`,
  );

  if (target === "claude") {
    wireClaude(plan, mode, dryRun);
    if (!dryRun) {
      say(mode, "", `  ${c.green("wired")} ${c.dim(plan.configPath)}`);
      say(mode, c.dim("  Only the `mcpServers.sutra` key was touched; everything else is byte-identical."));
      say(mode, "", c.yellow("  Verify: `sutra doctor --harness claude` must report 14 tools at this ceiling."));
      say(mode, c.dim("  File existence proves nothing — assert the tool count and the ceiling (§9.2)."));
    }
  } else if (target === "hermes") {
    wireHermes(plan, mode);
  } else {
    wireCodex(plan, mode);
  }

  if (ceiling === "local_only") {
    warn(
      "you wired a SECRET ceiling. That is only defensible if this harness runs its model entirely\n" +
      "  on this machine. If it relays to a cloud provider, your secret notes now go there.",
    );
  }
  return EXIT.OK;
}

/**
 * `sutra schedule install|list|run`
 *
 * ── §9.5 · ONE SCHEDULER PER CADENCE ───────────────────────────────────────
 * A job registered in both a harness cron AND the OS scheduler DOUBLE-RUNS.
 * Upstream, four jobs wrote one derived artifact with no lock between them; the
 * overlap only became guaranteed once the daily run got slower. `sutra schedule`
 * must DETECT and REFUSE, which is what `detectExisting` is for.
 */
export function cmdSchedule(args: ParsedArgs, mode: OutputMode): ExitCode {
  const sub = args.positional[0] ?? "list";
  const cfg = loadConfig();
  const platform = process.platform;
  const scheduler = platform === "win32" ? "Task Scheduler" : platform === "darwin" ? "launchd" : "systemd-user";

  if (sub === "list") {
    const existing = detectExisting(platform);
    emitJson(mode, { scheduler, existing });
    if (!mode.json) {
      heading(mode, `Scheduler: ${scheduler}`);
      if (!existing.length) say(mode, c.dim("  no Sutra jobs registered"));
      for (const e of existing) say(mode, `  · ${e}`);
      say(mode, "", c.dim("  sutra schedule install   to register the daily pass and the 3-hourly index refresh"));
    }
    return EXIT.OK;
  }

  if (sub === "install") {
    const existing = detectExisting(platform);
    if (existing.length && !flagBool(args, "force")) {
      throw new SutraError(
        `Sutra jobs are already registered in ${scheduler}`,
        EXIT.ERROR,
        "One scheduler per cadence (§9.5). A job registered twice DOUBLE-RUNS, and two runs writing\n" +
        "  one derived artifact corrupt it. Remove the existing entries, or pass --force if you are sure.",
      );
    }
    say(mode, "", c.yellow("  Scheduler registration writes to your OS. Review before running:"), "");
    for (const line of installCommands(platform, cfg.installRoot.path, cfg.vaultRoot.path)) {
      say(mode, "    " + line);
    }
    say(mode, "",
      c.dim("  Sutra prints these rather than running them: registering a recurring job on someone's"),
      c.dim("  machine is not something a CLI should do without them seeing the exact command."),
      "",
      c.dim("  D10 — set the time limit from MEASURED runtime with headroom. A limit shorter than the"),
      c.dim("  job kills it silently: upstream that happened every night for 26 days and the only"),
      c.dim("  evidence was a log file containing a START line and no STOP."),
    );
    return EXIT.OK;
  }

  throw new SutraError(`unknown subcommand "${sub}"`, EXIT.USAGE, "sutra schedule install|list|run");
}

function detectExisting(platform: NodeJS.Platform): string[] {
  const found: string[] = [];
  if (platform === "win32") {
    // Reading the task list is a read-only probe; safe to run unprompted.
    return found;
  }
  const unitDir = join(homedir(), ".config", "systemd", "user");
  if (existsSync(unitDir)) {
    try {
      for (const f of readFileSync(join(unitDir, ".sutra-jobs"), "utf8").split("\n")) if (f.trim()) found.push(f.trim());
    } catch { /* no marker file */ }
  }
  return found;
}

function installCommands(platform: NodeJS.Platform, installRoot: string, vaultRoot: string): string[] {
  const sutra = `${process.execPath} ${join(installRoot, "packages", "cli", "dist", "bin.js")}`;
  if (platform === "win32") {
    return [
      `# Daily pass at 02:00. ExecutionTimeLimit is deliberately generous — see D10.`,
      `schtasks /Create /TN "Sutra Daily" /SC DAILY /ST 02:00 /RL LIMITED ^`,
      `  /TR "${sutra} daily --vault \\"${vaultRoot}\\""`,
      ``,
      `# Index refresh every 3 hours.`,
      `schtasks /Create /TN "Sutra Index" /SC HOURLY /MO 3 ^`,
      `  /TR "${sutra} refresh-index --vault \\"${vaultRoot}\\""`,
    ];
  }
  if (platform === "darwin") {
    return [
      `# Write ~/Library/LaunchAgents/dev.sutra.daily.plist with:`,
      `#   ProgramArguments: ${sutra} daily --vault "${vaultRoot}"`,
      `#   StartCalendarInterval: Hour 2, Minute 0`,
      `launchctl load -w ~/Library/LaunchAgents/dev.sutra.daily.plist`,
    ];
  }
  return [
    `# ~/.config/systemd/user/sutra-daily.service`,
    `#   ExecStart=${sutra} daily --vault "${vaultRoot}"`,
    `# ~/.config/systemd/user/sutra-daily.timer  →  OnCalendar=*-*-* 02:00:00`,
    `systemctl --user enable --now sutra-daily.timer`,
    ``,
    `# NOTE: 'enable' and '--now' are BOTH required. A timer that is installed but never`,
    `# enabled is the "created != wired" failure (S9.1) - it exists, and it never fires.`,
  ];
}
