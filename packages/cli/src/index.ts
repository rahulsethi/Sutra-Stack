// SPDX-License-Identifier: Apache-2.0
/**
 * The `sutra` command router.
 *
 * Every read command supports `--json`. Exit codes are lifted verbatim from the
 * upstream executor and are a governance signal, not a convention — see
 * `exit.ts`.
 */

import { listSkills, getSkill, runPwsh, flatArgs } from "@sutra/aatma-core";
import { parseArgs, flagBool, flagString, type ParsedArgs } from "./args.js";
import { EXIT, EXIT_MEANING, SutraError, type ExitCode } from "./exit.js";
import { say, emitJson, heading, table, fail, c, type OutputMode } from "./output.js";
import { makeContext, cmdAsk, cmdSearch, cmdGet, cmdRead, cmdGate, cmdStatus, type Ctx } from "./commands/read.js";
import { cmdCapture, cmdReveal, cmdReview } from "./commands/write.js";
import { cmdDoctor } from "./commands/doctor.js";
import { cmdInit } from "./commands/init.js";
import { cmdWire, cmdSchedule } from "./commands/wire.js";
import { runPipelineVerb, cmdRescan, cmdLogs } from "./commands/pipeline.js";
import { cmdProvider } from "./commands/provider.js";

const VERSION = "1.0.0";

const HELP = `
${c.bold("sutra")} — a governed knowledge substrate for your AI.

  Your notes stay plain markdown in a git repo you own. Every note carries a
  sensitivity tier. A gate sits between those notes and every model, and the
  model cannot lift it.

${c.bold("Getting started")}
  sutra init                        guided setup. Idempotent; safe to re-run.
  sutra doctor [--harness X]        prerequisites, wiring, and the gate self-test.

${c.bold("Reading")}
  sutra ask "<question>"            a cited answer from your own notes.
  sutra search <query>              keyword search. --hybrid, --semantic.
  sutra get <id>                    one note, in full.
  sutra read <id> --section "<s>"   one section of one note.
  sutra gate                        ${c.dim("what can your AI actually see? The trust demo.")}
  sutra status                      vault and pipeline health.

${c.bold("Writing")}
  sutra capture "<text>"            save to the inbox. --tier private|secret.
  sutra review [--resolve <note>]   grant a time-boxed exposure for ONE note.
  sutra reveal <id>                 break-glass: render a secret note, once, audited.

${c.bold("The pipeline")}
  sutra ingest | daily | refresh-index | hygiene | backup
  sutra graph export | sutra publish llms
  sutra rescan [--apply]            re-classify under the ACTIVE pattern set.
  sutra logs [--since N]

${c.bold("Harnesses and scheduling")}
  sutra wire claude|hermes|codex [--exposure public|private|secret]
  sutra schedule install|list
  sutra provider list|add|key <id>|test <id>    bring your own model

${c.bold("Skills")}
  sutra skills list | sutra run <id> [-- args]

${c.bold("Global flags")}
  --json     machine-readable. stdout is JSON ONLY; notes go to stderr.
  --vault P  use this vault.        --config P  use this config file.
  --quiet    suppress human output. --help, --version

${c.dim("Exit codes are a governance signal: `sutra help exit-codes`.")}
`.trim();

export async function run(argv: readonly string[]): Promise<ExitCode> {
  const args = parseArgs(argv);
  const mode: OutputMode = { json: flagBool(args, "json"), quiet: flagBool(args, "quiet") };

  if (flagBool(args, "version")) {
    emitJson(mode, { version: VERSION });
    say(mode, VERSION);
    return EXIT.OK;
  }

  const verb = args.command.join(" ");
  if (!verb || flagBool(args, "help") || verb === "help") {
    if (args.positional[0] === "exit-codes" || args.command[1] === "exit-codes") {
      emitJson(mode, EXIT_MEANING);
      heading(mode, "Exit codes");
      table(mode, Object.entries(EXIT_MEANING).map(([k, v]) => [k, v]));
      say(mode, "",
        c.dim("  4, 5 and 7 are three DIFFERENT refusals with three different remedies."),
        c.dim("  A caller that cannot tell 4 from 7 will retry the one that can never succeed."));
      return EXIT.OK;
    }
    say(mode, HELP);
    return EXIT.OK;
  }

  try {
    // Commands that must NOT construct a vault context first — they are what
    // you run when there is no vault yet, or when the config is the problem.
    switch (verb) {
      case "init": return await cmdInit(args, mode);
      case "doctor": return cmdDoctor(args, mode);
      case "wire": return cmdWire(args, mode);
      case "schedule":
      case "schedule install":
      case "schedule list":
      case "schedule run":
        return cmdSchedule(withSub(args, "schedule"), mode);
      // BRING YOUR OWN MODEL. Grouped up here with the other setup verbs because
      // it, like them, must work BEFORE there is a usable vault to read.
      case "provider":
      case "provider list":
      case "provider add":
      case "provider key":
      case "provider test":
        return await cmdProvider(withSub(args, "provider"), mode);
    }

    const ctx = makeContext(args, mode);

    switch (verb) {
      case "ask": return cmdAsk(ctx, args);
      case "search": return cmdSearch(ctx, args);
      case "get": return cmdGet(ctx, args);
      case "read": return cmdRead(ctx, args);
      case "gate": return cmdGate(ctx, args);
      case "status": return cmdStatus(ctx, args);
      case "capture": return cmdCapture(ctx, args);
      case "reveal": return await cmdReveal(ctx, args);
      case "review": return await cmdReview(ctx, args);
      case "rescan": return cmdRescan(ctx, args);
      case "logs": return cmdLogs(ctx, args);

      case "ingest":
      case "daily":
      case "refresh-index":
      case "hygiene":
      case "backup":
      case "graph export":
      case "publish llms":
        return runPipelineVerb(ctx, verb, args);

      case "skills list": return cmdSkillsList(ctx, args);
      case "run": return cmdRunSkill(ctx, args);

      case "graph":
      case "publish":
      case "skills":
        throw new SutraError(
          `"${verb}" needs a subcommand`,
          EXIT.USAGE,
          verb === "graph" ? "sutra graph export" : verb === "publish" ? "sutra publish llms" : "sutra skills list",
        );

      default:
        throw new SutraError(`unknown command "${verb}"`, EXIT.NOT_FOUND, "sutra --help");
    }
  } catch (e) {
    if (e instanceof SutraError) {
      if (mode.json) emitJson(mode, { ok: false, error: e.message, remedy: e.remedy, exit_code: e.code });
      else fail(e.message, e.remedy);
      return e.code;
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (mode.json) emitJson(mode, { ok: false, error: msg, exit_code: EXIT.ERROR });
    else fail(msg);
    if (process.env["SUTRA_DEBUG"] && e instanceof Error) process.stderr.write((e.stack ?? "") + "\n");
    return EXIT.ERROR;
  }
}

/** Re-shape a two-word command so its subcommand is available as positional[0]. */
function withSub(args: ParsedArgs, head: string): ParsedArgs {
  if (args.command[0] !== head || args.command.length < 2) return args;
  return { ...args, command: [head], positional: [args.command[1]!, ...args.positional] };
}

function cmdSkillsList(ctx: Ctx, args: ParsedArgs): ExitCode {
  // `--all` includes the trusted half. Available locally ONLY; the MCP server
  // has no equivalent, by construction.
  const includeTrusted = flagBool(args, "all");
  const skills = listSkills(ctx.cfg.skillsRoot.path, { includeTrusted });
  emitJson(ctx.mode, { skills });
  if (!ctx.mode.json) {
    if (!skills.length) {
      say(ctx.mode, c.dim(`no skills under ${ctx.cfg.skillsRoot.path}`));
      return EXIT.OK;
    }
    table(ctx.mode, skills.map((s) => [
      `${s.trust === "trusted" ? c.yellow("trusted") : c.dim("public ")} ${s.id}`,
      s.description || c.dim("(no description)"),
    ]));
    if (!includeTrusted) say(ctx.mode, "", c.dim("  --all also lists trusted skills (never exposed to a harness)"));
  }
  return EXIT.OK;
}

/**
 * `sutra run <id> [-- args]`
 *
 * ── §9.7 · ONE FLAT INVOCATION ─────────────────────────────────────────────
 * A runner invoked as `<tool> -- run <skill> -- args` silently dropped the arguments across
 * THIRTEEN skills. Nothing errored. The skills ran with no input.
 *
 * So: one hop, `flatArgs` builds the vector explicitly, and `args.test.ts`
 * asserts that `-- --flag "value with spaces"` arrives intact.
 */
function cmdRunSkill(ctx: Ctx, args: ParsedArgs): ExitCode {
  const id = args.positional[0];
  if (!id) throw new SutraError("no skill id", EXIT.USAGE, "sutra run <id> [-- args]");

  const found = getSkill(ctx.cfg.skillsRoot.path, id, { includeTrusted: true });
  if (found.status === "not_found") {
    throw new SutraError(`no skill "${id}"`, EXIT.NOT_FOUND, "sutra skills list --all");
  }

  const runner = found.skill.relPath.replace(/SKILL\.md$/, "run.ps1");
  const runnerAbs = `${ctx.cfg.skillsRoot.path}/${runner}`;
  const res = runPwsh(runnerAbs, flatArgs(args.passthrough), { cwd: ctx.cfg.installRoot.path });

  emitJson(ctx.mode, { skill: id, exit_code: res.code, outcome: res.outcome, stdout: res.stdout, stderr: res.stderr });
  if (!ctx.mode.json) {
    if (res.stdout) say(ctx.mode, res.stdout.trimEnd());
    if (res.stderr) process.stderr.write(res.stderr);
  }

  if (res.outcome === "missing-script") {
    throw new SutraError(
      `skill "${id}" has no runnable step`,
      EXIT.NOT_FOUND,
      `It is documentation-only: read it with \`sutra get ${found.skill.relPath}\`.`,
    );
  }
  if (res.outcome === "missing-interpreter") throw new SutraError("pwsh not found", EXIT.RUNNER_MISSING, res.stderr.split("\n")[1]);
  return res.code === 0 ? EXIT.OK : (res.code as ExitCode);
}

export { parseArgs, EXIT };
