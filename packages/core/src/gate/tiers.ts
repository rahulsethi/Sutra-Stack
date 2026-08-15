// SPDX-License-Identifier: Apache-2.0
/**
 * THE TIER MODEL — the one normaliser every tier comparison goes through.
 *
 * Lifted from `aatma/src/mcp/brain.ts` (tier coercion + aliasing) and
 * `aatma/src/sensitivity-guard.ts` (TIER_RANK). Split out because six
 * re-implementations of one tier comparison across three languages is what the
 * upstream system had, and **every divergence failed open in at least one of
 * them** (ROADMAP E1). There is one rank table and one coercion function here,
 * and every other module imports them.
 *
 * ── D20 · Why `coerceTier` accepts historical spellings ────────────────────
 * A tier rename once turned the only repair script into a permanent no-op:
 * `backfill-synthesis.ps1` hard-filtered on the literal `hosted_allowed`, a
 * later normalisation renamed that tier to `public`, and the script silently
 * skipped 100% of candidates while exiting 0. It exits 0 having processed
 * nothing, which is indistinguishable from "nothing to do".
 *
 * The rule that follows: **never compare a raw frontmatter string to a
 * literal.** Resolve through this module or you have written that bug again.
 */

/** The three internal tier identifiers. Stable; never renamed again. */
export type Tier = "local_only" | "review_required" | "hosted_allowed";

/** The user-facing spellings. What a person reads and writes in frontmatter. */
export type TierDisplay = "secret" | "private" | "public";

/**
 * Restrictiveness rank. Higher = more restrictive = must stay closer to home.
 * The gate is a rank comparison and nothing else — that is why it is small
 * enough to be auditable, and why it cannot be argued with at call sites.
 */
export const TIER_RANK: Record<Tier, number> = {
  hosted_allowed: 0, // most permissive — may go anywhere
  review_required: 1,
  local_only: 2, // most restrictive — never leaves the machine
};

/**
 * Historical and user-facing spellings → the internal identifier.
 *
 * The 2026-06 rename made public/private/secret the canonical spellings while
 * keeping the original identifiers internally, so the gate logic and its tests
 * stayed byte-identical. The migration is pure aliasing — zero behaviour change
 * — and both spellings are accepted forever. Removing an alias is a breaking
 * change to every vault in existence.
 */
const TIER_ALIAS: Record<string, Tier> = {
  // canonical user-facing spellings
  public: "hosted_allowed",
  private: "review_required",
  secret: "local_only",
  // internal identifiers, accepted as themselves
  hosted_allowed: "hosted_allowed",
  review_required: "review_required",
  local_only: "local_only",
  // tolerated variants seen in the wild
  "hosted-allowed": "hosted_allowed",
  "review-required": "review_required",
  "local-only": "local_only",
  hosted: "hosted_allowed",
  local: "local_only",
};

/** Internal identifier → the spelling shown to a person. */
export const TIER_DISPLAY: Record<Tier, TierDisplay> = {
  hosted_allowed: "public",
  review_required: "private",
  local_only: "secret",
};

/**
 * THE DEFAULT FOR UNLABELLED CONTENT IS `private`, NOT `public`.
 *
 * This single line is load-bearing. An unlabelled note is not a note anyone has
 * decided is safe to send; it is a note nobody has looked at. Defaulting it
 * open would mean every parse failure, every hand-written file, and every
 * malformed frontmatter block became an egress.
 */
export const UNLABELLED_TIER: Tier = "review_required";

/**
 * Resolve any tier-ish value to an internal identifier.
 *
 * Total function: never throws, never returns undefined. Anything unrecognised
 * — including `null`, `undefined`, a number, an object, or a typo — resolves to
 * `review_required`. Fail closed.
 */
export function coerceTier(v: unknown): Tier {
  const s = String(v ?? "").trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(TIER_ALIAS, s)) return TIER_ALIAS[s]!;
  return UNLABELLED_TIER;
}

/** Render a tier for a human. Accepts anything `coerceTier` accepts. */
export function displayTier(v: unknown): TierDisplay {
  return TIER_DISPLAY[coerceTier(v)];
}

/** True iff `s` is one of the two spellings of a real tier (not a fallback). */
export function isKnownTierSpelling(s: unknown): boolean {
  return Object.prototype.hasOwnProperty.call(
    TIER_ALIAS,
    String(s ?? "").trim().toLowerCase(),
  );
}

/**
 * Aggregate a set of tiers to the strictest one present.
 *
 * Used wherever several sources feed one output — a synthesised page, a merged
 * answer, a multi-note context block. The result is as restrictive as the most
 * restrictive input, which is the only safe direction to round.
 *
 * An EMPTY list returns `review_required`, not `hosted_allowed`. "I found no
 * sources" must never mean "therefore this is public".
 */
export function strictestTier(tiers: readonly Tier[]): Tier {
  if (tiers.length === 0) return UNLABELLED_TIER;
  let strictest: Tier = "hosted_allowed";
  for (const t of tiers) {
    if (TIER_RANK[t] > TIER_RANK[strictest]) strictest = t;
  }
  return strictest;
}

/**
 * INVARIANT 4 — SENSITIVITY IS RAISE-ONLY.
 *
 * Classification floors first, then only ever raises. No path may downscope a
 * tier: not ingest, not capture, not hygiene, not a user's own careless edit,
 * not an automated maintenance job.
 *
 * Returns whichever of the two is stricter. Every place that would otherwise
 * write a tier calls this, so "lower a tier" is not an operation the codebase
 * knows how to perform. Invariant I14 asserts no automated transition ever
 * lowers one; this function is why it can't.
 */
export function raiseOnly(current: Tier, proposed: Tier): Tier {
  return TIER_RANK[proposed] > TIER_RANK[current] ? proposed : current;
}

/**
 * True iff moving `from` → `to` would LOWER the tier. The audit hook for I14:
 * anything that returns true here and is not an explicit, interactive human
 * action is a governance violation, and is recorded as one.
 */
export function isDownscope(from: Tier, to: Tier): boolean {
  return TIER_RANK[to] < TIER_RANK[from];
}

/** The `do_not_learn` predicate. ONE implementation — see the note below. */
export function isDoNotLearn(data: Record<string, unknown> | null | undefined): boolean {
  // ROADMAP E1: the upstream system had FIVE different `do_not_learn`
  // predicates, and every divergence failed open in at least one of them. This
  // is the only one. It is deliberately generous about what counts as true and
  // deliberately strict about what counts as false.
  const raw = data?.["do_not_learn"];
  if (raw === true) return true;
  const s = String(raw ?? "").trim().toLowerCase();
  return s === "true" || s === "yes" || s === "1";
}
