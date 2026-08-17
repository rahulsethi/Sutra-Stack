// SPDX-License-Identifier: Apache-2.0
/**
 * DIMAAG · hybrid retrieval.
 *
 * Fuses the VECTOR ranking (cosine over the local embedding index) with the
 * BM25 ranking via Reciprocal-Rank Fusion, plus a light recency tie-break, an
 * optional graph-adjacency boost and an optional local cross-encoder rerank
 * (both default OFF).
 *
 * ── THE INVARIANT ──────────────────────────────────────────────────────────
 * The candidate universe is `Brain.visibleCorpus()` — THE SAME GATE as
 * `search` and `get_note`: `do_not_learn` exclusion, `sensitivityGuard` against
 * the ceiling, and live promotions, all computed over LIVE frontmatter.
 *
 * Both rankings are computed only over that gated set, so a fused result can
 * never surface a tier the caller could not already see. The graph boost only
 * re-weights candidates ALREADY in the gated set — it never introduces a node.
 * And step 8 drops any fused id not present in the gated corpus, which is
 * defence in depth against a stale index: an id can enter the ranking from the
 * embedding index (a derived artifact that can lag a re-tier) but it cannot
 * leave this function without being present in the live gated corpus.
 *
 * No hosted egress is required for any of it. Embedding and rerank are local
 * shell-outs that degrade to a no-op when unavailable — which is what makes the
 * keyless first run a real product rather than an apology.
 */

import type { Tier } from "../gate/tiers.js";
import type { Brain, CorpusNote } from "../vault/brain.js";
import { bm25, rrf, cosine, type Bm25Doc, type Scored } from "./lexical.js";
import { loadIndex, embedQuery, callReranker, type EmbeddingIndex } from "./semantic.js";
import { loadGraph, type CytoGraph } from "./graph.js";

export interface HybridHit {
  relPath: string;
  title: string;
  type: string;
  sensitivity: Tier;
  /** Fused RRF score, or the reranker's score when rerank ran. */
  score: number;
  /** Provenance: which ranking(s) produced this hit. Printed by `--json`. */
  via: "vector+bm25" | "vector" | "bm25" | "reranked";
}

export interface HybridOptions {
  rrfK?: number;
  /** Local cross-encoder rerank of the top pool. Default OFF; no-op if the model is absent. */
  rerank?: boolean;
  /** Graph-adjacency boost. Default OFF. */
  graphBoost?: boolean;
}

export interface HybridResult {
  status: "ok";
  hits: HybridHit[];
  scanned: number;
  withheld: number;
  /**
   * WHAT ACTUALLY RAN — not what was configured.
   *
   * D16's lesson in one field: an unconfigured or unavailable component must be
   * REPORTED, never silently dropped. "bm25-only (no vector index)" is a
   * perfectly good answer; pretending it was a vector search is not.
   */
  retrieval: string;
  /** Every component that did not run, and why. Surfaced by `sutra status`. */
  degraded: string[];
}

type RerankFn = (
  installRoot: string,
  q: string,
  cands: Array<{ id: string; text?: string }>,
) => Array<{ id: string; score: number }> | null;

const RERANK_POOL = 20;
const GRAPH_SEED = 5;

export function hybridSearch(
  vaultRoot: string,
  installRoot: string,
  brain: Brain,
  query: string,
  limit = 10,
  opts: HybridOptions = {},
  _injectedVector?: number[] | null,
  _rerankerOverride?: RerankFn,
  _graphOverride?: CytoGraph | null,
): HybridResult {
  const rrfK = opts.rrfK ?? 60;
  const degraded: string[] = [];

  // 1 · The gated corpus — the ONLY candidate universe.
  const { notes: corpus, scanned, withheld } = brain.visibleCorpus();
  const byPath = new Map(corpus.map((c) => [c.relPath, c]));

  // 2 · Vector ranking. Degrades to empty when the index is missing or the
  //     query cannot be embedded — and SAYS SO.
  const vectorRanking = vectorRank(vaultRoot, installRoot, query, byPath, _injectedVector, degraded);

  // 3 · BM25 over the gated corpus (title + body). Always available.
  const bm25Docs: Bm25Doc[] = corpus.map((c) => ({ id: c.relPath, text: `${c.title} ${c.body}` }));
  const bm25Ranking = bm25(query, bm25Docs).map((s) => s.id);

  // 4 · Fuse. With no vector ranking, RRF over one list IS BM25 order.
  const fused = rrf([vectorRanking, bm25Ranking], rrfK);

  const inVector = new Set(vectorRanking);
  const inBm25 = new Set(bm25Ranking);

  // 5 · Recency breaks EXACT ties only. It never reorders distinct scores —
  //     a newer note is not a better answer, it is only a better coin-flip.
  const ranked = [...fused].sort((a, c) => {
    if (c.score !== a.score) return c.score - a.score;
    const rd = recency(byPath.get(c.id)?.updated) - recency(byPath.get(a.id)?.updated);
    return rd !== 0 ? rd : a.id.localeCompare(c.id);
  });

  // 6 · Optional graph boost — re-weights existing candidates only.
  let scoreOf = new Map(ranked.map((r) => [r.id, r.score]));
  if (opts.graphBoost) {
    const boosted = applyGraphBoost(vaultRoot, ranked, byPath, rrfK, _graphOverride, degraded);
    scoreOf = boosted;
    ranked.sort((a, c) => {
      const d = (scoreOf.get(c.id) ?? 0) - (scoreOf.get(a.id) ?? 0);
      if (d !== 0) return d;
      const rd = recency(byPath.get(c.id)?.updated) - recency(byPath.get(a.id)?.updated);
      return rd !== 0 ? rd : a.id.localeCompare(c.id);
    });
  }

  // 7 · Optional local cross-encoder rerank of the top pool.
  let reranked = false;
  let orderedIds = ranked.map((r) => r.id);
  if (opts.rerank) {
    const rr = rerankTop(installRoot, query, orderedIds, byPath, _rerankerOverride);
    if (rr) {
      orderedIds = rr.ids;
      reranked = true;
      for (const [id, s] of rr.scores) scoreOf.set(id, s);
    } else {
      degraded.push("rerank: local cross-encoder unavailable — ranking is fused-only (not an error)");
    }
  }

  // 8 · Materialise. Corpus membership IS gate clearance; anything else drops.
  const hits: HybridHit[] = [];
  for (const id of orderedIds) {
    const note = byPath.get(id);
    if (!note) continue; // defence in depth against a stale index
    hits.push({
      relPath: note.relPath,
      title: note.title,
      type: note.type,
      sensitivity: note.sensitivity,
      score: scoreOf.get(id) ?? 0,
      via: reranked ? "reranked" : provenance(id, inVector, inBm25),
    });
    if (hits.length >= limit) break;
  }

  return {
    status: "ok",
    hits,
    scanned,
    withheld,
    retrieval: vectorRanking.length > 0 ? "vector+bm25" : "bm25-only (no vector index)",
    degraded,
  };
}

function vectorRank(
  vaultRoot: string,
  installRoot: string,
  query: string,
  byPath: Map<string, CorpusNote>,
  injected: number[] | null | undefined,
  degraded: string[],
): string[] {
  const index: EmbeddingIndex | null = loadIndex(vaultRoot);
  if (!index) {
    degraded.push("vector: no embedding index — run `sutra refresh-index`. Lexical retrieval is unaffected.");
    return [];
  }
  const qv = injected === undefined ? embedQuery(installRoot, query) : injected;
  if (!qv) {
    degraded.push("vector: the query could not be embedded (is `uv` installed?) — lexical retrieval only.");
    return [];
  }
  const scored: Scored[] = [];
  for (const n of index.notes) {
    if (!byPath.has(n.relPath)) continue; // withheld or absent → excluded
    scored.push({ id: n.relPath, score: cosine(qv, n.vector) });
  }
  scored.sort((a, c) => c.score - a.score || a.id.localeCompare(c.id));
  return scored.map((s) => s.id);
}

function recency(updated?: string): number {
  if (!updated) return 0;
  const t = Date.parse(updated);
  return Number.isNaN(t) ? 0 : t;
}

function provenance(id: string, inVector: Set<string>, inBm25: Set<string>): "vector+bm25" | "vector" | "bm25" {
  const v = inVector.has(id);
  const k = inBm25.has(id);
  if (v && k) return "vector+bm25";
  if (v) return "vector";
  return "bm25";
}

/**
 * Additive graph-adjacency boost.
 *
 * The bump is deliberately SMALLER than one RRF increment, so it can only nudge
 * near-ties and can never promote an unrelated note above a genuinely better
 * match. A boost large enough to reorder distinct scores would make retrieval
 * quality depend on graph density, which nobody is measuring.
 */
function applyGraphBoost(
  vaultRoot: string,
  ranked: readonly Scored[],
  byPath: Map<string, unknown>,
  rrfK: number,
  graphOverride: CytoGraph | null | undefined,
  degraded: string[],
): Map<string, number> {
  const scoreOf = new Map(ranked.map((r) => [r.id, r.score]));
  const graph = graphOverride === undefined ? loadGraph(vaultRoot) : graphOverride;
  if (!graph) {
    degraded.push("graph-boost: no graph export — run `sutra graph export`.");
    return scoreOf;
  }

  const pathToId = new Map<string, string>();
  const idToPath = new Map<string, string>();
  for (const nd of graph.nodes) {
    const p = nd.data.path ? String(nd.data.path) : undefined;
    if (p) {
      pathToId.set(p, nd.data.id);
      idToPath.set(nd.data.id, p);
    }
  }

  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string): void => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a)!.add(b);
  };
  for (const e of graph.edges) {
    link(e.data.source, e.data.target);
    link(e.data.target, e.data.source);
  }

  const neighbourPaths = new Set<string>();
  for (const sp of ranked.slice(0, GRAPH_SEED).map((r) => r.id)) {
    const sid = pathToId.get(sp);
    if (!sid) continue;
    for (const nid of adj.get(sid) ?? []) {
      const np = idToPath.get(nid);
      if (np) neighbourPaths.add(np);
    }
  }

  const bump = 0.5 / (rrfK + 1);
  for (const r of ranked) {
    if (neighbourPaths.has(r.id) && byPath.has(r.id)) {
      scoreOf.set(r.id, (scoreOf.get(r.id) ?? 0) + bump);
    }
  }
  return scoreOf;
}

function rerankTop(
  installRoot: string,
  query: string,
  orderedIds: readonly string[],
  byPath: Map<string, CorpusNote>,
  override?: RerankFn,
): { ids: string[]; scores: Map<string, number> } | null {
  const pool = orderedIds.slice(0, RERANK_POOL);
  const rest = orderedIds.slice(RERANK_POOL);

  // M6/D1 note: candidates carry the BODY, not just the title. A reranker fed
  // titles is scoring the index, not the content — one of the three divergent
  // retrieval implementations upstream did exactly that.
  const cands = pool.map((id) => {
    const n = byPath.get(id);
    return { id, text: n ? `${n.title}\n\n${n.body}` : "" };
  });

  const fn: RerankFn = override ?? (callReranker as unknown as RerankFn);
  const rr = fn(installRoot, query, cands);
  if (!rr || rr.length === 0) return null;

  const scores = new Map<string, number>();
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const r of rr) {
    if (!byPath.has(r.id) || seen.has(r.id)) continue;
    ids.push(r.id);
    seen.add(r.id);
    scores.set(r.id, r.score);
  }
  for (const id of pool) if (!seen.has(id)) ids.push(id);
  for (const id of rest) ids.push(id);
  return { ids, scores };
}
