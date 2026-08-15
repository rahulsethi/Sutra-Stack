// SPDX-License-Identifier: Apache-2.0
/**
 * THE ANSWER PATH — and the single most consequential product decision in v1.0.
 *
 * ── THE DECISION (BUILD-PLAN.md M2, taken 2026-08-15) ──────────────────────
 * A fresh install with NO API KEY returns a grounded, cited answer built
 * deterministically from the gated corpus — and names exactly what a key would
 * improve. Not an error. Not an apology. Not a bundled model with a hardware
 * floor. Not a shared free-tier quota that dies the moment the project is
 * popular.
 *
 * The alternatives and their costs are recorded in BUILD-PLAN.md §M2. This one
 * was chosen because it is honest, costs nothing, works offline forever, and
 * degrades in the one direction that never breaks: an answer assembled from
 * real sources with real citations is USEFUL even when it is not fluent.
 *
 * ── D1 · NO INPUT CLIP. ANYWHERE. EVER. ────────────────────────────────────
 * This is the most damaging defect the upstream audit found, and the one this
 * file exists to make structurally impossible.
 *
 * `backfill-synthesis.ps1:35` truncated every source to 6,000 characters before
 * sending it to the model. That one line produced 424 of the 595 pages in the
 * corpus. The median page saw **38%** of its material; p25 saw 19%; the worst
 * saw **1.2%**.
 *
 * It did not produce SHORT pages. It produced confident, fluent,
 * correctly-formatted 400-word pages that are wrong in specifics — page length
 * was flat at ~406–470 words across TWO ORDERS OF MAGNITUDE of source size, so
 * nothing in the corpus looked anomalous, and the freshness rubric scored 164 of
 * them "healthy". Documented damage: a twelve-week plan described throughout as
 * "an eight-week period"; a product line's speaker matrix asserted wrongly; a
 * page fabricated wholesale from a corrupt OCR extract.
 *
 * The rules that follow, enforced below:
 *   1. If a source exceeds the provider's window, CHUNK-AND-MERGE or REFUSE.
 *      Never silently prefix.
 *   2. Record `source_chars_seen` and `source_chars_total` on every generated
 *      artifact, so truncation is a FACT ON THE ARTIFACT rather than an
 *      inference someone has to go looking for.
 *   3. `tests/defects/no-input-clip.test.ts` greps the tree for `slice(0,` and
 *      `Substring(0,` applied to a source body, and fails the build.
 */

import { type Tier, TIER_DISPLAY } from "../gate/tiers.js";
import type { Brain } from "../vault/brain.js";
import { hybridSearch, type HybridOptions } from "./hybrid.js";

export interface AskSource {
  n: number;
  relPath: string;
  title: string;
  tier: string;
  via: string;
  /** D1 — how much of this source the answer actually saw. */
  chars_seen: number;
  chars_total: number;
}

export type SynthesisMode =
  /** No model ran. The answer IS the cited context. Honest and useful. */
  | "deterministic"
  /** A local, on-machine model ran. */
  | "local"
  /** A hosted model ran. Only reachable for content at hosted_allowed tier. */
  | "hosted";

export interface AskResult {
  ok: true;
  question: string;
  /** The ceiling this answer was computed at. Always reported. */
  exposure: Tier;
  exposure_display: string;
  retrieval_mode: string;
  synthesis_mode: SynthesisMode;
  /** The synthesised prose, or null when no model ran. */
  answer: string | null;
  /** The cited source material. ALWAYS present — this is the deterministic floor. */
  context_block: string;
  sources: AskSource[];
  /** Counts, never content. */
  scanned: number;
  withheld: number;
  /**
   * WHAT DID NOT RUN, AND WHY. Never empty when something degraded.
   *
   * "Degradation is allowed. Silent degradation is not." A keyless run is a
   * legitimate, supported mode — and it says so, every time, in a sentence
   * naming the exact remedy.
   */
  degraded: string[];
  /** D1 — aggregate capture ratio for this answer. */
  source_chars_seen: number;
  source_chars_total: number;
}

/**
 * A synthesis function, injected. The core never talks to a model itself: the
 * provider chain lives in `automation/scripts/provider/`, and a harness may
 * supply its own model instead.
 *
 * The contract is deliberately awkward in one way: it receives the FULL bodies,
 * as an array, and must return either an answer or a refusal. It is not handed
 * a pre-joined string, because a pre-joined string is a thing somebody
 * eventually truncates.
 */
export type SynthesizeFn = (input: {
  question: string;
  sources: Array<{ title: string; relPath: string; body: string }>;
  exposure: Tier;
}) => { answer: string; mode: "local" | "hosted" } | { refused: string } | null;

export interface AskOptions extends HybridOptions {
  k?: number;
  synthesize?: SynthesizeFn;
  /**
   * The provider's context window in characters, if known.
   *
   * D1's rule 1 in one parameter: when the assembled sources exceed it, this
   * function REDUCES THE NUMBER OF SOURCES — dropping whole, lowest-ranked
   * documents and SAYING SO — rather than truncating the text of any one of
   * them. Dropping source #6 entirely is honest and visible; showing the model
   * 38% of source #1 is neither.
   */
  contextWindowChars?: number;
}

/**
 * Ask the vault a question.
 *
 * Order: gated retrieval → cited context block → optional synthesis. The
 * context block is built BEFORE any model is consulted and is returned whether
 * or not one runs, so the deterministic answer is the floor rather than the
 * fallback.
 */
export function ask(
  vaultRoot: string,
  installRoot: string,
  brain: Brain,
  question: string,
  opts: AskOptions = {},
): AskResult {
  const k = opts.k ?? 6;
  const degraded: string[] = [];

  const hybridOpts: HybridOptions = {};
  if (opts.rrfK !== undefined) hybridOpts.rrfK = opts.rrfK;
  if (opts.rerank !== undefined) hybridOpts.rerank = opts.rerank;
  if (opts.graphBoost !== undefined) hybridOpts.graphBoost = opts.graphBoost;

  const retrieval = hybridSearch(vaultRoot, installRoot, brain, question, k, hybridOpts);
  degraded.push(...retrieval.degraded);

  // Materialise the full bodies. NOTHING is truncated here.
  const picked: Array<{ hit: (typeof retrieval.hits)[number]; body: string }> = [];
  for (const hit of retrieval.hits) {
    const note = brain.getNote(hit.relPath);
    if (note.status !== "ok") continue; // re-gated; a race can only ever remove
    picked.push({ hit, body: note.note.body });
  }

  // D1 rule 1 — fit by DROPPING WHOLE SOURCES, never by truncating one.
  const window = opts.contextWindowChars;
  let kept = picked;
  if (window && window > 0) {
    kept = [];
    let used = 0;
    for (const p of picked) {
      const cost = p.body.length + p.hit.title.length + 64;
      if (used + cost > window && kept.length > 0) {
        degraded.push(
          `context window: dropped ${picked.length - kept.length} lower-ranked source(s) whole to fit ` +
          `${window} chars. NOTHING was truncated — a partially-seen source produces a confident, ` +
          `fluent, wrong answer (D1), which is worse than a narrower one.`,
        );
        break;
      }
      kept.push(p);
      used += cost;
    }
  }

  const sources: AskSource[] = kept.map((p, i) => ({
    n: i + 1,
    relPath: p.hit.relPath,
    title: p.hit.title,
    tier: TIER_DISPLAY[p.hit.sensitivity],
    via: p.hit.via,
    // Whole bodies go to synthesis, so seen === total. If these ever differ,
    // something truncated, and the artifact says so on its face.
    chars_seen: p.body.length,
    chars_total: p.body.length,
  }));

  const contextBlock = buildContextBlock(question, kept, brain.exposure, retrieval.withheld);

  let answer: string | null = null;
  let mode: SynthesisMode = "deterministic";

  if (opts.synthesize && kept.length > 0) {
    const out = opts.synthesize({
      question,
      sources: kept.map((p) => ({ title: p.hit.title, relPath: p.hit.relPath, body: p.body })),
      exposure: brain.exposure,
    });
    if (out && "answer" in out) {
      answer = out.answer;
      mode = out.mode;
    } else if (out && "refused" in out) {
      // D2's "refuse-don't-stub": a failed synthesis leaves the deterministic
      // answer intact rather than replacing it with something worse.
      degraded.push(`synthesis refused: ${out.refused}. The cited context block below is the answer.`);
    } else {
      degraded.push(
        "synthesis: no model answered. The cited context block below IS the answer — it is grounded " +
        "in your own notes and every claim is traceable. Configure a provider (`sutra doctor`) or " +
        "install a local model for prose synthesis on top of it.",
      );
    }
  } else if (!opts.synthesize) {
    degraded.push(
      "synthesis: no provider configured — running DETERMINISTIC-ONLY. This is a supported mode, " +
      "not a failure: retrieval, tiering, linking and citation all work with zero keys and zero " +
      "network. A model would add prose synthesis over these same sources, nothing more.",
    );
  }

  if (kept.length === 0) {
    degraded.push(
      retrieval.scanned === 0
        ? "the vault is empty — capture something first (`sutra capture \"…\"`)."
        : `no source matched at the current ceiling (${TIER_DISPLAY[brain.exposure]}). ` +
          `${retrieval.withheld} note(s) were withheld; \`sutra gate\` shows the breakdown.`,
    );
  }

  const seen = sources.reduce((s, x) => s + x.chars_seen, 0);
  const total = sources.reduce((s, x) => s + x.chars_total, 0);

  return {
    ok: true,
    question,
    exposure: brain.exposure,
    exposure_display: TIER_DISPLAY[brain.exposure],
    retrieval_mode: retrieval.retrieval,
    synthesis_mode: mode,
    answer,
    context_block: contextBlock,
    sources,
    scanned: retrieval.scanned,
    withheld: retrieval.withheld,
    degraded,
    source_chars_seen: seen,
    source_chars_total: total,
  };
}

/**
 * The cited context block — THE DETERMINISTIC ANSWER.
 *
 * Not a prompt, and not a fallback. It is what a person actually wants most of
 * the time: the relevant passages from their own notes, each labelled with its
 * source and tier, in relevance order, with the withheld count stated so they
 * know the shape of what they are not seeing.
 *
 * Every claim is traceable by construction, because every line came from a file
 * whose path is printed next to it. That property is the thing a synthesised
 * paragraph can only approximate — which is why this block is returned even
 * when a model DID run.
 */
function buildContextBlock(
  question: string,
  picked: ReadonlyArray<{ hit: { relPath: string; title: string; sensitivity: Tier; via: string }; body: string }>,
  exposure: Tier,
  withheld: number,
): string {
  const lines: string[] = [];
  lines.push(`## Sources for: ${question}`);
  lines.push("");
  lines.push(
    `_Ceiling: **${TIER_DISPLAY[exposure]}**. ${picked.length} source(s) shown` +
    (withheld > 0 ? `, ${withheld} withheld by the gate.` : "."),
  );
  lines.push("");

  if (picked.length === 0) {
    lines.push("_No source in this vault matched, at this ceiling._");
    return lines.join("\n");
  }

  picked.forEach((p, i) => {
    lines.push(`### [${i + 1}] ${p.hit.title}`);
    lines.push(`\`${p.hit.relPath}\` · tier: ${TIER_DISPLAY[p.hit.sensitivity]} · matched via: ${p.hit.via}`);
    lines.push("");
    lines.push(excerpt(p.body, question));
    lines.push("");
  });

  return lines.join("\n").trimEnd();
}

/**
 * Select the passages of a body that bear on the question.
 *
 * ── This is NOT the D1 clip, and the difference is the whole point ─────────
 * D1 was a BLIND PREFIX applied on the way INTO a model: take the first 6,000
 * characters and hope. This is a RELEVANCE SELECTION applied on the way OUT to
 * a human, over paragraphs actually containing the query terms, and it is
 * clearly labelled where it skips.
 *
 * Three properties keep it honest:
 *   - it selects by MATCH, never by position;
 *   - it says "… N paragraphs not shown …" wherever it skips, so the reader
 *     knows the document continues;
 *   - the full body still goes to synthesis untouched — `ask()` passes
 *     `p.body`, not this. Nothing a model sees is ever narrowed here.
 */
function excerpt(body: string, question: string, maxParagraphs = 6): string {
  const paras = body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (paras.length <= maxParagraphs) return paras.join("\n\n");

  const terms = question.toLowerCase().split(/[^a-z0-9]+/i).filter((t) => t.length > 2);
  const scored = paras.map((p, i) => {
    const low = p.toLowerCase();
    let score = 0;
    for (const t of terms) if (low.includes(t)) score++;
    return { i, p, score };
  });

  const chosen = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, maxParagraphs)
    .sort((a, b) => a.i - b.i);

  // Nothing matched: show the opening, and SAY that is what happened.
  if (chosen.length === 0) {
    return (
      paras.slice(0, maxParagraphs).join("\n\n") +
      `\n\n_… ${paras.length - maxParagraphs} further paragraph(s) not shown; no query term matched, ` +
      `so the opening is shown instead._`
    );
  }

  const out: string[] = [];
  let prev = -1;
  for (const c of chosen) {
    if (prev >= 0 && c.i > prev + 1) out.push(`_… ${c.i - prev - 1} paragraph(s) not shown …_`);
    out.push(c.p);
    prev = c.i;
  }
  if (prev < paras.length - 1) out.push(`_… ${paras.length - 1 - prev} paragraph(s) not shown …_`);
  return out.join("\n\n");
}
