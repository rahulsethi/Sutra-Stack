// SPDX-License-Identifier: Apache-2.0
/**
 * RUN OUTCOMES — the fix for D11, and the single most important observability
 * decision in the product.
 *
 * ── The defect, stated exactly ─────────────────────────────────────────────
 * `auto-promote.ps1` caught every LLM error with `catch { return $null }`; the
 * caller counted it as a *skip*; the summary printed
 * `"N promoted, N skipped (pending/no-extract)"` — mislabelling failure as
 * missing input — and exited **0**.
 *
 * It hid perfectly. The message named a benign cause, the exit code was green,
 * and the run manifest said `ok`. That one sentence let a 26-day outage look
 * like a quiet week.
 *
 * ── The governing principle ────────────────────────────────────────────────
 *     Degradation is allowed. Silent degradation is not.
 *
 * Every stage may produce less than its ideal output — no key, no model, no
 * network, a tool missing. What it may NEVER do is produce less and report
 * success.
 *
 * The test for any change here: *if this silently produced nothing for a month,
 * how would the user find out?* If the answer is "they wouldn't", it is not done.
 *
 * ── FIVE OUTCOMES, NEVER SHARING A COUNTER ─────────────────────────────────
 * `ok` / `degraded` / `failed` / `skipped-no-input` / `skipped-policy` are five
 * different things. Two of them are fine, one is an alert, one is an error, and
 * one is a *decision that was correctly made*. Collapsing any pair of them
 * reproduces D11.
 *
 * ── `did_work` IS THREE-VALUED ─────────────────────────────────────────────
 * `true` / `false` / `null` = NOT MEASURABLE. This exists so the fix cannot
 * misfire in the other direction: a stage that has no way to count its own
 * output must say "I don't know", not "I did nothing". An observability fix
 * that generates false alarms gets muted, and a muted alert is worse than no
 * alert because it also carries the belief that someone is watching.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { hostname } from "node:os";

export type Outcome =
  /** Did the work, produced output. */
  | "ok"
  /** Ran, produced SOME output, but less than it should have. An alert, not an error. */
  | "degraded"
  /** Tried and could not. Exits non-zero past the threshold. */
  | "failed"
  /** Nothing to do — there was genuinely no input. NOT a failure. */
  | "skipped-no-input"
  /** Deliberately not run: a policy, a tier, a flag said no. NOT a failure. */
  | "skipped-policy"
  /** Ran, and every count was zero while input existed. NOT `ok`. */
  | "no-op";

/** The three-valued work signal. `null` means "not measurable", not "no". */
export type DidWork = true | false | null;

export interface StageResult {
  stage: string;
  outcome: Outcome;
  /** How many items this stage actually produced. `null` = not measurable. */
  produced: number | null;
  /** How many items it was given. `null` = not measurable. */
  considered: number | null;
  duration_ms: number;
  /**
   * Why, in a sentence a human can act on. REQUIRED for anything but `ok` —
   * `reasonRequired` enforces it, because "degraded" with no reason is a
   * mystery, and a mystery gets ignored.
   */
  reason?: string;
  /** Per-outcome counts of individual items. Never merged across outcomes. */
  items?: Partial<Record<Outcome, number>>;
}

export interface RunRecord {
  run_id: string;
  /** D35 — every series is grouped by host. Cross-host deltas are never computed. */
  host: string;
  started_at: string;
  /**
   * D10 — a run that STARTS and never ENDS is the loudest possible signal, and
   * sat unread in the logs for 26 days. `ended_at: null` on a persisted record
   * means the process died; `staleRunAlert()` reads exactly this.
   */
  ended_at: string | null;
  duration_s: number | null;
  result: Outcome;
  did_work: DidWork;
  stages: StageResult[];
  stages_summary: Record<string, Outcome>;
  exit_code: number;
  notes: string[];
}

/** Outcomes that mean "something went wrong", as opposed to "nothing to do". */
const FAILURE_OUTCOMES = new Set<Outcome>(["failed"]);
/** Outcomes that are legitimately not work. */
const BENIGN_SKIPS = new Set<Outcome>(["skipped-no-input", "skipped-policy"]);

export function reasonRequired(outcome: Outcome): boolean {
  return outcome !== "ok";
}

/**
 * Roll stage results up into ONE run result, without ever collapsing the
 * distinctions above.
 *
 * The rules, in order:
 *   1. Any failure at all → at minimum `degraded`.
 *   2. A MAJORITY of non-benign stages failing → `failed`, exit non-zero.
 *   3. Every stage benign-skipped → `skipped-no-input`. An EMPTY VAULT MUST
 *      EXIT 0 — no false alarm on a fresh install, which is D11's own
 *      counter-test.
 *   4. Ran, nothing produced, but input existed → `no-op`, NOT `ok`.
 *   5. Otherwise `ok`.
 */
export function summarise(
  stages: readonly StageResult[],
  opts: { failureThreshold?: number } = {},
): { result: Outcome; did_work: DidWork; exit_code: number; notes: string[] } {
  const notes: string[] = [];
  if (stages.length === 0) {
    return { result: "skipped-no-input", did_work: null, exit_code: 0, notes: ["no stages ran"] };
  }

  const failed = stages.filter((s) => FAILURE_OUTCOMES.has(s.outcome));
  const degraded = stages.filter((s) => s.outcome === "degraded");
  const substantive = stages.filter((s) => !BENIGN_SKIPS.has(s.outcome));

  // did_work: three-valued. `null` if NOTHING could measure itself.
  const measurable = stages.filter((s) => s.produced !== null);
  const did_work: DidWork =
    measurable.length === 0 ? null : measurable.some((s) => (s.produced ?? 0) > 0);

  if (substantive.length === 0) {
    return {
      result: "skipped-no-input",
      did_work,
      exit_code: 0,
      notes: ["every stage skipped benignly — there was nothing to do. This is not a failure."],
    };
  }

  const threshold = opts.failureThreshold ?? 0.5;
  if (failed.length > 0 && failed.length / substantive.length >= threshold) {
    notes.push(
      `${failed.length} of ${substantive.length} substantive stages FAILED ` +
      `(${failed.map((s) => s.stage).join(", ")}) — at or past the ${Math.round(threshold * 100)}% threshold.`,
    );
    return { result: "failed", did_work, exit_code: 1, notes };
  }

  if (failed.length > 0 || degraded.length > 0) {
    for (const s of [...failed, ...degraded]) {
      notes.push(`${s.stage}: ${s.outcome}${s.reason ? ` — ${s.reason}` : " — NO REASON GIVEN (this is itself a defect)"}`);
    }
    return { result: "degraded", did_work, exit_code: 0, notes };
  }

  // Ran, all green, and yet produced nothing while input existed.
  const consideredAnything = stages.some((s) => (s.considered ?? 0) > 0);
  if (did_work === false && consideredAnything) {
    notes.push(
      "every stage reported success and produced ZERO items while input existed. " +
      "This is `no-op`, not `ok` — an all-zero run that reports ok is how a 26-day outage looked like a quiet week.",
    );
    return { result: "no-op", did_work, exit_code: 0, notes };
  }

  return { result: "ok", did_work, exit_code: 0, notes };
}

/**
 * A run in progress. Construct at the start, `stage()` per stage, `finish()` at
 * the end. The `started_at` marker is written IMMEDIATELY, before any work, so
 * that a killed process leaves evidence of having started.
 */
export class RunRecorder {
  private readonly started = Date.now();
  private readonly stages: StageResult[] = [];
  readonly runId: string;
  readonly host: string;

  constructor(
    private readonly vaultRoot: string,
    private readonly name: string,
    opts: { host?: string; runId?: string } = {},
  ) {
    this.host = opts.host ?? hostname();
    this.runId = opts.runId ?? `${new Date().toISOString().replace(/[:.]/g, "-")}-${this.name}`;
    this.writeMarker(null);
  }

  /** Record one stage. Duration is measured here, not reported by the caller. */
  stage(
    stage: string,
    fn: () => { outcome: Outcome; produced: number | null; considered: number | null; reason?: string },
  ): StageResult {
    const t0 = Date.now();
    let r: StageResult;
    try {
      const out = fn();
      r = { stage, ...out, duration_ms: Date.now() - t0 };
    } catch (e) {
      // D11's core case: an exception is a FAILURE, never a skip.
      r = {
        stage,
        outcome: "failed",
        produced: null,
        considered: null,
        duration_ms: Date.now() - t0,
        reason: `threw: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    if (reasonRequired(r.outcome) && !r.reason) {
      r.reason = "(no reason recorded — see D11: an outcome without a reason cannot be acted on)";
    }
    this.stages.push(r);
    return r;
  }

  /** Record a stage result computed elsewhere. */
  push(result: StageResult): void {
    this.stages.push(result);
  }

  finish(): RunRecord {
    const s = summarise(this.stages);
    const ended = new Date();
    const record: RunRecord = {
      run_id: this.runId,
      host: this.host,
      started_at: new Date(this.started).toISOString(),
      ended_at: ended.toISOString(),
      duration_s: Math.round((ended.getTime() - this.started) / 100) / 10,
      result: s.result,
      did_work: s.did_work,
      stages: this.stages,
      stages_summary: Object.fromEntries(this.stages.map((x) => [x.stage, x.outcome])),
      exit_code: s.exit_code,
      notes: s.notes,
    };
    this.writeMarker(record);
    return record;
  }

  /**
   * Write `state/checks/last-run.json` atomically (write-then-rename), so a
   * crash mid-write cannot leave a truncated JSON that every later reader
   * fails to parse — which would turn one bad run into permanent blindness.
   */
  private writeMarker(record: RunRecord | null): void {
    try {
      const file = join(this.vaultRoot, "state", "checks", "last-run.json");
      mkdirSync(dirname(file), { recursive: true });
      const payload: Partial<RunRecord> = record ?? {
        run_id: this.runId,
        host: this.host,
        started_at: new Date(this.started).toISOString(),
        ended_at: null, // ← the D10 signal
        result: "ok",
        did_work: null,
      };
      const tmp = file + ".tmp";
      writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", "utf8");
      renameSync(tmp, file);
    } catch {
      // I12/D12's rule: observability failure must NEVER fail the run.
    }
  }
}

/**
 * I1 vs I2 · "A MISSED RUN MUST BE DISTINGUISHABLE FROM A RUN THAT DID NOTHING."
 *
 * The single most important observability check in the contract, and the one
 * the upstream system could not answer. Three distinct alarms:
 *
 *   - the run never STARTED recently          → I1
 *   - the run started and never ENDED         → D10, the 26-day silent kill
 *   - the run completed and produced nothing  → I2
 */
export function staleRunAlert(
  vaultRoot: string,
  opts: { maxAgeHours?: number; now?: number } = {},
): { ok: boolean; severity: "ok" | "warn" | "loud"; message: string } {
  const file = join(vaultRoot, "state", "checks", "last-run.json");
  const now = opts.now ?? Date.now();
  const maxAge = (opts.maxAgeHours ?? 36) * 3600_000;

  if (!existsSync(file)) {
    return { ok: false, severity: "warn", message: "no run has ever been recorded. Run `sutra daily`." };
  }
  let rec: Partial<RunRecord>;
  try {
    rec = JSON.parse(readFileSync(file, "utf8")) as Partial<RunRecord>;
  } catch {
    return { ok: false, severity: "loud", message: "the run record is unparseable — the pipeline's own state file is corrupt." };
  }

  const started = rec.started_at ? Date.parse(rec.started_at) : NaN;

  if (rec.ended_at === null || rec.ended_at === undefined) {
    const age = Number.isFinite(started) ? Math.round((now - started) / 3600_000) : null;
    return {
      ok: false,
      severity: "loud",
      message:
        `run ${rec.run_id ?? "?"} STARTED${age !== null ? ` ${age}h ago` : ""} and never recorded an end. ` +
        `The process was killed or is still running. A scheduler time limit shorter than the job ` +
        `(D10) kills a run silently and leaves exactly this trace.`,
    };
  }

  const ended = Date.parse(rec.ended_at);
  if (Number.isFinite(ended) && now - ended > maxAge) {
    return {
      ok: false,
      severity: "loud",
      message: `the last run ended ${Math.round((now - ended) / 3600_000)}h ago (threshold ${opts.maxAgeHours ?? 36}h). The pipeline is not running.`,
    };
  }

  if (rec.result === "no-op") {
    return { ok: false, severity: "warn", message: "the last run completed and did nothing while input existed (I2)." };
  }
  if (rec.result === "degraded" || rec.result === "failed") {
    return { ok: false, severity: rec.result === "failed" ? "loud" : "warn", message: `the last run was ${rec.result}: ${(rec.notes ?? []).join(" · ")}` };
  }
  return { ok: true, severity: "ok", message: `last run ${rec.result} at ${rec.ended_at} on ${rec.host}` };
}

/**
 * D28 · "run ≠ scheduled".
 *
 * The twin of "created ≠ wired": the script that produced 71% of the upstream
 * corpus was never scheduled and ran ONCE, by hand — with a truncation bug in
 * it. Any script that produces durable content must either have a schedule or
 * be explicitly marked interactive. CI asserts this over the job registry.
 */
export function appendRunLog(vaultRoot: string, record: RunRecord): void {
  try {
    const file = join(vaultRoot, "logs", "runs.ndjson");
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(record) + "\n", "utf8");
  } catch {
    /* observability must never fail the run */
  }
}
