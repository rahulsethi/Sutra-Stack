// SPDX-License-Identifier: Apache-2.0
/**
 * Egress redaction — third-party-name aliasing + sensitive-number masking.
 * Lifted from `aatma/src/mcp/redact.ts`.
 *
 * TypeScript twin of `automation/scripts/lib/Redact.ps1`. The two must produce
 * IDENTICAL output for identical input; the parity test is the contract.
 *
 * ── SHIPS EMPTY, AND THAT IS THE POINT ─────────────────────────────────────
 * The alias map is a list of real third-party names. In the system this was
 * extracted from it named a national oil company and two pharmaceutical firms.
 * It is `local_only` by nature and must never ship populated — the leak scan
 * asserts `automation/config/redaction-aliases.json` is empty, and CI fails if
 * it is not.
 *
 * ── D38 · why this exists at all, separately from tier ─────────────────────
 * A sweep of the upstream corpus found 27 files at hosted-egress tier naming
 * real customers, with substantive delivery detail. Every gate did exactly what
 * it was told. The defect is that **tier encodes "may this leave the machine",
 * not "whose information is this"**, and those two questions have different
 * answers. Personal-sensitivity heuristics — keys, PII, health — never fire on
 * a client name, which is not sensitive *to the author* at all.
 *
 * So third-party identifiability is a SEPARATE, ORTHOGONAL axis (I21), and its
 * default remedy is to generalise in place, not to re-tier: re-tiering silently
 * degrades whatever lane was built on the material, turning a governance fix
 * into a functional regression. Hence warn-not-block, and hence this module
 * aliases on the way out rather than reclassifying at rest.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface RedactionEntry {
  /** What the name is replaced WITH — e.g. "a European pharmaceutical company". */
  alias: string;
  /** Every spelling of the name that should be replaced. */
  match: string[];
}

export interface RedactionResult {
  text: string;
  /** How many substitutions were made. Zero is a normal, common answer. */
  count: number;
}

export const ALIAS_MAP_REL = "automation/config/redaction-aliases.json";

/**
 * Load the alias map. Returns `[]` on ANY error — a missing or malformed map
 * means "no aliasing", never an exception. Redaction failing loudly at egress
 * time would push callers toward skipping it.
 *
 * Note the asymmetry with `loadPatternSet`, which throws on a missing file:
 * there, an empty rule set silently declares everything safe (dangerous);
 * here, an empty map declares nothing aliased (merely unhelpful), and the tier
 * gate is still doing the actual protecting.
 */
export function loadRedactionMap(root: string): RedactionEntry[] {
  const mapPath = join(root, ALIAS_MAP_REL);
  if (!existsSync(mapPath)) return [];
  try {
    const raw = readFileSync(mapPath, "utf8").trim();
    if (!raw || raw === "[]") return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as RedactionEntry[];
    // Tolerate the object form `{ aliases: [...] }`, which is what the leak scan checks.
    if (parsed && Array.isArray(parsed.aliases)) return parsed.aliases as RedactionEntry[];
    return [];
  } catch {
    return [];
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile the alias map to one regex.
 *
 * Two subtleties, both load-bearing:
 *
 *  - **Longest match first.** "Merck KGaA" must win over "Merck", or the
 *    longer name is half-redacted into something still identifying.
 *
 *  - **Unicode word boundaries.** JavaScript's `\b` is ASCII-only, so a
 *    standalone accented name — Nestlé, Société Générale — would leak straight
 *    through to a hosted surface. The lookaround over `\p{L}\p{N}_` with the
 *    `u` flag replicates .NET's `\b`, which is what the PowerShell twin uses.
 *    This is exactly the kind of divergence between two implementations of one
 *    rule that ROADMAP E1 is about.
 */
function buildRegex(
  entries: readonly RedactionEntry[],
): { regex: RegExp; lookup: Map<string, string> } | null {
  if (!entries.length) return null;

  const pairs: Array<{ term: string; alias: string }> = [];
  for (const entry of entries) {
    for (const term of entry.match ?? []) {
      if (term) pairs.push({ term, alias: entry.alias });
    }
  }
  if (!pairs.length) return null;

  pairs.sort((a, b) => b.term.length - a.term.length);

  const alts = pairs.map(
    (p) => `(?<![\\p{L}\\p{N}_])${escapeRegex(p.term)}(?![\\p{L}\\p{N}_])`,
  );
  const regex = new RegExp(alts.join("|"), "giu");

  const lookup = new Map<string, string>();
  for (const p of pairs) {
    const key = p.term.toLowerCase();
    if (!lookup.has(key)) lookup.set(key, p.alias);
  }
  return { regex, lookup };
}

interface MaskPattern {
  name: string;
  pattern: RegExp;
}

/**
 * Maskable sensitive-number shapes. Mirrors `Get-SensitiveNumberPatterns`
 * (Maskable=true) in `Classify.ps1`, IN THE SAME ORDER — first pattern wins on
 * overlap, so government IDs must precede the generic long-digit catch-all or
 * a PAN would be masked by the wrong rule and the two implementations would
 * diverge on output.
 */
const MASK_PATTERNS: MaskPattern[] = [
  { name: "pan-india", pattern: /(?<![A-Z0-9])[A-Z]{5}\d{4}[A-Z](?![A-Z0-9])/g },
  { name: "aadhaar", pattern: /(?<!\d)\d{4}[\s-]?\d{4}[\s-]?\d{4}(?!\d)/g },
  { name: "passport", pattern: /(?<![A-Z0-9])[A-Z][1-9]\d{7}(?![A-Z0-9])/g },
  {
    name: "credit-card",
    pattern: /(?<!\d)(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2}|6(?:011|5\d{2}))[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}(?!\d)/gi,
  },
  { name: "iban", pattern: /(?<![A-Z0-9])[A-Z]{2}\d{2}[A-Z0-9]{4}\d{7,}(?![A-Z0-9])/g },
  {
    name: "bank-account-long",
    pattern: /(?:account|acct|a\/c)\s*(?:no\.?|number|#)?\s*[:\-]?\s*(?<!\d)\d{9,18}(?!\d)/gi,
  },
  // LAST, deliberately: the catch-all must not pre-empt the specific shapes above.
  { name: "unlabelled-long-digits", pattern: /(?<!\d)\d{11,18}(?!\d)/g },
];

/**
 * Mask sensitive number shapes for egress. The last four digit POSITIONS are
 * kept (enough to recognise your own card); everything before becomes `X`.
 * Separators pass through unchanged, so the shape stays readable.
 *
 * Never throws. PowerShell twin: `Mask-SensitiveNumbers` in `Classify.ps1`.
 */
export function maskSensitiveNumbers(text: string): string {
  if (!text) return text;
  let result = text;

  for (const { pattern } of MASK_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, (match: string) => {
      const digitPositions: number[] = [];
      for (let i = 0; i < match.length; i++) {
        const c = match[i]!;
        if (c >= "0" && c <= "9") digitPositions.push(i);
      }
      if (digitPositions.length <= 4) return match;

      const keepFrom = digitPositions.length - 4;
      let out = "";
      let dCount = 0;
      for (let i = 0; i < match.length; i++) {
        const c = match[i]!;
        if (c >= "0" && c <= "9") {
          out += dCount < keepFrom ? "X" : c;
          dCount++;
        } else {
          out += c;
        }
      }
      return out;
    });
    pattern.lastIndex = 0;
  }
  return result;
}

/**
 * Apply the alias map, then mask sensitive numbers. Order matters: aliasing
 * first, because an alias may itself contain digits that should then be masked.
 *
 * Second argument accepts:
 *   - `RedactionEntry[]` — pre-loaded (use this from a long-running server; it
 *     avoids re-reading the file on every call)
 *   - `string` — an explicit path to the map
 *   - omitted — no aliasing, masking only
 */
export function redactText(
  text: string,
  mapOrPath?: string | readonly RedactionEntry[],
): RedactionResult {
  let entries: readonly RedactionEntry[];

  if (Array.isArray(mapOrPath)) {
    entries = mapOrPath;
  } else if (typeof mapOrPath === "string") {
    if (!existsSync(mapOrPath)) return { text: maskSensitiveNumbers(text), count: 0 };
    try {
      const raw = readFileSync(mapOrPath, "utf8").trim();
      if (!raw || raw === "[]") return { text: maskSensitiveNumbers(text), count: 0 };
      const parsed = JSON.parse(raw);
      entries = Array.isArray(parsed) ? parsed : (parsed?.aliases ?? []);
    } catch {
      return { text: maskSensitiveNumbers(text), count: 0 };
    }
  } else {
    entries = [];
  }

  if (!entries.length) return { text: maskSensitiveNumbers(text), count: 0 };

  const built = buildRegex(entries);
  if (!built) return { text: maskSensitiveNumbers(text), count: 0 };

  const { regex, lookup } = built;
  let count = 0;
  const aliased = text.replace(regex, (match) => {
    count++;
    return lookup.get(match.toLowerCase()) ?? match;
  });

  return { text: maskSensitiveNumbers(aliased), count };
}

/**
 * I21 · D38 — third-party identifiability, assessed SEPARATELY from sensitivity.
 *
 * Answers "is this mine to send?", which tier never asks. Deliberately
 * WARN-ONLY and non-mutating: it reports, it does not re-tier. The correct
 * remedy is almost always to generalise the text in place, and auto-remediation
 * would silently break whatever surface was built on that material.
 *
 * An unconfigured deployment is SILENT — a fresh install must produce no false
 * positives, or the check gets ignored on day one.
 */
export function findNamedThirdParties(
  text: string,
  entries: readonly RedactionEntry[],
): Array<{ alias: string; matched: string; remedy: string }> {
  if (!entries.length) return []; // unconfigured → silent, by design
  const built = buildRegex(entries);
  if (!built) return [];
  const { regex, lookup } = built;
  const found = new Map<string, { alias: string; matched: string; remedy: string }>();
  regex.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    const alias = lookup.get(m[0].toLowerCase()) ?? "(unmapped)";
    if (!found.has(m[0].toLowerCase())) {
      found.set(m[0].toLowerCase(), {
        alias,
        matched: m[0],
        remedy: `generalise in place — replace "${m[0]}" with "${alias}". Do NOT re-tier: ` +
          `re-tiering degrades whatever lane was built on this material.`,
      });
    }
    if (regex.lastIndex === m.index) regex.lastIndex++;
  }
  return [...found.values()];
}
