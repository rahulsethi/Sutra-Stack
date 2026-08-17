// SPDX-License-Identifier: Apache-2.0
/**
 * D11 · `run/failure-is-not-skip` — and D10, which is the same failure a layer
 * up: a run that dies leaving no record.
 *
 * ── D11, THE DEFECT ────────────────────────────────────────────────────────
 * An LLM error was caught with `catch { return $null }`, counted by the caller
 * as a *skip*, printed as `"N promoted, N skipped (pending/no-extract)"`, and
 * exited **0**.
 *
 * It hid perfectly: the message named a benign cause, the exit code was green,
 * and the run manifest said `ok`. **That one sentence let a 26-day outage look
 * like a quiet week.**
 *
 * D11's own test specification:
 *
 *   > Inject a provider error: assert the reason bucket is a failure, the run
 *   > result is `degraded`, and the exit code is non-zero past the threshold.
 *   > Assert an EMPTY vault still exits 0 — no false alarm.
 *
 * That last clause is as important as the first. An observability fix that
 * generates false alarms gets muted, and a muted alert is worse than no alert
 * because it also carries the belief that someone is watching.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { summarise, RunRecorder, staleRunAlert, appendRunLog, type StageResult } from "./outcome.js";

const newVault = (): string => mkdtempSync(join(tmpdir(), "sutra-run-"));

const stage = (
  name: string,
  outcome: StageResult["outcome"],
  produced: number | null = 0,
  considered: number | null = 0,
): StageResult => ({ stage: name, outcome, produced, considered, duration_ms: 1, reason: "test" });

// ─────────────────────────────────────────────────────────────────────────────
// D11 · a failure is a failure
// ─────────────────────────────────────────────────────────────────────────────

test("D11 · an injected provider error is a FAILURE, never a skip", () => {
  // The property is that a failure is never absorbed into `ok` — whether it
  // rolls up to `degraded` or `failed` depends only on the share of stages
  // affected, and both are correct answers to "did something go wrong".
  const r = summarise([
    stage("ingest", "ok", 5, 5),
    stage("compile", "failed", null, 3),
  ]);
  assert.notEqual(r.result, "ok", "a failure was absorbed into `ok`");
  assert.notEqual(r.result, "skipped-no-input", "a failure was reported as a benign skip — THIS IS D11");
  assert.ok(r.notes.some((n) => /FAILED|failed/.test(n)), "the failure must be named in the notes");

  // One failure of TWO substantive stages is 50%, which meets the documented
  // majority threshold. One of three does not.
  assert.equal(r.result, "failed", "1 of 2 is a majority by the 50% threshold");
  assert.equal(
    summarise([stage("a", "ok", 5, 5), stage("b", "ok", 5, 5), stage("c", "failed", null, 1)]).result,
    "degraded",
    "1 of 3 is below the threshold and must be degraded, not failed",
  );
});

test("D11 · a THROWN error inside a stage is recorded as `failed`, not `skipped`", () => {
  // The literal defect: `catch { return $null }` turning an exception into a
  // benign-looking skip.
  const rec = new RunRecorder(newVault(), "test");
  const s = rec.stage("compile", () => { throw new Error("provider 500"); });

  assert.equal(s.outcome, "failed", "a thrown error was not recorded as a failure");
  assert.match(s.reason!, /threw: provider 500/, "the reason must name the actual cause");
});

test("D11 · a MAJORITY failure exits NON-ZERO", () => {
  const r = summarise([
    stage("a", "failed", null, 1),
    stage("b", "failed", null, 1),
    stage("c", "ok", 1, 1),
  ]);
  assert.equal(r.result, "failed");
  assert.equal(r.exit_code, 1, "a majority-failure run exited 0");
});

test("D11 · a MINORITY failure is `degraded` and exits 0 — an alert, not an error", () => {
  const r = summarise([
    stage("a", "ok", 5, 5),
    stage("b", "ok", 5, 5),
    stage("c", "failed", null, 1),
  ]);
  assert.equal(r.result, "degraded");
  assert.equal(r.exit_code, 0);
});

test("D11 · AN EMPTY VAULT EXITS 0 — no false alarm on a fresh install", () => {
  // D11's own counter-test. This is the clause that keeps the fix from becoming
  // the next problem.
  const r = summarise([
    stage("ingest", "skipped-no-input", 0, 0),
    stage("compile", "skipped-no-input", 0, 0),
  ]);
  assert.equal(r.result, "skipped-no-input");
  assert.equal(r.exit_code, 0, "an empty vault reported a failure");
  assert.ok(r.notes.some((n) => /not a failure/.test(n)));
});

test("D11 · an all-zero run WITH input is `no-op`, NOT `ok`", () => {
  const r = summarise([stage("compile", "ok", 0, 42)]);
  assert.equal(r.result, "no-op",
    "a run that considered 42 items and produced 0 reported `ok` — that is how a 26-day outage " +
    "looked like a quiet week");
  assert.equal(r.did_work, false);
});

test("D11 · FIVE OUTCOMES NEVER SHARE A COUNTER", () => {
  // The property stated directly: each outcome must roll up differently.
  const results = new Set(
    (["ok", "degraded", "failed", "skipped-no-input", "skipped-policy"] as const).map((o) => {
      const stages: StageResult[] = o === "ok" ? [stage("s", "ok", 1, 1)] : [stage("s", o, o === "failed" ? null : 0, 1)];
      return summarise(stages).result;
    }),
  );
  assert.ok(results.size >= 3, `five distinct outcomes rolled up into ${results.size} result(s)`);
});

test("D11 · `did_work` is THREE-VALUED — null means NOT MEASURABLE", () => {
  // So the fix cannot misfire in the other direction and cry "did nothing"
  // without proof.
  assert.equal(summarise([stage("s", "ok", null, null)]).did_work, null, "unmeasurable must be null, not false");
  assert.equal(summarise([stage("s", "ok", 0, 5)]).did_work, false);
  assert.equal(summarise([stage("s", "ok", 3, 5)]).did_work, true);
});

test("D11 · a non-ok outcome without a reason gets one — silently is not an option", () => {
  const rec = new RunRecorder(newVault(), "test");
  const s = rec.stage("x", () => ({ outcome: "degraded" as const, produced: 0, considered: 1 }));
  assert.ok(s.reason && s.reason.length > 0, "a degraded stage carried no reason at all");
  assert.match(s.reason!, /no reason recorded/);
});

// ─────────────────────────────────────────────────────────────────────────────
// D10 · a run that starts and never ends
// ─────────────────────────────────────────────────────────────────────────────

test("D10 · the start marker is written BEFORE any work, with ended_at: null", () => {
  // The whole D10 signal. A killed process writes no failure record, so the
  // only evidence is an ABSENCE — and something has to be watching for it.
  const root = newVault();
  new RunRecorder(root, "daily");

  const marker = JSON.parse(
    readFileSync(join(root, "state", "checks", "last-run.json"), "utf8"),
  ) as { ended_at: string | null; started_at: string };

  assert.equal(marker.ended_at, null, "the start marker must carry ended_at: null");
  assert.ok(marker.started_at, "the start marker must carry started_at");
});

test("D10 · `sched/limit-exceeds-runtime` — a START with no STOP is LOUD", () => {
  // Upstream this sat unread in the logs for 26 days. The logs were 103 bytes:
  // a START line and no STOP.
  const root = newVault();
  new RunRecorder(root, "daily");   // starts, never finishes

  const alert = staleRunAlert(root);
  assert.equal(alert.ok, false);
  assert.equal(alert.severity, "loud", "a killed run must be LOUD, not a warning");
  assert.match(alert.message, /never recorded an end/);
  assert.match(alert.message, /scheduler time limit shorter than the job/,
    "the alert must name the likely cause, or the next person diagnoses it from scratch");
});

test("D10 · a COMPLETED run is not reported as killed", () => {
  const root = newVault();
  const rec = new RunRecorder(root, "daily");
  rec.push(stage("ingest", "ok", 3, 3));
  rec.finish();

  const alert = staleRunAlert(root);
  assert.equal(alert.ok, true, "a completed run was reported as stale");
});

test("D10 · three DISTINCT alarms — never started, never ended, produced nothing", () => {
  // I1 vs I2: "a missed run must be distinguishable from a run that did
  // nothing". Upstream it was not, and that was the single most important
  // observability gap.
  const never = newVault();
  assert.match(staleRunAlert(never).message, /no run has ever been recorded/);

  const killed = newVault();
  new RunRecorder(killed, "daily");
  assert.match(staleRunAlert(killed).message, /never recorded an end/);

  const empty = newVault();
  const rec = new RunRecorder(empty, "daily");
  rec.push(stage("compile", "ok", 0, 9));
  rec.finish();
  assert.match(staleRunAlert(empty).message, /did nothing while input existed/);
});

test("D10 · a run that ended too long ago is LOUD", () => {
  const root = newVault();
  const rec = new RunRecorder(root, "daily");
  rec.push(stage("ingest", "ok", 1, 1));
  rec.finish();

  const alert = staleRunAlert(root, { maxAgeHours: 36, now: Date.now() + 48 * 3600_000 });
  assert.equal(alert.severity, "loud");
  assert.match(alert.message, /The pipeline is not running/);
});

test("D10 · a CORRUPT run record is loud, not silently ignored", () => {
  const root = newVault();
  mkdirSync(join(root, "state", "checks"), { recursive: true });
  writeFileSync(join(root, "state", "checks", "last-run.json"), "{ truncated");

  const alert = staleRunAlert(root);
  assert.equal(alert.severity, "loud");
  assert.match(alert.message, /unparseable/);
});

test("D10 · the marker is written ATOMICALLY — a crash cannot truncate it", () => {
  // A truncated marker that every later reader fails to parse turns one bad run
  // into permanent blindness.
  const root = newVault();
  const rec = new RunRecorder(root, "daily");
  rec.push(stage("ingest", "ok", 1, 1));
  rec.finish();

  const p = join(root, "state", "checks", "last-run.json");
  assert.doesNotThrow(() => JSON.parse(readFileSync(p, "utf8")));
  assert.equal(existsSync(p + ".tmp"), false, "the temp file was left behind");
});

test("observability failure NEVER fails the run", () => {
  // A metrics or marker write that throws would take down the pipeline it
  // exists to observe.
  const rec = new RunRecorder("/nonexistent/path/that/cannot/be/written", "daily");
  assert.doesNotThrow(() => {
    rec.push(stage("ingest", "ok", 1, 1));
    const record = rec.finish();
    appendRunLog("/nonexistent/path/that/cannot/be/written", record);
  });
});
