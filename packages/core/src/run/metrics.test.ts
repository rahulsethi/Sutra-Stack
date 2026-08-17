// SPDX-License-Identifier: Apache-2.0
/**
 * D12 · `metrics/series-exists` — and D35, the phantom shrink, which is what
 * happens when you finally HAVE a series and read it wrong.
 *
 * ── D12, THE DEFECT ────────────────────────────────────────────────────────
 * Every state file was OVERWRITTEN each run. Answering "is my graph growing?"
 * meant hand-parsing 90 snapshots, and produced the wrong answer.
 *
 * It hid because a point-in-time value always looks fine. The absence of
 * history is not visible in any artifact — you discover it at the exact moment
 * you need a trend, which is the moment you are already in an incident.
 *
 * The fix is embarrassingly cheap (~250 bytes per run) and can only be applied
 * BEFORE it is needed, which is why it ships on day one against an empty vault.
 *
 * ── D35, THE DEFECT ────────────────────────────────────────────────────────
 * Two machines wrote into one git-committed snapshot directory. Sorting by
 * mtime interleaved them, and a graph that had GROWN on both machines appeared
 * to fall from 3,425 nodes to 2,982. An alert fired on a shrink that never
 * happened — and the noise buried the real signal.
 *
 * The test below reproduces that arithmetic exactly, then asserts the shipped
 * function does not repeat it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  METRIC_COLUMNS,
  appendMetrics,
  readMetrics,
  deltasByHost,
  regressionAlerts,
  type ParsedRow,
} from "./metrics.js";

const newCsv = (): string => join(mkdtempSync(join(tmpdir(), "sutra-metrics-")), "state", "metrics.csv");

/** A parsed row without going through the file, for the delta tests. */
const row = (host: string, ts: number, values: Record<string, number | null>): ParsedRow => ({
  ts,
  host,
  values,
  raw: {},
});

// ─────────────────────────────────────────────────────────────────────────────
// D12 · there IS a series
// ─────────────────────────────────────────────────────────────────────────────

test("D12 · a run APPENDS — it does not overwrite the previous run", () => {
  // The whole defect in one assertion. Upstream, run 2 destroyed run 1.
  const csv = newCsv();
  appendMetrics(csv, { run_id: "one", graph_nodes: 100 });
  appendMetrics(csv, { run_id: "two", graph_nodes: 140 });
  appendMetrics(csv, { run_id: "three", graph_nodes: 175 });

  const rows = readMetrics(csv);
  assert.equal(rows.length, 3, "later runs overwrote earlier ones — THIS IS D12");
  assert.deepEqual(rows.map((r) => r.values["graph_nodes"]), [100, 140, 175]);
});

test("D12 · the header is written EXACTLY ONCE", () => {
  // A header repeated mid-file breaks every downstream parser from the second
  // run onward — and it would look like the series was working.
  const csv = newCsv();
  for (let i = 0; i < 5; i++) appendMetrics(csv, { run_id: `r${i}`, graph_nodes: i });

  const text = readFileSync(csv, "utf8");
  const headerCount = text.split("\n").filter((l) => l.startsWith(METRIC_COLUMNS[0] + ",")).length;
  assert.equal(headerCount, 1, `the header appears ${headerCount} times`);
});

test("D12 · a repeated header from a BAD MERGE is tolerated, not parsed as data", () => {
  // Two machines committing the same CSV will eventually produce this. A NaN
  // row poisoning a delta is a worse outcome than skipping a line.
  const csv = newCsv();
  appendMetrics(csv, { run_id: "a", graph_nodes: 10 });
  writeFileSync(csv, readFileSync(csv, "utf8") + METRIC_COLUMNS.join(",") + "\n", { flag: "w" });
  appendMetrics(csv, { run_id: "b", graph_nodes: 20 });

  const rows = readMetrics(csv);
  assert.equal(rows.length, 2, "the duplicated header was parsed as a data row");
  assert.deepEqual(rows.map((r) => r.values["graph_nodes"]), [10, 20]);
});

test("D12 · AN UNMEASURABLE VALUE IS A BLANK CELL, NEVER A ZERO", () => {
  // "I could not measure this" and "this is zero" are different facts, and a
  // threshold that fires on the first is how a metric becomes a lie.
  const csv = newCsv();
  appendMetrics(csv, { run_id: "x", graph_nodes: null, kg_entities: undefined, notes_total: 0 });

  const [r] = readMetrics(csv);
  assert.equal(r!.raw["graph_nodes"], "", "an unmeasurable value was written as a number");
  assert.equal(r!.raw["kg_entities"], "");
  assert.equal(r!.values["graph_nodes"], null);

  // …and a REAL zero survives as a real zero. Both directions matter.
  assert.equal(r!.raw["notes_total"], "0");
  assert.equal(r!.values["notes_total"], 0);
});

test("D12 · a NaN is a blank cell too", () => {
  const csv = newCsv();
  appendMetrics(csv, { run_id: "x", capture_ratio_median: Number.NaN, graph_nodes: Number.POSITIVE_INFINITY });
  const [r] = readMetrics(csv);
  assert.equal(r!.raw["capture_ratio_median"], "", "NaN was written into the series");
  assert.equal(r!.raw["graph_nodes"], "");
});

test("D12 · the series survives a value containing a COMMA", () => {
  const csv = newCsv();
  appendMetrics(csv, { run_id: "a,b", result: 'quoted "thing", comma', graph_nodes: 7 });
  const [r] = readMetrics(csv);
  assert.equal(r!.raw["run_id"], "a,b", "a comma in a value shifted every later column");
  assert.equal(r!.values["graph_nodes"], 7);
});

test("D12 · every row carries ts and host WITHOUT being asked", () => {
  // A series with no timestamp answers no trend question, and one with no host
  // cannot be read per-host — which is D35.
  const csv = newCsv();
  appendMetrics(csv, { run_id: "x" });
  const [r] = readMetrics(csv);
  assert.ok(r!.ts > 0, "the row has no parseable timestamp");
  assert.ok(r!.host.length > 0, "the row has no host");
});

test("D12 · reading a series that does not exist yet returns [] — a fresh vault is not an error", () => {
  assert.deepEqual(readMetrics(join(tmpdir(), "sutra-nope-" + Math.random(), "metrics.csv")), []);
  assert.deepEqual(deltasByHost([], "graph_nodes"), []);
  assert.deepEqual(regressionAlerts([]), []);
});

test("D12 · a metrics write NEVER throws — observability cannot fail the run", () => {
  assert.doesNotThrow(() => appendMetrics("\0/invalid\0/path/metrics.csv", { run_id: "x" }));
  assert.doesNotThrow(() => readMetrics("\0/invalid\0/path/metrics.csv"));
});

test("D12 · the column ORDER is append-only — history is already written", () => {
  // Reordering or removing a column silently re-labels every row ever written.
  // Pinning the prefix makes that a test failure rather than a data corruption.
  assert.deepEqual(
    METRIC_COLUMNS.slice(0, 6),
    ["ts", "host", "run_id", "result", "did_work", "duration_s"],
    "the leading columns changed — every historical row is now mis-parsed",
  );
  assert.equal(new Set(METRIC_COLUMNS).size, METRIC_COLUMNS.length, "a column name is duplicated");
});

// ─────────────────────────────────────────────────────────────────────────────
// D35 · the phantom shrink
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The upstream data, reconstructed. Laptop and desktop both GREW; interleaving
 * them by time produces a sequence that falls.
 */
const TWO_HOSTS: ParsedRow[] = [
  row("laptop", 1_000, { graph_nodes: 2_900, notes_total: 800 }),
  row("desktop", 2_000, { graph_nodes: 3_425, notes_total: 800 }),
  row("laptop", 3_000, { graph_nodes: 2_982, notes_total: 810 }),   // ← grew, 2900 → 2982
  row("desktop", 4_000, { graph_nodes: 3_501, notes_total: 810 }),  // ← grew, 3425 → 3501
];

test("D35 · the PHANTOM SHRINK is reproducible — the defect is real", () => {
  // Plant it: this is precisely what mtime ordering did upstream, and it is why
  // the assertion below is worth anything.
  const naive = [...TWO_HOSTS].sort((a, b) => a.ts - b.ts);
  const naiveDeltas: number[] = [];
  for (let i = 1; i < naive.length; i++) {
    naiveDeltas.push((naive[i]!.values["graph_nodes"] as number) - (naive[i - 1]!.values["graph_nodes"] as number));
  }
  assert.ok(
    naiveDeltas.some((d) => d < 0),
    "the fixture no longer reproduces the phantom shrink, so the test below proves nothing",
  );
  assert.ok(naiveDeltas.includes(2_982 - 3_425), "the upstream -443 step is missing from the fixture");
});

test("D35 · deltasByHost NEVER compares rows from different hosts", () => {
  const deltas = deltasByHost(TWO_HOSTS, "graph_nodes");

  assert.equal(deltas.length, 2, "expected exactly one delta per host");
  for (const d of deltas) {
    assert.ok(d.delta > 0, `a PHANTOM SHRINK survived: ${d.host} ${d.from} → ${d.to}`);
  }
  assert.deepEqual(
    deltas.map((d) => [d.host, d.from, d.to]).sort(),
    [["desktop", 3_425, 3_501], ["laptop", 2_900, 2_982]],
  );
});

test("D35 · no alert fires on the phantom — the real signal is not buried", () => {
  const alerts = regressionAlerts(TWO_HOSTS, { column: "graph_nodes" });
  const shrink = alerts.filter((a) => /DECREASED/.test(a.message));
  assert.deepEqual(shrink, [], "an alert fired on a shrink that never happened — THIS IS D35");
});

test("D35 · a REAL same-host shrink IS loud — the fix does not silence the alarm", () => {
  // The counter-test. A D35 fix that suppressed all shrink alerts would "pass"
  // the test above while removing the only thing it was protecting.
  const real: ParsedRow[] = [
    row("laptop", 1_000, { graph_nodes: 3_400 }),
    row("laptop", 2_000, { graph_nodes: 2_982 }),
  ];
  const alerts = regressionAlerts(real, { column: "graph_nodes" });
  assert.equal(alerts.length, 1, "a genuine same-host shrink was not alerted");
  assert.equal(alerts[0]!.severity, "loud");
  assert.match(alerts[0]!.message, /DECREASED on laptop: 3400 → 2982/);
});

test("D35 · a BLANK cell yields NO delta — not a delta of zero, not a fall to zero", () => {
  // "I did not measure it" must never look like "it went to nil". That is the
  // exact shape of the alert that would fire hardest and mean least.
  const rows: ParsedRow[] = [
    row("laptop", 1_000, { graph_nodes: 3_400 }),
    row("laptop", 2_000, { graph_nodes: null }),
    row("laptop", 3_000, { graph_nodes: 3_450 }),
  ];
  const deltas = deltasByHost(rows, "graph_nodes");
  assert.equal(deltas.length, 1, "a blank cell produced a delta");
  assert.deepEqual([deltas[0]!.from, deltas[0]!.to], [3_400, 3_450],
    "the gap must be bridged, not treated as a fall to zero and back");
  assert.deepEqual(regressionAlerts(rows, { column: "graph_nodes" }), []);
});

test("D35 · rows are ordered per host, not by arrival — an out-of-order append is handled", () => {
  const rows: ParsedRow[] = [
    row("a", 3_000, { graph_nodes: 300 }),
    row("a", 1_000, { graph_nodes: 100 }),
    row("a", 2_000, { graph_nodes: 200 }),
  ];
  const deltas = deltasByHost(rows, "graph_nodes");
  assert.deepEqual(deltas.map((d) => d.delta), [100, 100], "out-of-order rows produced a false shrink");
});

// ─────────────────────────────────────────────────────────────────────────────
// I6 · the graph grows or explains itself
// ─────────────────────────────────────────────────────────────────────────────

test("I6b · a COMMUNITY COLLAPSE to zero is its own alert, not a shrink", () => {
  // All 679 communities silently degrading to `-1` happened twice upstream and
  // was never alerted. A collapse is a Louvain failure, not a shrinking graph,
  // and it needs a different remedy — so it gets a different message.
  const rows: ParsedRow[] = [
    row("laptop", 1_000, { graph_nodes: 3_400, graph_communities: 679 }),
    row("laptop", 2_000, { graph_nodes: 3_450, graph_communities: 0 }),
  ];
  const alerts = regressionAlerts(rows, { column: "graph_nodes" });
  const collapse = alerts.filter((a) => /COMMUNITIES COLLAPSED/.test(a.message));
  assert.equal(collapse.length, 1, "a total community collapse was not alerted separately");
  assert.match(collapse[0]!.message, /was 679/);
  assert.equal(collapse[0]!.severity, "loud");
});

test("I6 · a FLAT graph while notes arrive is a warning — the builder may not see them", () => {
  const rows: ParsedRow[] = [
    row("laptop", 1_000, { graph_nodes: 3_400, notes_total: 800 }),
    row("laptop", 2_000, { graph_nodes: 3_400, notes_total: 830 }),
    row("laptop", 3_000, { graph_nodes: 3_400, notes_total: 860 }),
  ];
  const alerts = regressionAlerts(rows, { column: "graph_nodes", flatRuns: 3 });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]!.severity, "warn");
  assert.match(alerts[0]!.message, /unchanged for 3 runs/);
});

test("I6 · a flat graph while NO notes arrive is silent — nothing to explain", () => {
  const rows: ParsedRow[] = [
    row("laptop", 1_000, { graph_nodes: 3_400, notes_total: 800 }),
    row("laptop", 2_000, { graph_nodes: 3_400, notes_total: 800 }),
    row("laptop", 3_000, { graph_nodes: 3_400, notes_total: 800 }),
  ];
  assert.deepEqual(regressionAlerts(rows, { column: "graph_nodes", flatRuns: 3 }), [],
    "a quiet week was reported as a problem — false alarms get alerting muted");
});

// ─────────────────────────────────────────────────────────────────────────────

test("D12+D35 · end-to-end through the FILE, two hosts, one CSV", () => {
  // The two defects meet in the real artifact: one git-committed CSV that both
  // machines append to. Everything above operates on parsed rows; this proves
  // the property survives the round trip through disk.
  const csv = newCsv();
  mkdirSync(join(csv, ".."), { recursive: true });

  const header = METRIC_COLUMNS.join(",");
  const line = (ts: string, host: string, nodes: number): string =>
    METRIC_COLUMNS.map((c) =>
      c === "ts" ? ts : c === "host" ? host : c === "graph_nodes" ? String(nodes) : "",
    ).join(",");

  writeFileSync(csv, [
    header,
    line("2026-08-10T01:00:00.000Z", "laptop", 2_900),
    line("2026-08-10T02:00:00.000Z", "desktop", 3_425),
    line("2026-08-11T01:00:00.000Z", "laptop", 2_982),
    line("2026-08-11T02:00:00.000Z", "desktop", 3_501),
  ].join("\n") + "\n", "utf8");

  const rows = readMetrics(csv);
  assert.equal(rows.length, 4);
  assert.deepEqual([...new Set(rows.map((r) => r.host))].sort(), ["desktop", "laptop"]);
  assert.deepEqual(regressionAlerts(rows, { column: "graph_nodes" }), [],
    "the phantom shrink came back through the file path");
});
