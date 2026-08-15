// SPDX-License-Identifier: Apache-2.0
/**
 * THE CLASSIFIER — the third of the four secret-floor enforcement points.
 *
 * This module is mostly new code, and it is the one place in the extraction
 * where "lift, don't rebuild" did not apply: the upstream classifier had three
 * independent defects that were each individually sufficient to let a plaintext
 * credential sit at hosted-egress tier, and thirteen source documents did
 * exactly that.
 *
 * What it fixes, and why each is a rule rather than a patch:
 *
 * ── D5 · `sk-[A-Za-z0-9]{20,}` cannot match `sk-proj-` or `sk-ant-` ────────
 * The hyphen ends the character run after three characters, so the flagship
 * OpenAI and Anthropic key shapes were structurally unmatchable — and there was
 * no rule at all for nvapi-, gsk_, AIza, github_pat_, hf_, Telegram or
 * AGE-SECRET-KEY-1. The pattern *looks* right, and it does match legacy `sk-`
 * keys, so tests written from the same mental model passed.
 *   → RULE: the pattern list is DERIVED FROM THE PROVIDER REGISTRY the product
 *     ships. If a provider is configurable, its key shape is in the scanner,
 *     and CI asserts the two stay in step.
 *
 * ── D4 · the path-based floor band was dead code ───────────────────────────
 * `_FloorPathPrefixes` matched `identity/accounts` with StartsWith against a
 * PARA-NUMBERED vault (`11-identity/…`). No real path could ever match, so one
 * of the three secret-floor layers had never once fired. Nothing counted how
 * often a rule fired, and a rule that fires zero times looks exactly like a
 * rule protecting a clean corpus.
 *   → RULE: matching is segment-based and number-prefix-insensitive, every rule
 *     ships with a fixture it MUST match, and hit counts are recorded so a
 *     permanently-cold rule is visible in `sutra doctor`.
 *
 * ── D14 / I16 · OCR is where credentials arrive ────────────────────────────
 * Every one of the worst cases entered as an IMAGE OF TEXT — a PDF or OneNote
 * export through Tesseract — i.e. exactly where no human ever reads the result.
 *   → RULE: an OCR-derived extract is floored MORE conservatively than typed
 *     text, the engine is recorded on the extract and is an input to the
 *     classifier, and OCR output is never eligible for a hosted route on an
 *     ingest-time tier alone.
 *
 * ── D14 / I15 · classification happens once ────────────────────────────────
 * Content classified under an older pattern set is never re-examined, so the
 * pattern fixes above would change NOTHING retroactively. This is the
 * credential incident's own durable lesson and its only unfixed root cause.
 *   → RULE: the active pattern set is content-hashed; the hash is stamped on
 *     the corpus at each full scan; a mismatch blocks a release until
 *     `sutra rescan` completes. Ship the re-scan trigger, not just a longer list.
 *
 * ── D24 / I17 · a fuzzy rule that blocks a commit ──────────────────────────
 * `generic-api-key-kv` cannot distinguish `password=dbutler_prod_9x2Kq` (a real
 * secret) from `password=db_password` (a variable reference) — structurally
 * identical, so no regex separates them. Blocking on it is how a hook earns a
 * `--no-verify` habit; the upstream repo accumulated 128 of them across 91
 * files, and thereby kept the *belief* that its commits were scanned.
 *   → RULE: every rule declares a band. `heuristic` may raise a tier, annotate,
 *     or warn — never fail a commit. Only `definite` may block.
 */

import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { type Tier, coerceTier, raiseOnly, UNLABELLED_TIER } from "./tiers.js";

export type Band = "definite" | "heuristic";

export interface SecretRule {
  id: string;
  band: Band;
  pattern: string;
  provider: string | null;
  description: string;
  /** A string this rule MUST match. D4: positive coverage is asserted, not assumed. */
  fixture: string;
}

export interface PatternSet {
  version: number;
  rules: SecretRule[];
  floor_paths: string[];
  ocr_engines: string[];
  ocr_floor_tier: Tier;
  benign: string[];
}

export interface CompiledRule extends SecretRule {
  re: RegExp;
}

export interface CompiledPatternSet {
  version: number;
  rules: CompiledRule[];
  floorPaths: string[];
  ocrEngines: Set<string>;
  ocrFloorTier: Tier;
  benign: string[];
  /**
   * I15 — the content hash of the pattern file. Stamp this on the corpus at
   * each full scan; a mismatch means the list improved and nothing was
   * re-examined, which is precisely how thirteen credential-bearing sources
   * stayed invisible.
   */
  hash: string;
}

/**
 * The pattern strings are shared verbatim with the PowerShell scanner and the
 * Python tooling, which use inline `(?i)`. JavaScript's RegExp has no inline
 * flags, so translate rather than maintaining two divergent lists — divergence
 * between re-implementations of one rule is the exact failure ROADMAP E1 names.
 */
export function toJsRegExp(pattern: string, extraFlags = "g"): RegExp {
  let flags = extraFlags;
  let body = pattern;
  const inline = /^\(\?([ims]+)\)/.exec(body);
  if (inline) {
    body = body.slice(inline[0].length);
    for (const f of inline[1]!) if (!flags.includes(f)) flags += f;
  }
  return new RegExp(body, flags);
}

/** Default location of the pattern set, relative to a vault or install root. */
export const PATTERN_SET_REL = "automation/policies/secret-patterns.json";

const cache = new Map<string, CompiledPatternSet>();

/**
 * Load and compile the pattern set. Cached by absolute path — the file is read
 * once per process, because the classifier runs per-note over a whole corpus.
 *
 * FAILS CLOSED AND LOUD. A missing or unparseable pattern file throws rather
 * than returning an empty rule set: a scanner that silently has no rules
 * reports every file clean, which is the most dangerous possible failure for
 * this particular component. D6's lesson — "fail closed if the scanner is
 * missing, rather than passing".
 */
export function loadPatternSet(root: string, relPath = PATTERN_SET_REL): CompiledPatternSet {
  const abs = join(root, relPath);
  const cached = cache.get(abs);
  if (cached) return cached;

  if (!existsSync(abs)) {
    throw new Error(
      `secret pattern set not found at ${abs}. Refusing to classify with no rules — ` +
      `a scanner with an empty list reports everything clean.`,
    );
  }

  const raw = readFileSync(abs);
  let parsed: PatternSet;
  try {
    parsed = JSON.parse(raw.toString("utf8")) as PatternSet;
  } catch (e) {
    throw new Error(
      `secret pattern set at ${abs} is unparseable, refusing to classify: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!Array.isArray(parsed.rules) || parsed.rules.length === 0) {
    throw new Error(`secret pattern set at ${abs} declares no rules. Refusing to classify.`);
  }

  const compiled: CompiledPatternSet = {
    version: parsed.version ?? 1,
    rules: parsed.rules.map((r) => ({ ...r, re: toJsRegExp(r.pattern) })),
    floorPaths: parsed.floor_paths ?? [],
    ocrEngines: new Set((parsed.ocr_engines ?? []).map((e) => e.toLowerCase())),
    ocrFloorTier: coerceTier(parsed.ocr_floor_tier ?? "local_only"),
    benign: parsed.benign ?? [],
    hash: createHash("sha256").update(raw).digest("hex"),
  };
  cache.set(abs, compiled);
  return compiled;
}

/** Test seam: drop the cache so a test can swap pattern files in one process. */
export function clearPatternCache(): void {
  cache.clear();
}

/**
 * D4 · Normalise a vault-relative path for floor matching.
 *
 * The upstream bug in one line: `'11-identity/accounts/x.md'.startsWith('identity/accounts')`
 * is false. A PARA-numbered vault made every floor path unreachable.
 *
 * Strips a leading numeric prefix from EVERY segment, lowercases, and
 * normalises separators — so `11-identity/03-accounts/x.md` and
 * `identity/accounts/x.md` both match the `identity/accounts` floor rule.
 */
export function normalisePathForFloor(relPath: string): string {
  return relPath
    .replace(/\\/g, "/")
    .split("/")
    .map((seg) => seg.replace(/^\d+[-_. ]+/, ""))
    .join("/")
    .toLowerCase();
}

/**
 * True iff this path sits under a configured secret-floor location. Matches on
 * SEGMENT BOUNDARIES, not substrings — `identity/accounts-public` must not
 * match `identity/accounts`, and `my-finance-notes` must not match `finance`.
 */
export function matchesFloorPath(relPath: string, floorPaths: readonly string[]): string | null {
  const norm = normalisePathForFloor(relPath);
  const segs = norm.split("/");
  for (const floor of floorPaths) {
    const floorSegs = normalisePathForFloor(floor).split("/").filter(Boolean);
    if (floorSegs.length === 0) continue;
    for (let i = 0; i + floorSegs.length <= segs.length; i++) {
      let ok = true;
      for (let j = 0; j < floorSegs.length; j++) {
        if (segs[i + j] !== floorSegs[j]) { ok = false; break; }
      }
      if (ok) return floor;
    }
  }
  return null;
}

export interface RuleHit {
  ruleId: string;
  band: Band;
  provider: string | null;
  /** 1-indexed line the match starts on, for a report a human can act on. */
  line: number;
  /** The matched text, redacted to a shape. NEVER the secret itself. */
  redacted: string;
}

export interface ClassifyInput {
  /** The content to classify. */
  text: string;
  /** Vault-relative path, if known. Drives the path-floor band (D4). */
  relPath?: string;
  /**
   * The extraction engine that produced this text, if it was extracted.
   * I16: an OCR engine floors the result, regardless of how benign it looks.
   */
  extractEngine?: string | null;
  /** An existing tier, if the content is already labelled. Raise-only from here. */
  currentTier?: unknown;
}

export interface ClassifyResult {
  /** The resulting tier. NEVER lower than `currentTier` — I14. */
  tier: Tier;
  /** Every rule that matched, `definite` and `heuristic` alike. */
  hits: RuleHit[];
  /**
   * D24 / I17 — may this result fail a commit? True only if a `definite` rule
   * or a floor path fired. A `heuristic` hit raises the tier and warns; it
   * never blocks, because a guard that gets routed around is worse than no
   * guard.
   */
  blocking: boolean;
  /** Human-readable reasons, in the order they were applied. */
  reasons: string[];
  /** I15 — the pattern-set hash this decision was made under. Stamp it. */
  patternHash: string;
}

/** Redact a matched secret to its shape. A finding must never log the finding. */
function redactMatch(s: string): string {
  const t = s.trim();
  if (t.length <= 8) return `${t.slice(0, 2)}…(${t.length} chars)`;
  return `${t.slice(0, 6)}…${t.slice(-2)} (${t.length} chars)`;
}

/**
 * Classify content, returning a tier that is never lower than the one it came
 * in with.
 *
 * Order matters and is deliberate:
 *   1. start at the current tier (or `private` if unlabelled)
 *   2. OCR floor  — I16, applies to the whole extract regardless of content
 *   3. path floor — D4, applies regardless of content
 *   4. pattern rules — content-derived
 * Each step can only RAISE. There is no step that lowers, by construction.
 */
export function classify(input: ClassifyInput, patterns: CompiledPatternSet): ClassifyResult {
  const hits: RuleHit[] = [];
  const reasons: string[] = [];
  let tier: Tier = input.currentTier === undefined ? UNLABELLED_TIER : coerceTier(input.currentTier);
  let blocking = false;

  // ── 2 · I16 · OCR floor ────────────────────────────────────────────────────
  // Applied BEFORE any content inspection, precisely because the content is the
  // thing that cannot be trusted here: OCR is where text arrives both secret
  // and corrupt. One live page was fabricated wholesale from an extract whose
  // embedded font shifted every glyph 31 code points, silently deleting every
  // digit in the document.
  const engine = (input.extractEngine ?? "").toLowerCase().trim();
  if (engine && patterns.ocrEngines.has(engine)) {
    const before = tier;
    tier = raiseOnly(tier, patterns.ocrFloorTier);
    if (tier !== before) {
      reasons.push(
        `OCR floor (I16): extracted by "${engine}" — OCR output is untrusted by default and is never ` +
        `eligible for a hosted route on an ingest-time tier alone. ${before} → ${tier}.`,
      );
    }
    blocking = true;
  }

  // ── 3 · D4 · path floor ────────────────────────────────────────────────────
  if (input.relPath) {
    const floor = matchesFloorPath(input.relPath, patterns.floorPaths);
    if (floor) {
      const before = tier;
      tier = raiseOnly(tier, "local_only");
      reasons.push(
        `path floor (D4): "${input.relPath}" sits under the secret-floor location "${floor}". ` +
        (tier !== before ? `${before} → ${tier}.` : `already ${tier}.`),
      );
      blocking = true;
    }
  }

  // ── 4 · content rules ──────────────────────────────────────────────────────
  const text = input.text ?? "";
  const lineAt = (idx: number): number => {
    let line = 1;
    for (let i = 0; i < idx && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
    return line;
  };

  for (const rule of patterns.rules) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let matched = false;
    while ((m = rule.re.exec(text)) !== null) {
      matched = true;
      hits.push({
        ruleId: rule.id,
        band: rule.band,
        provider: rule.provider,
        line: lineAt(m.index),
        redacted: redactMatch(m[0]),
      });
      if (rule.re.lastIndex === m.index) rule.re.lastIndex++;
      if (hits.length > 500) break; // a pathological file must not hang the scan
    }
    if (!matched) continue;

    const before = tier;
    tier = raiseOnly(tier, "local_only");
    if (rule.band === "definite") {
      blocking = true;
      reasons.push(
        `${rule.id} (definite): ${rule.description.split(".")[0]}. ` +
        (tier !== before ? `${before} → ${tier}.` : `already ${tier}.`),
      );
    } else {
      // I17: raises the tier (safe when wrong), never blocks (costly when wrong).
      reasons.push(
        `${rule.id} (heuristic): ${rule.description.split(".")[0]}. ` +
        `Tier raised${tier !== before ? ` ${before} → ${tier}` : ""}; NOT blocking — a fuzzy rule may ` +
        `raise a tier but must never fail a commit.`,
      );
    }
  }

  return { tier, hits, blocking, reasons, patternHash: patterns.hash };
}

/**
 * D4 · Positive-coverage self-test. Every rule must match its own fixture, and
 * no `definite` rule may match any benign string.
 *
 * This runs in CI (`gate/key-shapes`) AND is exposed through `sutra doctor`,
 * because the failure it guards is a rule that quietly stops matching anything
 * — which looks identical to a clean corpus.
 */
export function selfTestPatterns(patterns: CompiledPatternSet): {
  ok: boolean;
  coverage: Array<{ ruleId: string; matchesOwnFixture: boolean }>;
  falsePositives: Array<{ ruleId: string; benign: string }>;
} {
  const coverage = patterns.rules.map((rule) => {
    const re = toJsRegExp(rule.pattern, "");
    return { ruleId: rule.id, matchesOwnFixture: re.test(rule.fixture) };
  });

  const falsePositives: Array<{ ruleId: string; benign: string }> = [];
  for (const benign of patterns.benign) {
    for (const rule of patterns.rules) {
      if (rule.band !== "definite") continue; // heuristics are ALLOWED to over-match
      const re = toJsRegExp(rule.pattern, "");
      if (re.test(benign)) falsePositives.push({ ruleId: rule.id, benign });
    }
  }

  return {
    ok: coverage.every((c) => c.matchesOwnFixture) && falsePositives.length === 0,
    coverage,
    falsePositives,
  };
}

/**
 * I15 · The re-scan gate.
 *
 * `stampedHash` is what the corpus was last fully scanned under. If the active
 * pattern set differs, the list improved and NOTHING was re-examined — which is
 * exactly how thirteen credential-bearing sources stayed invisible while the
 * patterns that would have caught them were being written.
 *
 * Release-blocking until a full re-scan completes.
 */
export function rescanRequired(
  patterns: CompiledPatternSet,
  stampedHash: string | null,
): { required: boolean; reason: string } {
  if (!stampedHash) {
    return {
      required: true,
      reason: "no full-corpus scan has ever been stamped. Run `sutra rescan`.",
    };
  }
  if (stampedHash !== patterns.hash) {
    return {
      required: true,
      reason:
        `the detection pattern set changed since the last full scan ` +
        `(stamped ${stampedHash.slice(0, 12)}…, active ${patterns.hash.slice(0, 12)}…). ` +
        `Content classified under the OLD set has not been re-examined — a better list changes ` +
        `nothing retroactively. Run \`sutra rescan\`.`,
    };
  }
  return { required: false, reason: "corpus was scanned under the active pattern set" };
}
