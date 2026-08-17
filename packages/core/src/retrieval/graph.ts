// SPDX-License-Identifier: Apache-2.0
/**
 * DIMAAG · graph reads.
 *
 * The knowledge graph is a DERIVED artifact (invariant 1: caches, indexes,
 * graphs and exports are disposable and rebuildable). Every node carries the
 * tier of the note it came from, and every read here re-applies the gate.
 *
 * ── D13 / I18 · a header that disagrees with its body ──────────────────────
 * `enrich-graph.py` added edges and updated only `meta.enriched`, leaving
 * `meta.edge_count` at its pre-enrich value. Measured on the live export:
 * header 16,291 vs `edges[]` 29,286 — the header was 44% low.
 *
 * It hid because both numbers are individually plausible AND THE CHEAP READER
 * IS THE ONE THAT IS WRONG: the metrics counter deliberately does a 2 KB head
 * read (130 ms vs 1,251 ms for a full parse), so the fix that finally made the
 * graph observable inherited a lying header.
 *
 * `verifyHeader()` below asserts header-vs-body equality, `sutra doctor` runs
 * it, and CI runs it on every derived JSON. The general rule: **a pass that
 * mutates a derived artifact updates every counter that summarises what it
 * mutated** — and prefer counters computed at write time over counters copied
 * forward.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Tier, coerceTier, isDoNotLearn } from "../gate/tiers.js";
import { sensitivityGuard } from "../gate/guard.js";

export const GRAPH_REL = "graph/exports/cytoscape.json";

export interface CyNodeData {
  id: string;
  label?: string;
  path?: string;
  type?: string;
  sensitivity?: string;
  do_not_learn?: unknown;
  community?: number;
  [k: string]: unknown;
}
export interface CyNode { data: CyNodeData }
export interface CyEdgeData { id?: string; source: string; target: string; kind?: string }
export interface CyEdge { data: CyEdgeData }

export interface CytoGraph {
  nodes: CyNode[];
  edges: CyEdge[];
  meta?: {
    node_count?: number;
    edge_count?: number;
    community_count?: number;
    built_at?: string;
    [k: string]: unknown;
  };
}

export interface GraphNodeSummary {
  id: string;
  label: string;
  type: string;
  path?: string;
  sensitivity: Tier;
  degree: number;
}

export type GetGraphResult =
  | { status: "ok"; nodes: GraphNodeSummary[]; edges: number; total_nodes: number; withheld: number }
  | { status: "not_built"; message: string };

const NODE_CAP = 50;

export function loadGraph(vaultRoot: string): CytoGraph | null {
  const path = join(vaultRoot, GRAPH_REL);
  if (!existsSync(path)) return null;
  try {
    const g = JSON.parse(readFileSync(path, "utf8")) as CytoGraph;
    return Array.isArray(g?.nodes) && Array.isArray(g?.edges) ? g : null;
  } catch {
    return null;
  }
}

/**
 * I18 · D13 — assert every header counter equals the collection it summarises.
 *
 * Returns the discrepancies rather than throwing: this runs inside `doctor`,
 * where reporting three problems is more useful than aborting on the first.
 */
export function verifyHeader(graph: CytoGraph): Array<{ counter: string; header: number; actual: number }> {
  const problems: Array<{ counter: string; header: number; actual: number }> = [];
  const meta = graph.meta ?? {};
  if (typeof meta.node_count === "number" && meta.node_count !== graph.nodes.length) {
    problems.push({ counter: "meta.node_count", header: meta.node_count, actual: graph.nodes.length });
  }
  if (typeof meta.edge_count === "number" && meta.edge_count !== graph.edges.length) {
    problems.push({ counter: "meta.edge_count", header: meta.edge_count, actual: graph.edges.length });
  }
  if (typeof meta.community_count === "number") {
    const communities = new Set<number>();
    for (const n of graph.nodes) {
      // A `-1` community means "unassigned"; counting it would mask I6b, where
      // all 679 communities silently degraded to -1 and nothing alerted.
      if (typeof n.data.community === "number" && n.data.community >= 0) communities.add(n.data.community);
    }
    if (meta.community_count !== communities.size) {
      problems.push({ counter: "meta.community_count", header: meta.community_count, actual: communities.size });
    }
  }
  return problems;
}

function nodeVisible(data: CyNodeData, exposure: Tier): boolean {
  if (isDoNotLearn(data as Record<string, unknown>)) return false;
  return sensitivityGuard(coerceTier(data.sensitivity), exposure).allowed;
}

function toSummary(data: CyNodeData, degree: number): GraphNodeSummary {
  const s: GraphNodeSummary = {
    id: data.id,
    label: String(data.label ?? data.id),
    type: String(data.type ?? "Untyped"),
    sensitivity: coerceTier(data.sensitivity),
    degree,
  };
  if (data.path) s.path = String(data.path);
  return s;
}

function degrees(graph: CytoGraph): Map<string, number> {
  const d = new Map<string, number>();
  for (const e of graph.edges) {
    d.set(e.data.source, (d.get(e.data.source) ?? 0) + 1);
    d.set(e.data.target, (d.get(e.data.target) ?? 0) + 1);
  }
  return d;
}

/** The graph's most-connected VISIBLE nodes. Withheld nodes are counted, never returned. */
export function getGraph(vaultRoot: string, exposure: Tier): GetGraphResult {
  const graph = loadGraph(vaultRoot);
  if (!graph) {
    return {
      status: "not_built",
      message: `no graph at ${GRAPH_REL}. Run \`sutra graph export\`. Search and ask work without it.`,
    };
  }
  const deg = degrees(graph);
  const visible: GraphNodeSummary[] = [];
  let withheld = 0;
  for (const n of graph.nodes) {
    if (!nodeVisible(n.data, exposure)) {
      withheld++;
      continue;
    }
    visible.push(toSummary(n.data, deg.get(n.data.id) ?? 0));
  }
  visible.sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id));
  return {
    status: "ok",
    nodes: visible.slice(0, NODE_CAP),
    edges: graph.edges.length,
    total_nodes: graph.nodes.length,
    withheld,
  };
}

export type ExpandGraphResult =
  | { status: "ok"; center: GraphNodeSummary; neighbours: GraphNodeSummary[]; withheld: number }
  | { status: "not_found"; message: string }
  | { status: "withheld"; message: string }
  | { status: "not_built"; message: string };

/**
 * One-hop neighbourhood of a node.
 *
 * The CENTRE is gated first: expanding from a node you cannot see would leak
 * its existence and its edges. Then each neighbour is gated independently —
 * adjacency to a visible node grants nothing.
 */
export function expand(vaultRoot: string, exposure: Tier, nodeId: string): ExpandGraphResult {
  const graph = loadGraph(vaultRoot);
  if (!graph) return { status: "not_built", message: `no graph at ${GRAPH_REL}. Run \`sutra graph export\`.` };

  const byId = new Map(graph.nodes.map((n) => [n.data.id, n.data]));
  const needle = nodeId.trim();
  let center = byId.get(needle);
  if (!center) {
    for (const n of graph.nodes) {
      if (n.data.path === needle || n.data.label === needle) { center = n.data; break; }
    }
  }
  if (!center) return { status: "not_found", message: `no node "${nodeId}" in the graph.` };
  if (!nodeVisible(center, exposure)) {
    return { status: "withheld", message: `node "${nodeId}" is withheld at the current ceiling.` };
  }

  const deg = degrees(graph);
  const neighbourIds = new Set<string>();
  for (const e of graph.edges) {
    if (e.data.source === center.id) neighbourIds.add(e.data.target);
    else if (e.data.target === center.id) neighbourIds.add(e.data.source);
  }

  const neighbours: GraphNodeSummary[] = [];
  let withheld = 0;
  for (const id of neighbourIds) {
    const data = byId.get(id);
    if (!data) continue;
    if (!nodeVisible(data, exposure)) { withheld++; continue; }
    neighbours.push(toSummary(data, deg.get(id) ?? 0));
  }
  neighbours.sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id));

  return {
    status: "ok",
    center: toSummary(center, deg.get(center.id) ?? 0),
    neighbours: neighbours.slice(0, NODE_CAP),
    withheld,
  };
}

/**
 * D18 · THE ANTI-REGRESSION GUARD, INSIDE THE BUILDER.
 *
 * `refresh-graphs.ps1` pointed the builder at a directory that DOES NOT EXIST,
 * so every run rebuilt from nothing. The guard lived only in the CALLER — which
 * is exactly how the 2026-08-08 loss happened.
 *
 * Worse, the guard *worked*: it correctly rejected the empty result, every
 * night, SILENTLY. A guard that fires constantly and says nothing is
 * indistinguishable from a healthy system. So this returns a decision AND a
 * `shouldAlert` flag, and a firing guard is an alert, not a quiet success.
 */
export function antiRegressionCheck(
  existing: { nodes: number; edges: number } | null,
  candidate: { nodes: number; edges: number },
  opts: { shrinkTolerance?: number; force?: boolean } = {},
): { accept: boolean; shouldAlert: boolean; reason: string } {
  const tolerance = opts.shrinkTolerance ?? 0.1;

  if (candidate.nodes === 0) {
    return {
      accept: false,
      shouldAlert: true,
      reason:
        "REFUSING to write a graph with 0 nodes over an existing artifact. A builder pointed at a " +
        "non-existent input directory produces exactly this, and the good artifact is the only copy.",
    };
  }
  if (!existing) {
    return { accept: true, shouldAlert: false, reason: "no existing artifact; first build" };
  }
  if (opts.force) {
    return { accept: true, shouldAlert: true, reason: "accepted under --force; the shrink was explicitly authorised" };
  }

  const shrink = (existing.nodes - candidate.nodes) / Math.max(existing.nodes, 1);
  if (shrink > tolerance) {
    return {
      accept: false,
      shouldAlert: true,
      reason:
        `REFUSING to replace a ${existing.nodes}-node graph with a ${candidate.nodes}-node one ` +
        `(${Math.round(shrink * 100)}% smaller, tolerance ${Math.round(tolerance * 100)}%). ` +
        `Re-run with --force if the shrink is real. The existing artifact is untouched.`,
    };
  }
  return { accept: true, shouldAlert: false, reason: `accepted: ${existing.nodes} → ${candidate.nodes} nodes` };
}
