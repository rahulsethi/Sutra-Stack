// SPDX-License-Identifier: Apache-2.0
/**
 * PARVO · turn routing. Which model may serve this turn, decided by AATMA's
 * ceiling before anything else is considered.
 *
 * A pure decision: given a ceiling and the provider a conversational turn would
 * use, decide local-vs-hosted and whether the turn is ALLOWED.
 *
 * ── IT DOES NOT REIMPLEMENT THE GATE ───────────────────────────────────────
 * This is the whole reason the module is worth having, and it is E1's rule in
 * miniature: it composes `coerceTier`, `providerAcceptsTier` and
 * `sensitivityGuard` rather than restating them. There is no tier comparison in
 * this file.
 *
 * The upstream system reached SIX re-implementations of one tier comparison
 * across three languages, and every divergence failed open in at least one of
 * them. A routing module is exactly where the seventh would have appeared —
 * "just a quick check before we dispatch" — so it is deliberately a binding.
 *
 * ── THE FLOOR FALLS OUT OF THE GUARD, NOT OUT OF A RULE HERE ───────────────
 *   secret  + local   → allowed
 *   public  + hosted  → allowed
 *   secret  + hosted  → REFUSED, because sensitivityGuard says so
 *   private + hosted  → refused by default; allowed under a live override
 *
 * The third line is invariant 3, and it is enforced by
 * `sensitivityGuard(local_only, hosted_allowed) = deny`. There is no separate
 * rule here that could drift from it.
 */

import { type Tier, coerceTier } from "../gate/tiers.js";
import { providerAcceptsTier, sensitivityGuard } from "../gate/guard.js";

export type ModelTarget = "local" | "hosted";

export interface RouteDecision {
  /** Which model class this turn would use. */
  target: ModelTarget;
  /** True only if `target` may legitimately receive content at `ceiling`. */
  allowed: boolean;
  /** The normalised ceiling the decision was made against. */
  ceiling: Tier;
  /** A sentence a human can act on. Never an opaque code. */
  reason: string;
}

/**
 * A provider is "local" ONLY if it names the local runtime. Everything else
 * egresses.
 *
 * Note the direction of the default: an unrecognised provider name is treated
 * as HOSTED, not local. A typo in a provider name must fail toward the
 * restrictive reading — the alternative is that `local-ish` or a renamed
 * upstream silently becomes a trusted destination.
 */
function targetFor(modelProvider: string): ModelTarget {
  return modelProvider.trim().toLowerCase() === "local" ? "local" : "hosted";
}

/**
 * Decide whether a turn at `ceilingRaw` may run on a model from
 * `modelProvider`.
 *
 * `overrideActive` defaults to false, so with no override this function is
 * byte-for-byte the plain guard decision.
 *
 * ── WHAT THE OVERRIDE CAN AND CANNOT DO ────────────────────────────────────
 * A live, passphrase-verified override on a trusted node authorises a hosted
 * model to PROCESS `private` content — the everyday case where someone wants
 * help with something personal and has said so explicitly.
 *
 * It does NOT touch the floor. The branch below fires only when
 * `ceiling === "review_required"`. `secret` plus `hosted` stays refused
 * regardless of `overrideActive`, and `persona.test.ts` asserts that over every
 * combination rather than trusting the condition to be read correctly.
 */
export function routeTurn(
  ceilingRaw: string,
  modelProvider: string,
  overrideActive = false,
): RouteDecision {
  const ceiling = coerceTier(ceilingRaw);
  const target = targetFor(modelProvider);

  // local → accepts any tier; hosted → accepts hosted_allowed only. Never null
  // for these two, because neither maps to the `skip` mode.
  const accepts = providerAcceptsTier(target) as Tier;
  const guard = sensitivityGuard(ceiling, accepts);

  let allowed = guard.allowed;
  let reason = guard.allowed
    ? `a ${target} model may receive ${ceiling} content`
    : `refused: ${guard.reason} — secret and private content must not reach a hosted model`;

  if (!allowed && overrideActive && target === "hosted" && ceiling === "review_required") {
    allowed = true;
    reason =
      "a hosted model may process private content under an active, passphrase-verified override. " +
      "The secret floor is untouched by this: it applies only at the private tier.";
  }

  return { target, allowed, ceiling, reason };
}
