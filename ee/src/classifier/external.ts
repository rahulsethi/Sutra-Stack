// SPDX-License-Identifier: LicenseRef-Sutra-Commercial
/**
 * E7 · THE PLUGGABLE CLASSIFIER.
 *
 * ROADMAP v2.0: "The customer's own DLP/classification system supplies the
 * tier. This is the integration that makes Sutra FIT AN EXISTING ENTERPRISE
 * DATA-GOVERNANCE ESTATE RATHER THAN COMPETE WITH IT."
 *
 * That sentence is the whole commercial argument for this module. A company
 * that has already classified its data — with Purview, Titus, BigID, or
 * something homegrown — does not want a second, disagreeing classifier. It
 * wants Sutra to ASK.
 *
 * ── THE COMPOSITION RULE: STRICTEST WINS ──────────────────────────────────
 * An external verdict never REPLACES Sutra's own classification. The two are
 * composed, and the stricter answer wins.
 *
 * The reason is asymmetric trust, in both directions:
 *
 *   - The customer's DLP knows things Sutra cannot: which project is under
 *     embargo, which client is litigious, what "Restricted" means in this firm.
 *   - Sutra knows things the DLP does not: that this text came out of an OCR
 *     engine (I16), that it sits under a secret-floor path (D4), that it holds
 *     a key shape their rules do not cover (D5).
 *
 * Neither is a superset of the other. Taking the stricter is the only
 * composition that does not discard one of them.
 *
 * ── FAIL CLOSED, AND IT IS NOT CONFIGURABLE ───────────────────────────────
 * A classifier that cannot be reached FLOORS the content. It does not pass it
 * through at whatever tier Sutra guessed locally.
 *
 * This is the single most likely place for an enterprise deployment to acquire
 * a silent hole: the DLP endpoint goes down, everything classifies as the local
 * default, and nothing looks wrong for a month. So `bundle.validate()` REFUSES
 * a bundle whose classifier is configured to fail open — the option to get this
 * wrong is not offered.
 */

import { type Tier, TIER_RANK, coerceTier, raiseOnly } from "@sutra/aatma-core";

/** What an external classification system returns about one piece of content. */
export interface ExternalVerdict {
  /** The customer's own label — "Confidential", "Internal", "Restricted". */
  label: string;
  /** That label mapped into Sutra's three tiers, by the tenant's own mapping. */
  tier: Tier;
  /** 0..1. Below the configured floor, the verdict is treated as unavailable. */
  confidence: number;
  /** Which system said so. Recorded on the note for provenance. */
  source: string;
}

export interface ClassifierAdapter {
  kind: string;
  /** Returns null when the system is unreachable — which FLOORS the content. */
  classify(input: { text: string; relPath?: string }): Promise<ExternalVerdict | null>;
}

export interface CompositionResult {
  tier: Tier;
  /** Which input decided the outcome. Recorded for audit. */
  decidedBy: "sutra" | "external" | "both-agree" | "fail-closed-floor";
  reason: string;
  external: ExternalVerdict | null;
}

/**
 * Compose Sutra's own classification with an external verdict.
 *
 * STRICTEST WINS, always. `raiseOnly` is imported from Core rather than
 * reimplemented — E1's rule: one policy engine, N thin bindings.
 */
export function compose(
  sutraTier: Tier,
  external: ExternalVerdict | null,
  opts: { minConfidence?: number; failClosedTier?: Tier } = {},
): CompositionResult {
  const minConfidence = opts.minConfidence ?? 0.6;
  const floor = opts.failClosedTier ?? "local_only";

  // UNREACHABLE -> FLOOR. Not "use the local guess".
  if (external === null) {
    return {
      tier: raiseOnly(sutraTier, floor),
      decidedBy: "fail-closed-floor",
      reason:
        "the external classifier was unreachable, so the content is floored. It is NOT passed " +
        "through at the locally-guessed tier: an unreachable DLP that silently degrades to a local " +
        "default is how an enterprise deployment acquires a hole nobody notices for a month.",
      external: null,
    };
  }

  // LOW CONFIDENCE -> treated as unavailable. A hedged verdict is not a verdict.
  if (external.confidence < minConfidence) {
    return {
      tier: raiseOnly(sutraTier, floor),
      decidedBy: "fail-closed-floor",
      reason:
        `the external classifier returned "${external.label}" at confidence ` +
        `${external.confidence.toFixed(2)}, below the ${minConfidence} floor. A hedged verdict is ` +
        `treated as no verdict, and no verdict floors.`,
      external,
    };
  }

  const externalTier = coerceTier(external.tier);
  const composed = raiseOnly(sutraTier, externalTier);

  if (TIER_RANK[externalTier] === TIER_RANK[sutraTier]) {
    return { tier: composed, decidedBy: "both-agree", reason: `both classified this "${external.label}"`, external };
  }
  if (TIER_RANK[externalTier] > TIER_RANK[sutraTier]) {
    return {
      tier: composed,
      decidedBy: "external",
      reason:
        `${external.source} classified this "${external.label}", stricter than Sutra's own reading. ` +
        `The customer's system knows things Sutra cannot — embargoes, client sensitivity, local policy.`,
      external,
    };
  }
  return {
    tier: composed,
    decidedBy: "sutra",
    reason:
      `Sutra classified this stricter than ${external.source} did ("${external.label}"). Sutra knows ` +
      `things the DLP does not — an OCR origin, a secret-floor path, a key shape outside its rules. ` +
      `The stricter answer wins in BOTH directions; neither classifier is a superset of the other.`,
    external,
  };
}
