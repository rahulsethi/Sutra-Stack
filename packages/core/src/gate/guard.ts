// SPDX-License-Identifier: Apache-2.0
/**
 * THE GATE — the enforcement point of AATMA, Sutra's governance and identity
 * core. Every egress decision in the stack resolves here.
 *
 * This is the smallest and most important file in the product. Everything Sutra
 * claims rests on the comparison in `sensitivityGuard`:
 *
 *     content may reach a destination iff the content is at least as permissive
 *     as the destination requires.
 *
 * ── INVARIANT 2 · The gate is server-side and the model cannot lift it ──────
 * The exposure ceiling is read from the environment at server startup and is
 * NEVER accepted as a tool argument. A model can ask for anything; it cannot
 * change what it is allowed to see. See `packages/mcp/src/server.ts` — the
 * ceiling is captured once, before the first request is served.
 *
 * ── INVARIANT 3 · The secret floor is absolute ─────────────────────────────
 * `local_only` content never reaches any LLM, hosted or local-via-a-harness.
 * Not under override, not under a flag, not for convenience. It is enforced at
 * four independent points and all four stay:
 *
 *   1. here — the rank comparison
 *   2. `Brain.visible()` — never lifts `local_only` by promotion (vault/brain.ts)
 *   3. the classifier's floor rules — content is tiered `local_only` at ingest
 *      before anything can read it (gate/patterns.ts)
 *   4. the MCP server's per-tool ceiling clamp (packages/mcp/src/server.ts)
 *
 * Defence in depth is not redundancy here. Each of the four has failed
 * independently in the upstream system's history; the other three held.
 */

import { type Tier, TIER_RANK } from "./tiers.js";

export interface GuardDecision {
  allowed: boolean;
  /** `ok`, or a sentence a human can act on. Never an opaque code. */
  reason: string;
  source_tier: Tier;
  destination_tier: Tier;
}

/**
 * The gate.
 *
 * `destinationAcceptsTier` is the LEAST-private tier the destination accepts:
 *
 *   - a hosted provider accepts `hosted_allowed` ONLY        → rank 0
 *   - a local-only provider accepts anything                 → rank 2
 *
 * Content flows iff `rank(source) <= rank(destination)`.
 *
 *   hosted destination (rank 0):
 *     source hosted_allowed  (0)  →  0 <= 0  ✅
 *     source review_required (1)  →  1 <= 0  ❌
 *     source local_only      (2)  →  2 <= 0  ❌
 *   local destination (rank 2):
 *     all three allowed.
 *
 * Note the asymmetry, because it is the whole point: making the destination
 * MORE permissive lets more content through; making the *content* more
 * permissive is a downscope, and `raiseOnly` in tiers.ts makes that
 * unexpressible.
 */
export function sensitivityGuard(
  sourceTier: Tier,
  destinationAcceptsTier: Tier,
): GuardDecision {
  const src = TIER_RANK[sourceTier];
  const dst = TIER_RANK[destinationAcceptsTier];
  if (src <= dst) {
    return {
      allowed: true,
      reason: "ok",
      source_tier: sourceTier,
      destination_tier: destinationAcceptsTier,
    };
  }
  return {
    allowed: false,
    reason: `source ${sourceTier} is stricter than destination accepts ${destinationAcceptsTier}`,
    source_tier: sourceTier,
    destination_tier: destinationAcceptsTier,
  };
}

export type ProviderMode = "local" | "hosted" | "manual" | "skip";

/**
 * Map a provider mode to the tier floor it accepts.
 *
 *   "local"  → accepts any tier (the model runs on this machine)
 *   "hosted" → accepts `hosted_allowed` only
 *   "manual" → accepts any tier (a human reviews every dispatch)
 *   "skip"   → accepts NOTHING; `null` blocks everything
 *
 * `null` is a real answer, not an error. A caller that treats `null` as
 * "unknown, therefore allow" has inverted the gate — which is why this returns
 * a nullable Tier rather than throwing, and why `guardDispatch` below exists so
 * call sites don't hand-roll the null case.
 */
export function providerAcceptsTier(mode: ProviderMode): Tier | null {
  switch (mode) {
    case "local":
      return "local_only";
    case "hosted":
      return "hosted_allowed";
    case "manual":
      return "local_only";
    case "skip":
      return null;
  }
}

/**
 * The convenience wrapper every dispatch path should use: mode in, decision
 * out, `skip` handled. Exists so that no caller has to remember what `null`
 * means — D17's lesson generalised (a guard's fallback path must be tested for
 * the guard's own inversion).
 */
export function guardDispatch(
  sourceTier: Tier,
  mode: ProviderMode,
): GuardDecision {
  const accepts = providerAcceptsTier(mode);
  if (accepts === null) {
    return {
      allowed: false,
      reason: `destination mode "${mode}" accepts no content`,
      source_tier: sourceTier,
      destination_tier: "hosted_allowed",
    };
  }
  return sensitivityGuard(sourceTier, accepts);
}

/**
 * THE SECRET FLOOR, stated as a predicate rather than inferred from ranks.
 *
 * Written separately and deliberately redundantly with the rank comparison,
 * because "is this the absolute floor?" is a question that must be answerable
 * without reasoning about rank arithmetic. Any code path about to send content
 * anywhere off-machine calls this first. It cannot be configured, disabled,
 * flagged off, or overridden.
 */
export function isSecretFloor(tier: Tier): boolean {
  return tier === "local_only";
}

/**
 * The single question every egress path must ask: may this content leave the
 * machine at all, for any destination, under any configuration?
 *
 * `do_not_learn` is checked here too, because it is an independent axis from
 * tier: a `hosted_allowed` note marked `do_not_learn` still may not be sent.
 */
export function mayEverLeaveMachine(
  tier: Tier,
  doNotLearn: boolean,
): { allowed: boolean; reason: string } {
  if (doNotLearn) {
    return { allowed: false, reason: "marked do_not_learn — excluded from every model surface, at every tier" };
  }
  if (isSecretFloor(tier)) {
    return { allowed: false, reason: "secret floor — local_only content never reaches any model, hosted or local-via-a-harness" };
  }
  return { allowed: true, reason: "ok" };
}
