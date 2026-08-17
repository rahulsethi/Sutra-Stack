// SPDX-License-Identifier: Apache-2.0
/**
 * DIMAAG · vector retrieval.
 *
 * The embedding index is a plain JSON file the pipeline builds locally, via a
 * small Python script run through `uv`. No hosted call, no key, no network.
 * If `uv` is absent, or the index has not been built, EVERY function here
 * degrades to a typed "not available" result.
 *
 * ── D16 · degradation must be LOUD ─────────────────────────────────────────
 * The upstream `$isUsable` returned a bare `$false` for BOTH "excluded by
 * policy" and "key not configured", and dropped the provider silently. Rotation
 * *looked* like resilience while two of four hops were the same dead upstream
 * and two were absent keys.
 *
 * So the results here are typed, not nullable: `not_built` and `embed_failed`
 * are different answers with different remedies, and the caller must handle
 * them separately. A `null` return would let both collapse into "no results",
 * which is exactly the conflation D23 is about.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { type Tier, coerceTier, isDoNotLearn } from "../gate/tiers.js";
import { sensitivityGuard } from "../gate/guard.js";
import { cosine } from "./lexical.js";

export const INDEX_REL = "state/index/embeddings.json";
const EMBED_SCRIPT_REL = "automation/scripts/embed/embed.py";

export interface IndexNote {
  relPath: string;
  title: string;
  type?: string;
  sensitivity?: string;
  do_not_learn?: unknown;
  vector: number[];
}

export interface EmbeddingIndex {
  model: string;
  dim: number;
  built_at: string;
  notes: IndexNote[];
}

export type SemanticHit = {
  relPath: string;
  title: string;
  type: string;
  sensitivity: Tier;
  score: number;
};

export type SemanticSearchResult =
  | { status: "ok"; hits: SemanticHit[]; scanned: number; withheld: number; model: string }
  /** No index on disk. Remedy: run `sutra refresh-index`. */
  | { status: "not_built"; message: string }
  /** Index exists; the QUERY could not be embedded. Remedy: install `uv`. */
  | { status: "embed_failed"; message: string };

/** Load the index. Returns null if absent or unparseable — `semanticSearch` maps that to a typed result. */
export function loadIndex(vaultRoot: string): EmbeddingIndex | null {
  const path = join(vaultRoot, INDEX_REL);
  if (!existsSync(path)) return null;
  try {
    const idx = JSON.parse(readFileSync(path, "utf8")) as EmbeddingIndex;
    return Array.isArray(idx?.notes) ? idx : null;
  } catch {
    return null;
  }
}

/** Age of the index in hours, or null. `doctor` reports this; a stale index is a quiet wrongness. */
export function indexAgeHours(vaultRoot: string, now = Date.now()): number | null {
  try {
    return (now - statSync(join(vaultRoot, INDEX_REL)).mtimeMs) / 3600_000;
  } catch {
    return null;
  }
}

let cachedUv: string | null | undefined;

/** Locate `uv`. Cached per process; `null` means embeddings are unavailable on this node. */
export function resolveUv(opts: { refresh?: boolean } = {}): string | null {
  if (!opts.refresh && cachedUv !== undefined) return cachedUv;
  const probe = spawnSync("uv", ["--version"], {
    encoding: "utf8",
    shell: process.platform === "win32",
    timeout: 10_000,
  });
  cachedUv = !probe.error && probe.status === 0 ? "uv" : null;
  return cachedUv;
}

export function resetUvCache(): void {
  cachedUv = undefined;
}

/**
 * Embed one query string locally.
 *
 * The timeout is generous and configurable because the FIRST call on a cold
 * machine downloads the model — a ten-second default would turn a working setup
 * into a mysterious `embed_failed` exactly once, on the user's first try, which
 * is the worst possible moment.
 */
export function embedQuery(installRoot: string, q: string): number[] | null {
  const uv = resolveUv();
  if (!uv) return null;
  const script = join(installRoot, EMBED_SCRIPT_REL);
  if (!existsSync(script)) return null;

  const timeoutMs = Number(process.env["SUTRA_EMBED_TIMEOUT_MS"]) || 120_000;
  const result = spawnSync(uv, ["run", "--quiet", script, "--query", q], {
    encoding: "utf8",
    timeout: timeoutMs,
    shell: false,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as { vector?: number[] };
    return Array.isArray(parsed?.vector) ? parsed.vector : null;
  } catch {
    return null;
  }
}

/**
 * THE GATE, AGAIN, OVER THE INDEX.
 *
 * The embedding index is a DERIVED artifact and can lag the notes: a note
 * re-tiered to secret an hour ago may still sit in an index built yesterday.
 * So visibility is recomputed here from the index entry's own tier fields
 * rather than trusted from the fact that it was indexed.
 *
 * `hybridSearch` goes further and intersects with `Brain.visibleCorpus()` —
 * i.e. with LIVE frontmatter — which is the authoritative check. This function
 * is the belt to that pair of braces, and it is worth keeping: an index built
 * before a re-tier is exactly the situation D14 describes, where content
 * classified once is never re-examined.
 */
function indexNoteVisible(n: IndexNote, exposure: Tier): boolean {
  if (isDoNotLearn(n as unknown as Record<string, unknown>)) return false;
  return sensitivityGuard(coerceTier(n.sensitivity), exposure).allowed;
}

export function semanticSearch(
  vaultRoot: string,
  installRoot: string,
  query: string,
  exposure: Tier,
  limit = 10,
  injectedVector?: number[] | null,
): SemanticSearchResult {
  const index = loadIndex(vaultRoot);
  if (!index) {
    return {
      status: "not_built",
      message:
        `no embedding index at ${INDEX_REL}. Run \`sutra refresh-index\` to build one. ` +
        `Keyword and BM25 retrieval work without it — this only disables VECTOR recall.`,
    };
  }

  const qv = injectedVector === undefined ? embedQuery(installRoot, query) : injectedVector;
  if (!qv) {
    return {
      status: "embed_failed",
      message:
        `the index exists but the query could not be embedded. ` +
        `${resolveUv() ? "The embed script failed — check `automation/scripts/embed/embed.py`." : "`uv` is not installed on this node; it is what runs the local embedding model."} ` +
        `Falling back to lexical retrieval, which is degraded but not broken.`,
    };
  }

  const hits: SemanticHit[] = [];
  let scanned = 0;
  let withheld = 0;
  for (const n of index.notes) {
    scanned++;
    if (!indexNoteVisible(n, exposure)) {
      withheld++;
      continue;
    }
    hits.push({
      relPath: n.relPath,
      title: n.title,
      type: n.type ?? "Untyped",
      sensitivity: coerceTier(n.sensitivity),
      score: cosine(qv, n.vector),
    });
  }
  hits.sort((a, b) => b.score - a.score || a.relPath.localeCompare(b.relPath));
  return { status: "ok", hits: hits.slice(0, limit), scanned, withheld, model: index.model };
}

export interface RerankCandidate {
  id: string;
  text?: string;
}

/** Local cross-encoder rerank. Returns null when unavailable — never throws, never blocks. */
export function callReranker(
  installRoot: string,
  query: string,
  candidates: readonly RerankCandidate[],
): Array<{ id: string; score: number }> | null {
  const uv = resolveUv();
  if (!uv || candidates.length === 0) return null;
  const script = join(installRoot, "automation/scripts/embed/rerank.py");
  if (!existsSync(script)) return null;

  const result = spawnSync(uv, ["run", "--quiet", script], {
    encoding: "utf8",
    input: JSON.stringify({ query, candidates }),
    timeout: Number(process.env["SUTRA_RERANK_TIMEOUT_MS"]) || 60_000,
    shell: false,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as { results?: Array<{ id: string; score: number }> };
    return Array.isArray(parsed?.results) ? parsed.results : null;
  } catch {
    return null;
  }
}
