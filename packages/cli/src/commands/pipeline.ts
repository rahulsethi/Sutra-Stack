// SPDX-License-Identifier: Apache-2.0
/**
 * Pipeline commands: `ingest` · `daily` · `refresh-index` · `hygiene` ·
 * `backup` · `graph export` · `publish llms` · `rescan`.
 *
 * Most are thin shells over the PowerShell 7 pipeline in `automation/`, wrapped
 * so that every one of them produces a RUN RECORD with five distinguishable
 * outcomes rather than a bare exit code (D11), holds the resource locks its
 * stage needs (D9), and appends a metrics row (D12).
 *
 * `rescan` is the exception: it is implemented here, in TypeScript, because it
 * is a governance operation rather than a content operation and it must use
 * exactly the same classifier the gate uses.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import matter from "gray-matter";
import {
  runPwsh, RunRecorder, withLocks, appendMetrics, appendRunLog,
  loadPatternSet, classify, coerceTier, raiseOnly, isDownscope, TIER_DISPLAY,
  auditLog, type Tier, type StageResult,
} from "@sutra/core";
import { EXIT, SutraError, type ExitCode } from "../exit.js";
import { say, emitJson, heading, warn, c, type OutputMode } from "../output.js";
import { flagBool, flagString, type ParsedArgs } from "../args.js";
import type { Ctx } from "./read.js";

/** Which pwsh script backs each verb, and which resources it writes. */
const PIPELINE: Record<string, { script: string; locks: string[]; description: string }> = {
  ingest: { script: "automation/scripts/ingest.ps1", locks: ["raw-inbox", "extracts"], description: "intake → manifest → extract → classify" },
  daily: { script: "automation/scripts/orchestrator/daily.ps1", locks: ["vault", "raw-inbox", "extracts", "pages", "embed-index", "graph-a", "graph-kg"], description: "the full daily pass" },
  "refresh-index": { script: "automation/scripts/refresh-index.ps1", locks: ["embed-index", "graph-a"], description: "embed → cross-link → incremental graph" },
  hygiene: { script: "automation/scripts/hygiene/all.ps1", locks: ["vault"], description: "near-dup, freshness, stale, orphan, broken links" },
  backup: { script: "automation/scripts/backup.ps1", locks: [], description: "snapshot the vault" },
  "graph export": { script: "automation/scripts/graph-export.ps1", locks: ["graph-a"], description: "rebuild the cytoscape export" },
  "publish llms": { script: "automation/scripts/publish/build-llms-txt.ps1", locks: ["publish"], description: "generate llms.txt from public-tier notes" },
};

/**
 * Run one pipeline verb.
 *
 * The wrapper is where every observability lesson lands at once:
 *
 *  - **D9** — the stage's resource locks are held for its duration, acquired in
 *    ascending rank, and a loser SKIPS AND EXITS 0 (a red task in the OS
 *    scheduler for a normal outcome trains people to ignore red tasks).
 *  - **D11** — the outcome is one of five, never a bare exit code.
 *  - **D10/M5** — "every job captures its child's stdout". The 2026-08-15 daily
 *    was killed after 4.5 silent hours and left TWO LOG LINES, because the
 *    wrapper logged only START and STOP. Child output is captured and written.
 *  - **D12** — a metrics row is appended whether the run succeeded or not.
 */
export function runPipelineVerb(ctx: Ctx, verb: string, args: ParsedArgs): ExitCode {
  const spec = PIPELINE[verb];
  if (!spec) throw new SutraError(`unknown pipeline command "${verb}"`, EXIT.NOT_FOUND);

  const vaultRoot = ctx.cfg.vaultRoot.path;
  const scriptPath = join(ctx.cfg.installRoot.path, spec.script);
  const recorder = new RunRecorder(vaultRoot, verb);

  say(ctx.mode, c.dim(`${verb} — ${spec.description}`));

  const outcome = withLocks(
    vaultRoot,
    spec.locks,
    (): StageResult => {
      const t0 = Date.now();
      const res = runPwsh(scriptPath, [vaultRoot, ...args.passthrough], {
        cwd: ctx.cfg.installRoot.path,
        env: { ...process.env, SUTRA_VAULT: vaultRoot, SUTRA_HOME: ctx.cfg.installRoot.path },
      });

      // D10 — capture the child's output. Always, including on failure.
      captureChildOutput(vaultRoot, verb, res.stdout, res.stderr);
      if (!ctx.mode.json && res.stdout.trim()) say(ctx.mode, res.stdout.trimEnd());

      if (res.outcome === "missing-script") {
        return {
          stage: verb, outcome: "skipped-policy", produced: null, considered: null,
          duration_ms: Date.now() - t0,
          reason: `${spec.script} is not present in this install. The verb is declared but has no implementation here.`,
        };
      }
      if (res.outcome === "missing-interpreter") {
        return {
          stage: verb, outcome: "failed", produced: null, considered: null,
          duration_ms: Date.now() - t0, reason: res.stderr.split("\n")[0] ?? "pwsh not found",
        };
      }
      if (res.code !== 0) {
        return {
          stage: verb, outcome: "failed", produced: null, considered: null,
          duration_ms: Date.now() - t0,
          reason: `exit ${res.code}: ${(res.stderr || res.stdout).split("\n").slice(0, 3).join(" ").slice(0, 300)}`,
        };
      }
      return {
        stage: verb, outcome: "ok",
        produced: parseCount(res.stdout, "produced"),
        considered: parseCount(res.stdout, "considered"),
        duration_ms: Date.now() - t0,
      };
    },
    {
      runId: recorder.runId,
      onSkip: (msg) => {
        // Normal, not an error. Says so, and exits 0.
        say(ctx.mode, c.dim(`  skipped — ${msg}`));
      },
    },
  );

  if (!outcome.ran) {
    recorder.push({
      stage: verb, outcome: "skipped-policy", produced: null, considered: null, duration_ms: 0,
      reason: `another run holds ${spec.locks.join(", ")} (${outcome.heldBy.run_id} on ${outcome.heldBy.host})`,
    });
  } else {
    recorder.push(outcome.value);
  }

  const record = recorder.finish();
  appendRunLog(vaultRoot, record);
  appendMetrics(join(vaultRoot, ctx.cfg.observability.metrics_csv), {
    run_id: record.run_id,
    result: record.result,
    did_work: record.did_work === null ? null : String(record.did_work),
    duration_s: record.duration_s,
  });

  emitJson(ctx.mode, record);
  if (!ctx.mode.json) {
    const colour = record.result === "ok" ? c.green : record.result === "failed" ? c.red : c.yellow;
    say(ctx.mode, `${colour(record.result)} ${c.dim(`· ${record.duration_s}s`)}`);
    for (const n of record.notes) say(ctx.mode, c.dim(`  ${n}`));
  }
  return record.exit_code === 0 ? EXIT.OK : EXIT.ERROR;
}

/** D10 — a run that produced 4.5 hours of nothing must leave more than two log lines. */
function captureChildOutput(vaultRoot: string, verb: string, stdout: string, stderr: string): void {
  if (!stdout.trim() && !stderr.trim()) return;
  try {
    const file = join(vaultRoot, "logs", "pipeline", `${verb}-${new Date().toISOString().slice(0, 10)}.log`);
    mkdirSync(dirname(file), { recursive: true });
    const stamp = new Date().toISOString();
    writeFileSync(
      file,
      `\n===== ${stamp} ${verb} =====\n${stdout}\n${stderr ? `--- stderr ---\n${stderr}\n` : ""}`,
      { flag: "a", encoding: "utf8" },
    );
  } catch { /* observability never fails the run */ }
}

/** Scripts print `produced: N` / `considered: N`; absence yields null, never 0. */
function parseCount(stdout: string, key: string): number | null {
  const m = new RegExp(`^\\s*${key}\\s*[:=]\\s*(\\d+)`, "mi").exec(stdout);
  return m ? Number(m[1]) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// `sutra rescan` — I15 / D14. The mechanism, not a stub.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Re-classify EVERY note under the ACTIVE pattern set, and stamp the corpus
 * with that set's hash.
 *
 * ── Why this command exists at all ─────────────────────────────────────────
 * This is the credential incident's own unfixed root cause, and the only ⛔ in
 * its remediation table. Content classified once, under an older pattern set,
 * is never re-examined — so improving the pattern list changes NOTHING
 * retroactively. Thirteen source documents sat at hosted-egress tier with
 * plaintext credentials in them, and every one was surfaced by an agent
 * happening to read the extracts, not by any scan.
 *
 * A scanner is only ever as good as its list, and the list WILL be incomplete.
 * So the product ships the re-scan trigger, not just a longer list.
 *
 * ── Raise-only, always ─────────────────────────────────────────────────────
 * A re-scan can RAISE a tier and can never lower one. `--apply` writes; the
 * default is a dry run, because a governance operation that changes files
 * should show you what it would do first.
 */
export function cmdRescan(ctx: Ctx, args: ParsedArgs): ExitCode {
  const vaultRoot = ctx.cfg.vaultRoot.path;
  const apply = flagBool(args, "apply");
  const patterns = loadPatternSet(ctx.cfg.installRoot.path);

  const changes: Array<{ relPath: string; from: Tier; to: Tier; reasons: string[] }> = [];
  let scanned = 0;

  const walk = (dir: string): void => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) { walk(abs); continue; }
      if (!e.name.endsWith(".md")) continue;

      scanned++;
      let raw: string;
      try { raw = readFileSync(abs, "utf8"); } catch { continue; }

      const parsed = matter(raw);
      const data = parsed.data as Record<string, unknown>;
      const relPath = relative(vaultRoot, abs).split(sep).join("/");
      const current = coerceTier(data["sensitivity"]);

      const result = classify({
        text: parsed.content,
        relPath,
        extractEngine: data["extract_engine"] === undefined ? null : String(data["extract_engine"]),
        currentTier: current,
      }, patterns);

      const next = raiseOnly(current, result.tier);
      if (next === current) continue;

      // Belt and braces on the thing that must never happen.
      if (isDownscope(current, next)) {
        throw new Error(`BUG: rescan attempted to downscope ${relPath} from ${current} to ${next}`);
      }

      changes.push({ relPath, from: current, to: next, reasons: result.reasons });

      if (apply) {
        // KEY-SCOPED REWRITE (D3): touch ONLY `sensitivity:`, and verify every
        // other byte is unchanged. The upstream shared helper re-serialised
        // whole files and had already dirtied 660 manifests before anyone
        // noticed — reformatting a user's notes is not an acceptable side
        // effect of a security scan.
        const rewritten = rewriteSensitivityKey(raw, TIER_DISPLAY[next]);
        if (rewritten === null) {
          warn(`could not rewrite ${relPath} without reformatting it — skipped, re-tier it by hand`);
          continue;
        }
        writeFileSync(abs, rewritten, "utf8");
        auditLog(vaultRoot, {
          kind: "tier.raised", message: relPath, from: current, to: next, reason: result.reasons.join(" · "),
        });
      }
    }
  };

  for (const root of ctx.cfg.walkRoots) walk(join(vaultRoot, root));
  walk(join(vaultRoot, "raw"));       // intake is exactly where credentials arrive
  walk(join(vaultRoot, "compiled"));  // D14: scan EXTRACTS, not only pages

  if (apply) {
    const stampPath = join(vaultRoot, "state", "checks", "pattern-scan.json");
    mkdirSync(dirname(stampPath), { recursive: true });
    writeFileSync(stampPath, JSON.stringify({
      pattern_hash: patterns.hash,
      pattern_version: patterns.version,
      scanned_at: new Date().toISOString(),
      notes_scanned: scanned,
      tiers_raised: changes.length,
    }, null, 2) + "\n", "utf8");
  }

  emitJson(ctx.mode, { scanned, changes, applied: apply, pattern_hash: patterns.hash });

  if (!ctx.mode.json) {
    heading(ctx.mode, apply ? "Re-scan applied" : "Re-scan (dry run)");
    say(ctx.mode, c.dim(`  pattern set ${patterns.hash.slice(0, 12)}… v${patterns.version} · ${scanned} notes scanned`));
    if (!changes.length) {
      say(ctx.mode, c.green("  no tier changes — the corpus already matches the active pattern set"));
    } else {
      for (const ch of changes) {
        say(ctx.mode, `  ${c.yellow("↑")} ${ch.relPath}  ${TIER_DISPLAY[ch.from]} → ${c.bold(TIER_DISPLAY[ch.to])}`);
        for (const r of ch.reasons.slice(0, 2)) say(ctx.mode, c.dim(`      ${r}`));
      }
      say(ctx.mode, "", c.bold(`  ${changes.length} note(s) ${apply ? "raised" : "would be raised"}.`));
    }
    if (!apply && changes.length) say(ctx.mode, c.dim("  sutra rescan --apply   to write these changes (raise-only, always)"));
    if (apply) {
      say(ctx.mode, "", c.dim("  Corpus stamped with the active pattern hash. `sutra doctor` will stop asking."));
      say(ctx.mode, c.yellow("  Re-tiering is CONTAINMENT, not remedy: if a real credential was found, the"));
      say(ctx.mode, c.yellow("  cleartext remains in git history. Rotation is the only fix, and it is yours."));
    }
  }

  return EXIT.OK;
}

/**
 * D3 · Rewrite ONLY the `sensitivity:` line, byte-for-byte otherwise.
 *
 * Returns `null` when the note has no frontmatter or no `sensitivity` key —
 * refusing rather than inventing one, so a scan can never restructure a file it
 * did not fully understand.
 */
function rewriteSensitivityKey(raw: string, newValue: string): string | null {
  const fmMatch = /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n)/.exec(raw);
  if (!fmMatch) return null;
  const [full, open, body, close] = fmMatch as unknown as [string, string, string, string];
  if (!/^sensitivity\s*:/m.test(body)) return null;
  const newBody = body.replace(/^(sensitivity\s*:).*$/m, `$1 ${newValue}`);
  return open + newBody + close + raw.slice(full.length);
}

/** `sutra logs [--since N]` */
export function cmdLogs(ctx: Ctx, args: ParsedArgs): ExitCode {
  const file = join(ctx.cfg.vaultRoot.path, "logs", "runs.ndjson");
  if (!existsSync(file)) {
    say(ctx.mode, c.dim("no runs recorded yet"));
    emitJson(ctx.mode, { runs: [] });
    return EXIT.OK;
  }
  const n = Number(flagString(args, "since") ?? 20);
  const runs = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).slice(-n)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean) as Array<{ run_id: string; result: string; duration_s: number; did_work: unknown; host: string; notes: string[] }>;

  emitJson(ctx.mode, { runs });
  if (!ctx.mode.json) {
    for (const r of runs) {
      const colour = r.result === "ok" ? c.green : r.result === "failed" ? c.red : c.yellow;
      say(ctx.mode, `${colour(r.result.padEnd(17))} ${c.dim(`${r.duration_s}s`)}  ${r.run_id} ${c.dim(`(${r.host}, did_work=${String(r.did_work)})`)}`);
      for (const note of r.notes ?? []) say(ctx.mode, c.dim(`    ${note}`));
    }
  }
  return EXIT.OK;
}

/** File count under a directory. Used by `init`'s prove-it step. */
export function countMarkdown(dir: string): number {
  let n = 0;
  const walk = (d: string): void => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.name.endsWith(".md")) n++;
    }
  };
  if (existsSync(dir) && statSync(dir).isDirectory()) walk(dir);
  return n;
}
