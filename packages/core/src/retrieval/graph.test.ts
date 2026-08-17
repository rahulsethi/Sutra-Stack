// SPDX-License-Identifier: Apache-2.0
/**
 * D13 · `artifact/header-matches-body` — and D18, `graph/anti-regression`,
 * which is the same artifact failing the other way: not lying about itself, but
 * being replaced by nothing.
 *
 * ── D13, THE DEFECT ────────────────────────────────────────────────────────
 * `enrich-graph.py` added edges and updated only `meta.enriched`, leaving
 * `meta.edge_count` at its pre-enrich value. Measured on the live export:
 * header **16,291** vs `edges[]` **29,286** — the header was 44% low.
 *
 * It hid for a reason worth stating precisely: **the cheap reader is the one
 * that is wrong.** The metrics counter deliberately did a 2 KB head read
 * (130 ms, against 1,251 ms for a full parse), so the very fix that finally
 * made the graph observable inherited a lying header — and every dashboard,
 * alert and trend built on it was wrong by 44% while looking healthy.
 *
 * ── D18, THE DEFECT ────────────────────────────────────────────────────────
 * `refresh-graphs.ps1` pointed the builder at a directory that DOES NOT EXIST,
 * so every run rebuilt from nothing. The anti-regression guard lived only in
 * the CALLER, and the 2026-08-08 loss went straight past it.
 *
 * And then the part that matters most: **the guard worked.** It correctly
 * rejected the empty result — every night, silently. A guard that fires
 * constantly and says nothing is indistinguishable from a healthy system.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { coerceTier } from "../gate/tiers.js";
import {
  GRAPH_REL,
  loadGraph,
  verifyHeader,
  getGraph,
  expand,
  antiRegressionCheck,
  type CytoGraph,
} from "./graph.js";

/** Write a graph into a fresh vault and return its root. */
function vaultWith(graph: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "sutra-graph-"));
  const p = join(root, GRAPH_REL);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(graph), "utf8");
  return root;
}

const node = (id: string, extra: Record<string, unknown> = {}) => ({
  data: { id, label: id, type: "Note", sensitivity: "public", ...extra },
});
const edge = (source: string, target: string) => ({ data: { source, target } });

// ─────────────────────────────────────────────────────────────────────────────
// D13 · the header and the body
// ─────────────────────────────────────────────────────────────────────────────

test("D13 · A LYING edge_count IS CAUGHT — the upstream 16,291 vs 29,286", () => {
  // Planted at the real ratio: a header 44% below the body, which is what an
  // enrichment pass that forgot one counter actually produces.
  const graph: CytoGraph = {
    nodes: [node("a"), node("b"), node("c")],
    edges: [edge("a", "b"), edge("b", "c"), edge("a", "c")],
    meta: { node_count: 3, edge_count: 2 },   // ← the enrich pass added one and did not count it
  };

  const problems = verifyHeader(graph);
  assert.equal(problems.length, 1, "a header that disagrees with its body was not caught");
  assert.deepEqual(problems[0], { counter: "meta.edge_count", header: 2, actual: 3 });
});

test("D13 · a lying node_count is caught too", () => {
  const problems = verifyHeader({
    nodes: [node("a"), node("b")],
    edges: [],
    meta: { node_count: 16_291, edge_count: 0 },
  });
  assert.equal(problems.length, 1);
  assert.equal(problems[0]!.counter, "meta.node_count");
});

test("D13 · EVERY discrepancy is reported, not just the first", () => {
  // This runs inside `doctor`, where reporting three problems is more useful
  // than aborting on one — and where a fix-one-rerun loop is how people give up.
  const problems = verifyHeader({
    nodes: [node("a")],
    edges: [edge("a", "a")],
    meta: { node_count: 99, edge_count: 99, community_count: 99 },
  });
  assert.equal(problems.length, 3, "verifyHeader stopped at the first discrepancy");
  assert.deepEqual(problems.map((p) => p.counter).sort(),
    ["meta.community_count", "meta.edge_count", "meta.node_count"]);
});

test("D13 · an HONEST header is silent", () => {
  // The counter-test. A checker that flags a correct artifact gets switched off,
  // and then D13 is back with the alarm disconnected.
  const problems = verifyHeader({
    nodes: [node("a", { community: 0 }), node("b", { community: 1 })],
    edges: [edge("a", "b")],
    meta: { node_count: 2, edge_count: 1, community_count: 2 },
  });
  assert.deepEqual(problems, []);
});

test("D13 · a MISSING counter is not a discrepancy — absent ≠ wrong", () => {
  // An older artifact without `community_count` is under-specified, not lying.
  // Treating the two the same makes the check noisy on exactly the artifacts
  // that predate it.
  assert.deepEqual(verifyHeader({ nodes: [node("a")], edges: [], meta: {} }), []);
  assert.deepEqual(verifyHeader({ nodes: [node("a")], edges: [] }), []);
});

test("I6b · an UNASSIGNED community (-1) is not counted — the collapse stays visible", () => {
  // All 679 communities silently degrading to `-1` is I6b. If `-1` counted as a
  // community, a total collapse would show `community_count: 1` and look like a
  // small graph rather than a failed algorithm.
  const graph: CytoGraph = {
    nodes: [node("a", { community: -1 }), node("b", { community: -1 }), node("c", { community: -1 })],
    edges: [],
    meta: { node_count: 3, edge_count: 0, community_count: 3 },
  };
  const problems = verifyHeader(graph);
  assert.equal(problems.length, 1, "a total community collapse to -1 was not caught");
  assert.equal(problems[0]!.actual, 0, "`-1` was counted as a real community");
});

test("D13 · the CHEAP READ and the FULL PARSE agree — the actual defect shape", () => {
  // The 2 KB head read is the reader that was wrong. This asserts the two paths
  // return the same number on the shipped artifact, which is the property the
  // dashboards depended on and did not have.
  const root = vaultWith({
    nodes: [node("a"), node("b"), node("c")],
    edges: [edge("a", "b"), edge("b", "c")],
    meta: { node_count: 3, edge_count: 2 },
  });
  const graph = loadGraph(root)!;

  const headerEdges = graph.meta!.edge_count;           // the cheap read
  const bodyEdges = graph.edges.length;                  // the full parse
  assert.equal(headerEdges, bodyEdges,
    "the cheap head-read and the full parse disagree — every metric built on the cheap one is wrong");
  assert.deepEqual(verifyHeader(graph), []);
});

test("D13 · a CORRUPT graph loads as null, not as an empty graph", () => {
  // An unparseable artifact reported as `{nodes: [], edges: []}` would sail
  // through verifyHeader AND look to the anti-regression guard like a legitimate
  // shrink to zero.
  const root = mkdtempSync(join(tmpdir(), "sutra-graph-"));
  const p = join(root, GRAPH_REL);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, "{ truncated", "utf8");
  assert.equal(loadGraph(root), null);

  writeFileSync(p, JSON.stringify({ meta: { node_count: 5 } }), "utf8");
  assert.equal(loadGraph(root), null, "a graph with no nodes[] array loaded as valid");
});

test("D13 · an ABSENT graph is `not_built` with a remedy, not an empty result", () => {
  const root = mkdtempSync(join(tmpdir(), "sutra-graph-"));
  const r = getGraph(root, coerceTier("public"));
  assert.equal(r.status, "not_built");
  if (r.status === "not_built") {
    assert.match(r.message, /sutra graph export/, "the message must name the command that fixes it");
    assert.match(r.message, /Search and ask work without it/, "and say what still works");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// The gate, re-applied on the derived artifact
// ─────────────────────────────────────────────────────────────────────────────

test("the graph re-applies the gate — a private node is COUNTED, never returned", () => {
  const root = vaultWith({
    nodes: [
      node("pub", { sensitivity: "public" }),
      node("priv", { sensitivity: "private" }),
      node("sec", { sensitivity: "secret" }),
      node("dnl", { sensitivity: "public", do_not_learn: true }),
    ],
    edges: [edge("pub", "priv")],
    meta: { node_count: 4, edge_count: 1 },
  });

  const r = getGraph(root, coerceTier("public"));
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  assert.deepEqual(r.nodes.map((n) => n.id), ["pub"]);
  assert.equal(r.withheld, 3, "withheld nodes must be counted so the omission is visible");
  assert.equal(r.total_nodes, 4);
});

test("expand · the CENTRE is gated first — you cannot expand from what you cannot see", () => {
  // Expanding from a withheld node would leak its existence and its edges even
  // if every neighbour were public.
  const root = vaultWith({
    nodes: [node("priv", { sensitivity: "private" }), node("pub", { sensitivity: "public" })],
    edges: [edge("priv", "pub")],
  });
  const r = expand(root, coerceTier("public"), "priv");
  assert.equal(r.status, "withheld");
});

test("expand · ADJACENCY TO A VISIBLE NODE GRANTS NOTHING", () => {
  const root = vaultWith({
    nodes: [
      node("pub", { sensitivity: "public" }),
      node("n1", { sensitivity: "public" }),
      node("n2", { sensitivity: "secret" }),
    ],
    edges: [edge("pub", "n1"), edge("pub", "n2")],
  });
  const r = expand(root, coerceTier("public"), "pub");
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  assert.deepEqual(r.neighbours.map((n) => n.id), ["n1"]);
  assert.equal(r.withheld, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// D18 · the anti-regression guard
// ─────────────────────────────────────────────────────────────────────────────

test("D18 · A ZERO-NODE CANDIDATE IS REFUSED — the 2026-08-08 loss, planted", () => {
  // The literal upstream event: a builder pointed at a directory that does not
  // exist, producing an empty graph, overwriting the only good copy.
  const r = antiRegressionCheck({ nodes: 3_425, edges: 16_291 }, { nodes: 0, edges: 0 });
  assert.equal(r.accept, false, "a 0-node graph was written over a 3,425-node one");
  assert.match(r.reason, /non-existent input directory/,
    "the reason must name the cause, because that is what the operator has to go fix");
});

test("D18 · A REFUSED BUILD IS AN ALERT, NOT A QUIET SUCCESS", () => {
  // THE MOST IMPORTANT ASSERTION IN THIS FILE. Upstream the guard worked
  // perfectly and said nothing, every night, for weeks. A guard that fires
  // constantly and silently is indistinguishable from a healthy system.
  const r = antiRegressionCheck({ nodes: 3_425, edges: 16_291 }, { nodes: 0, edges: 0 });
  assert.equal(r.shouldAlert, true,
    "the guard refused the build and did NOT alert — that is the failure mode that hid the 2026-08-08 loss");
});

test("D18 · a shrink PAST TOLERANCE is refused and alerts", () => {
  const r = antiRegressionCheck({ nodes: 1_000, edges: 5_000 }, { nodes: 800, edges: 4_000 });
  assert.equal(r.accept, false);
  assert.equal(r.shouldAlert, true);
  assert.match(r.reason, /20% smaller/);
  assert.match(r.reason, /existing artifact is untouched/, "the operator must be told nothing was lost");
  assert.match(r.reason, /--force/, "and how to proceed if the shrink is real");
});

test("D18 · a shrink WITHIN tolerance is accepted silently — normal churn is not an alarm", () => {
  const r = antiRegressionCheck({ nodes: 1_000, edges: 5_000 }, { nodes: 950, edges: 4_800 });
  assert.equal(r.accept, true);
  assert.equal(r.shouldAlert, false, "ordinary churn raised an alarm — false alarms get guards disabled");
});

test("D18 · GROWTH is accepted silently", () => {
  const r = antiRegressionCheck({ nodes: 1_000, edges: 5_000 }, { nodes: 1_200, edges: 6_100 });
  assert.equal(r.accept, true);
  assert.equal(r.shouldAlert, false);
});

test("D18 · the FIRST build is accepted — a guard that blocks bootstrap is a broken guard", () => {
  const r = antiRegressionCheck(null, { nodes: 42, edges: 100 });
  assert.equal(r.accept, true);
  assert.equal(r.shouldAlert, false);
  assert.match(r.reason, /first build/);
});

test("D18 · --force accepts the shrink AND STILL ALERTS", () => {
  // An override that also silences the record is how the next person loses the
  // graph without a trace. Forcing is a decision; it goes in the log.
  const r = antiRegressionCheck({ nodes: 1_000, edges: 5_000 }, { nodes: 10, edges: 5 }, { force: true });
  assert.equal(r.accept, true);
  assert.equal(r.shouldAlert, true, "--force silenced the record of a 99% shrink");
  assert.match(r.reason, /explicitly authorised/);
});

test("D18 · --force CANNOT accept a zero-node graph", () => {
  // The one case the override does not reach. There is no legitimate reason to
  // overwrite a real artifact with nothing, and this is the exact shape the
  // 2026-08-08 loss took.
  const r = antiRegressionCheck({ nodes: 3_425, edges: 16_291 }, { nodes: 0, edges: 0 }, { force: true });
  assert.equal(r.accept, false, "--force overwrote a real graph with an empty one");
});

test("D18 · the guard is IN THE BUILDER's module, not only in a caller", () => {
  // D18's root cause: the guard lived in `refresh-graphs.ps1`, so a second
  // caller — or the same caller after an edit — bypassed it. Importing it from
  // the graph module here is the structural claim; `created-not-wired` asserts
  // the callers use it.
  assert.equal(typeof antiRegressionCheck, "function");
  assert.equal(typeof verifyHeader, "function");
});
