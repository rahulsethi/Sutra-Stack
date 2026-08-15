// SPDX-License-Identifier: Apache-2.0
/**
 * BM25 and Reciprocal-Rank Fusion — lifted from `aatma/src/mcp/hybrid.ts`.
 *
 * Two pure, deterministic primitives with no dependencies and no I/O. They are
 * separated from `hybrid.ts` because they are the half of retrieval that ALWAYS
 * works: no index, no model, no network, no keys.
 *
 * That matters more here than it usually would. Sutra's M2 decision is a
 * DETERMINISTIC-ONLY FIRST RUN — a fresh install with no API key must return a
 * grounded, cited answer, not an apology. This file is what makes that possible:
 * BM25 over the gated corpus is a real retrieval system, and it degrades to
 * nothing when the vector index is absent because it never needed one.
 */

/** Lowercase, split on non-alphanumeric, drop 1-char tokens. */
export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

export interface Scored {
  id: string;
  score: number;
}

export interface Bm25Doc {
  id: string;
  text: string;
}

/**
 * Okapi BM25 — the lexical scorer.
 *
 *   idf(t)   = ln(1 + (N - n(t) + 0.5) / (n(t) + 0.5))     [Lucene variant, ≥ 0]
 *   score(d) = Σ_t idf(t) · f(t,d)·(k1+1) / (f(t,d) + k1·(1 - b + b·|d|/avgdl))
 *
 * Only documents with a positive score (at least one query-term hit) are
 * returned, ranked descending. Ties break on id so the ordering is stable across
 * runs and platforms — an unstable ranking makes a retrieval eval unrepeatable,
 * and D39's lesson (a merge that depended on filename order) applies to ranking
 * just as much as to merging.
 */
export function bm25(query: string, docs: readonly Bm25Doc[], k1 = 1.5, b = 0.75): Scored[] {
  const qterms = Array.from(new Set(tokenize(query)));
  if (qterms.length === 0 || docs.length === 0) return [];

  const docTokens = docs.map((d) => tokenize(d.text));
  const lengths = docTokens.map((t) => t.length);
  const N = docs.length;
  const avgdl = lengths.reduce((s, l) => s + l, 0) / N || 0;

  const df = new Map<string, number>();
  for (const t of qterms) df.set(t, 0);
  for (const toks of docTokens) {
    const seen = new Set(toks);
    for (const t of qterms) if (seen.has(t)) df.set(t, df.get(t)! + 1);
  }

  const idf = new Map<string, number>();
  for (const t of qterms) {
    const n = df.get(t)!;
    idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
  }

  const out: Scored[] = [];
  for (let i = 0; i < N; i++) {
    const toks = docTokens[i]!;
    if (toks.length === 0) continue;
    const tf = new Map<string, number>();
    for (const t of toks) if (idf.has(t)) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    const dl = lengths[i]!;
    for (const [t, f] of tf) {
      const numer = f * (k1 + 1);
      const denom = f + k1 * (1 - b + b * (avgdl === 0 ? 0 : dl / avgdl));
      score += idf.get(t)! * (numer / denom);
    }
    if (score > 0) out.push({ id: docs[i]!.id, score });
  }
  out.sort((a, c) => c.score - a.score || a.id.localeCompare(c.id));
  return out;
}

/**
 * Reciprocal-Rank Fusion — combine several ranked id-lists into one.
 *
 *   score(id) = Σ_lists 1 / (k + rank)      [rank is 1-based]
 *
 * k ≈ 60 is the standard constant (Cormack et al. 2009); it dampens top-rank
 * dominance so one confident list cannot bury a second list's consensus.
 *
 * An id absent from a list contributes nothing from that list — which is why
 * fusing [vector, bm25] with an EMPTY vector list yields exactly BM25 order.
 * That is the keyless path, and it is a property of the algorithm rather than a
 * special case in the caller.
 */
export function rrf(rankings: readonly (readonly string[])[], k = 60): Scored[] {
  const scores = new Map<string, number>();
  const order: string[] = [];
  for (const ranking of rankings) {
    for (let r = 0; r < ranking.length; r++) {
      const id = ranking[r]!;
      if (!scores.has(id)) {
        scores.set(id, 0);
        order.push(id);
      }
      scores.set(id, scores.get(id)! + 1 / (k + r + 1));
    }
  }
  return order
    .map((id) => ({ id, score: scores.get(id)! }))
    .sort((a, c) => c.score - a.score || a.id.localeCompare(c.id));
}

/** Cosine similarity. Returns 0 for mismatched or empty vectors, never NaN. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
