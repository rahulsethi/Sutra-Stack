// SPDX-License-Identifier: Apache-2.0
/**
 * DIMAAG · section-level reads.
 *
 * PURE STRING LOGIC. No vault access and no sensitivity gating live here: the
 * gate is applied UPSTREAM by `Brain.getNote()` before a body ever reaches this
 * module, so a section-anchored read inherits exactly the same gate as a
 * full-note read.
 *
 * That separation is deliberate and worth preserving. A gate re-implemented at
 * a second read path is a gate that will eventually diverge from the first —
 * ROADMAP E1 counted six such re-implementations upstream, and every divergence
 * failed open in at least one of them.
 */

export interface Heading {
  /** 1..6 — the number of leading `#`. */
  level: number;
  text: string;
  /** 0-based index of the heading line in the source. */
  line: number;
}

/** GitHub-style anchor slug: lowercase, punctuation stripped, spaces → hyphens. */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeHeading(s: string): string {
  return s.replace(/^#+\s*/, "").trim().toLowerCase();
}

/**
 * List ATX headings, SKIPPING FENCED CODE BLOCKS.
 *
 * The fence tracking is not decoration: a `# comment` inside a shell snippet
 * would otherwise be read as a section boundary, and `read_section` would
 * return a fragment that stops in the middle of a code block — quietly, with no
 * error, and looking like the note itself was malformed.
 */
export function listHeadings(body: string): Heading[] {
  const lines = body.split(/\r?\n/);
  const out: Heading[] = [];
  let fenceChar: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const ch = fence[1]![0]!;
      if (fenceChar === null) fenceChar = ch;
      else if (ch === fenceChar) fenceChar = null;
      continue;
    }
    if (fenceChar !== null) continue;
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) out.push({ level: h[1]!.length, text: h[2]!.trim(), line: i });
  }
  return out;
}

/**
 * Return the requested section: its heading line plus everything up to (but not
 * including) the next heading of the SAME-OR-HIGHER level.
 *
 * Matched by exact heading text (case-insensitive) OR by anchor slug, so both
 * "Architecture" and "architecture" resolve.
 *
 * On a miss it hands back the note's headings, so the caller can guide a retry
 * rather than the model guessing again. A bare "not found" for a section read
 * costs a whole extra round trip and usually a second wrong guess.
 */
export function extractSection(
  body: string,
  query: string,
):
  | { status: "ok"; heading: string; section: string }
  | { status: "not_found"; headings: Heading[] } {
  const headings = listHeadings(body);
  const wantedText = normalizeHeading(query);
  const wantedSlug = slugify(query);

  const idx = headings.findIndex(
    (h) => normalizeHeading(h.text) === wantedText || slugify(h.text) === wantedSlug,
  );
  if (idx === -1) return { status: "not_found", headings };

  const start = headings[idx]!;
  const lines = body.split(/\r?\n/);
  let endLine = lines.length;
  for (let j = idx + 1; j < headings.length; j++) {
    if (headings[j]!.level <= start.level) {
      endLine = headings[j]!.line;
      break;
    }
  }
  const section = lines.slice(start.line, endLine).join("\n").replace(/\s+$/, "");
  return { status: "ok", heading: start.text, section };
}
