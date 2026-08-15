// SPDX-License-Identifier: Apache-2.0
/**
 * QUALITY BANDING — the fix for D21, and the metric that would have caught D1.
 *
 * ── The defect ─────────────────────────────────────────────────────────────
 * The upstream freshness rubric banded 520 of 595 pages "healthy". `Band` was —
 * to within five pages — a RESTATEMENT OF `synthesis_mode == hosted`. It
 * measured whether an LLM ran, and nothing else.
 *
 * 164 of those "healthy" pages had been clipped to 6,000 characters of their
 * source, 56 of them from sources over 25,000 characters. Nothing in the corpus
 * could score above 87, so the rubric could not even separate good from
 * adequate.
 *
 * It hid because it produced a number that went UP when the pipeline ran, which
 * is what a health metric is supposed to do.
 *
 * ── The replacement ────────────────────────────────────────────────────────
 * Band on CAPTURE RATIO — how much of its source a page actually reflects:
 *
 *     ratio ≈ (page words × ~6 chars/word) / extract chars
 *
 * At ≥5,000-word sources the upstream corpus median was **4%**. That number is
 * visible from this metric and invisible from every metric the system had.
 *
 * ── The honest caveat, which ships WITH the metric ─────────────────────────
 * Capture ratio is also a proxy. A page that faithfully summarises a rambling
 * source SHOULD have a low ratio, and a page padded with restatement will score
 * well. So:
 *   - it is a FLOOR for catching truncation, never a target to optimise;
 *   - `blindSpots()` below is returned alongside every band, because publishing
 *     a metric without its blind spots is how the last rubric earned trust it
 *     had not earned;
 *   - real quality is measured by the retrieval eval (`sutra eval`), not here.
 */

/** ~6 characters per word including the space. Deliberately approximate. */
const CHARS_PER_WORD = 6;

export type QualityBand =
  /** No prose. A stub. */
  | "empty"
  /** Prose exists but reflects a small fraction of a large source. THE D1 SIGNATURE. */
  | "thin"
  /** Below the floor, but the source is small enough that it may be complete. */
  | "adequate"
  | "healthy"
  /** The source is unknown, so no ratio can be computed. NOT a score of zero. */
  | "unmeasurable";

export interface QualityAssessment {
  band: QualityBand;
  /** null when the source size is unknown. Never silently 0. */
  capture_ratio: number | null;
  page_words: number;
  source_chars: number | null;
  reason: string;
  blind_spots: string[];
}

/**
 * Count words of HUMAN-MEANINGFUL PROSE.
 *
 * ── D15 · the guard defeated by the pipeline's own output ──────────────────
 * The upstream anti-empty-stub guard stripped headings and known placeholders
 * and required ≥120 characters of residual prose. Its strip list did not remove
 * `## Related` wikilink lines — so SIX MACHINE-GENERATED CROSS-LINKS (~144
 * chars) carried otherwise-empty pages over the floor. 57 empty pages were
 * laundered into `status: active` and indexed as real knowledge.
 *
 * It hid because the guard reported that it was working: its own measurement
 * was contaminated by a LATER pipeline stage's output, which nobody thought of
 * as content.
 *
 * So this strips everything a machine could have written: headings, wikilink-
 * only lines, list items that are only a link, frontmatter, code fences, block
 * quotes, HTML comments, horizontal rules, and italic placeholder lines.
 */
export function proseWords(body: string): number {
  let text = body;

  text = text.replace(/^---\n[\s\S]*?\n---\n/, "");          // frontmatter
  text = text.replace(/```[\s\S]*?```/g, " ");                // fenced code
  text = text.replace(/~~~[\s\S]*?~~~/g, " ");
  text = text.replace(/<!--[\s\S]*?-->/g, " ");               // HTML comments

  const lines = text.split(/\r?\n/).filter((raw) => {
    const line = raw.trim();
    if (line === "") return false;
    if (/^#{1,6}\s/.test(line)) return false;                 // headings
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) return false;    // rules
    if (/^>/.test(line)) return false;                        // block quotes (banners)
    if (/^_.*_$/.test(line)) return false;                    // italic placeholders
    if (/^\|/.test(line)) return false;                       // table rows

    // A line that is ONLY links/wikilinks — the exact D15 case.
    const stripped = line
      .replace(/^[-*+]\s+/, "")
      .replace(/\[\[[^\]]*\]\]/g, "")
      .replace(/\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/https?:\/\/\S+/g, "")
      .replace(/[\s,;·|]/g, "");
    if (stripped.length === 0) return false;

    // A known placeholder.
    if (/^(tbd|todo|n\/a|none|placeholder|\(none\)|—|-)$/i.test(line)) return false;
    return true;
  });

  return lines
    .join(" ")
    .split(/\s+/)
    .filter((w) => /[a-z0-9]/i.test(w)).length;
}

/**
 * Band a page.
 *
 * `sourceChars` is the size of the extract the page was written FROM. When it
 * is unknown the band is `unmeasurable` — NOT `healthy`, and not `thin`. "I
 * cannot measure this" is a third answer, and collapsing it into either of the
 * other two is what D21 did.
 */
export function assessQuality(
  body: string,
  sourceChars: number | null,
  opts: { floorWords?: number; thinRatio?: number; healthyRatio?: number } = {},
): QualityAssessment {
  const floorWords = opts.floorWords ?? 250;
  const thinRatio = opts.thinRatio ?? 0.15;
  const healthyRatio = opts.healthyRatio ?? 0.35;

  const words = proseWords(body);
  const blind_spots = blindSpots();

  if (words < 20) {
    return {
      band: "empty",
      capture_ratio: sourceChars ? (words * CHARS_PER_WORD) / sourceChars : null,
      page_words: words,
      source_chars: sourceChars,
      reason:
        `${words} words of human-meaningful prose after stripping headings, wikilinks, banners and ` +
        `machine-generated cross-links (D15: six cross-links once carried 57 empty pages over the floor).`,
      blind_spots,
    };
  }

  if (sourceChars === null || sourceChars <= 0) {
    return {
      band: "unmeasurable",
      capture_ratio: null,
      page_words: words,
      source_chars: sourceChars,
      reason:
        `${words} words, but the source size is unknown so capture ratio cannot be computed. ` +
        `This is NOT a pass — an unmeasurable page is exactly where a truncated one hides.`,
      blind_spots,
    };
  }

  const ratio = (words * CHARS_PER_WORD) / sourceChars;

  if (ratio < thinRatio) {
    return {
      band: "thin",
      capture_ratio: ratio,
      page_words: words,
      source_chars: sourceChars,
      reason:
        `capture ratio ${(ratio * 100).toFixed(1)}% — this page reflects a small fraction of a ` +
        `${sourceChars.toLocaleString()}-char source. THIS IS THE TRUNCATION SIGNATURE: it is fluent, ` +
        `long enough, and LLM-generated, and it is missing most of its material. Re-synthesise from ` +
        `the full source.`,
      blind_spots,
    };
  }

  if (words < floorWords && sourceChars > 1000) {
    return {
      band: "thin",
      capture_ratio: ratio,
      page_words: words,
      source_chars: sourceChars,
      reason: `${words} words (floor ${floorWords}) while the extract is ${sourceChars.toLocaleString()} chars — I4.`,
      blind_spots,
    };
  }

  if (ratio >= healthyRatio) {
    return {
      band: "healthy", capture_ratio: ratio, page_words: words, source_chars: sourceChars,
      reason: `capture ratio ${(ratio * 100).toFixed(1)}%, ${words} words.`,
      blind_spots,
    };
  }

  return {
    band: "adequate", capture_ratio: ratio, page_words: words, source_chars: sourceChars,
    reason: `capture ratio ${(ratio * 100).toFixed(1)}%, ${words} words — above the truncation floor, below the target.`,
    blind_spots,
  };
}

/**
 * WHAT THIS METRIC CANNOT SEE.
 *
 * Published next to every band, deliberately. The rubric this replaces was
 * trusted because nobody could see what it was blind to; shipping the blind
 * spots is how that does not happen twice.
 */
export function blindSpots(): string[] {
  return [
    "A faithful SUMMARY of a rambling source scores low and is not defective. Capture ratio is a floor for catching truncation, never a target.",
    "A page padded with restatement scores well. Length is not quality.",
    "It cannot detect a page that is complete and WRONG — only one that saw too little. Factual accuracy needs the retrieval eval (`sutra eval`).",
    "It says nothing about whether the SOURCE was worth capturing.",
    "OCR-derived sources can be corrupt in ways that leave the ratio healthy — one live page was fabricated from an extract whose font shifted every glyph 31 code points, deleting every digit (I16).",
  ];
}
