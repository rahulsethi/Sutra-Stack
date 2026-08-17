// SPDX-License-Identifier: LicenseRef-Sutra-Commercial
/**
 * THE ENTERPRISE POLICY ENGINE — E1 and E2.
 *
 * ROADMAP v2.0 states the shape of this file in one line:
 *
 *     tier ≤ min(subject.clearance, surface_ceiling, purpose_ceiling)
 *
 * That is the Core gate generalised, and the word that matters is GENERALISED.
 * Core already answers "may this content reach this destination?". Enterprise
 * adds two more questions to the same `min`:
 *
 *     WHO is asking          → subject.clearance   (E2: SSO, groups, RBAC/ABAC)
 *     WHAT FOR               → purpose_ceiling     (E2: purpose limitation)
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE PROPERTY THAT MAKES THIS SAFE TO SELL: IT CAN ONLY NARROW
 * ══════════════════════════════════════════════════════════════════════════
 * Every function here composes with `Math.max` over tier RANK — the strictest
 * constraint wins. There is no code path, no policy bundle, no role, no
 * break-glass and no configuration in this subtree that can make content MORE
 * visible than the open-source Core would have made it.
 *
 * This is not a nicety. It is what lets a customer's security team review the
 * ~600 lines of `packages/core/src/gate/` and know that reviewing THIS
 * subtree is optional for the question "can it leak?". Enterprise can only
 * answer "no" more often.
 *
 * `narrowsOnly()` at the bottom asserts it over every combination, and
 * `engine.test.ts` runs that assertion exhaustively. If a future feature needs
 * to widen exposure, it does not belong here — it belongs in Core, in the open,
 * where it can be argued with.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * E1 · CONSOLIDATE THE GATE — "Phase 1 is mostly deletion"
 * ══════════════════════════════════════════════════════════════════════════
 * The upstream system had SIX re-implementations of one tier comparison across
 * three languages and FIVE different `do_not_learn` predicates, and "every
 * divergence fails open in at least one of them".
 *
 * So this engine does not re-implement the comparison. It IMPORTS
 * `sensitivityGuard`, `TIER_RANK` and `isDoNotLearn` from `@sutra/aatma-core` and
 * composes them. One policy engine, one predicate, N thin bindings — and the
 * enterprise engine is one of the bindings, not a seventh implementation.
 */

import {
  type Tier,
  TIER_RANK,
  TIER_DISPLAY,
  coerceTier,
  sensitivityGuard,
  isSecretFloor,
} from "@sutra/aatma-core";

// ─────────────────────────────────────────────────────────────────────────────
// E2 · Identity
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An authenticated subject. Populated from OIDC/SAML claims by
 * `identity/oidc.ts`; this module never authenticates anything itself.
 */
export interface Subject {
  /** Stable subject id from the IdP. Never an email — those get reassigned. */
  id: string;
  tenant: string;
  /** Group/role names as the IdP presents them. */
  groups: readonly string[];
  /**
   * The highest tier this subject may ever reach, derived from their roles.
   *
   * NOTE what this is NOT: it is not a grant. It is a CEILING. A subject with
   * `local_only` clearance still only sees what the surface and the purpose
   * also allow.
   */
  clearance: Tier;
  /** For audit. Not used in any decision. */
  displayName?: string;
}

/**
 * Why the subject is asking. E2's purpose limitation.
 *
 * The reason this is a first-class input rather than a comment: GDPR Art. 5(1)(b)
 * and every equivalent regime require that data collected for one purpose is not
 * silently reused for another. "This person is cleared to see it" and "this
 * person may see it FOR THIS" are different questions, and an access-control
 * model that only asks the first cannot answer a regulator's actual question.
 */
export interface Purpose {
  id: string;
  /** The highest tier reachable for this purpose, regardless of who is asking. */
  ceiling: Tier;
  description: string;
}

/**
 * Where the answer is going. Same meaning as Core's destination tier, named
 * explicitly because at enterprise scale one subject reaches many surfaces.
 */
export interface Surface {
  id: string;
  ceiling: Tier;
  /**
   * Per-tenant provider allowlist (E2). A surface may be capable of reaching a
   * model the tenant has not approved; that is a separate question from tier,
   * and conflating them is how a "compliant" deployment routes to an
   * unapproved processor.
   */
  allowedProviders?: readonly string[];
}

export interface PolicyDecision {
  allowed: boolean;
  /** The effective ceiling, after every constraint. */
  effectiveCeiling: Tier;
  /**
   * WHICH constraint bound the decision. An access decision a customer cannot
   * explain is one they cannot defend in an audit — "denied" is not an answer,
   * "denied because the purpose ceiling is public and the content is private"
   * is.
   */
  boundBy: "subject" | "surface" | "purpose" | "secret-floor" | "do-not-learn" | "none";
  reason: string;
  /** Everything an auditor needs, without the content. */
  audit: {
    subject: string;
    tenant: string;
    surface: string;
    purpose: string;
    contentTier: Tier;
    subjectClearance: Tier;
    surfaceCeiling: Tier;
    purposeCeiling: Tier;
  };
}

/**
 * The effective ceiling: the STRICTEST of the three, always.
 *
 * `Math.min` over permissiveness == `Math.max` over restrictiveness rank. Any
 * future constraint added here can only push the rank up, never down, which is
 * the property `narrowsOnly()` proves.
 */
export function effectiveCeiling(
  subjectClearance: Tier,
  surfaceCeiling: Tier,
  purposeCeiling: Tier,
): { ceiling: Tier; boundBy: "subject" | "surface" | "purpose" } {
  const candidates: Array<[Tier, "subject" | "surface" | "purpose"]> = [
    [subjectClearance, "subject"],
    [surfaceCeiling, "surface"],
    [purposeCeiling, "purpose"],
  ];
  // The LEAST permissive wins. Lower rank == less permissive as a ceiling.
  let best = candidates[0]!;
  for (const c of candidates) {
    if (TIER_RANK[c[0]] < TIER_RANK[best[0]]) best = c;
  }
  return { ceiling: best[0], boundBy: best[1] };
}

/**
 * THE ENTERPRISE GATE.
 *
 * Order matters and mirrors Core's, deliberately:
 *   1. `do_not_learn`  — absolute, checked first, no clearance overrides it
 *   2. the secret floor — absolute, no clearance overrides it either
 *   3. the composed ceiling — subject ∧ surface ∧ purpose
 *   4. Core's own `sensitivityGuard` against that ceiling
 *
 * Steps 1 and 2 come BEFORE clearance is even read. There is no role in this
 * system, including a tenant administrator, that reaches `local_only` content
 * through this function. An enterprise buyer will ask whether an admin can
 * override the floor; the answer is no, and it is no because of the ordering
 * here rather than because of a policy setting they have to trust.
 */
export function evaluate(input: {
  contentTier: unknown;
  doNotLearn: boolean;
  subject: Subject;
  surface: Surface;
  purpose: Purpose;
}): PolicyDecision {
  const contentTier = coerceTier(input.contentTier);
  const { subject, surface, purpose } = input;

  const audit = {
    subject: subject.id,
    tenant: subject.tenant,
    surface: surface.id,
    purpose: purpose.id,
    contentTier,
    subjectClearance: subject.clearance,
    surfaceCeiling: surface.ceiling,
    purposeCeiling: purpose.ceiling,
  };

  // 1 · do_not_learn. Orthogonal to tier, and absolute.
  if (input.doNotLearn) {
    return {
      allowed: false,
      effectiveCeiling: "hosted_allowed",
      boundBy: "do-not-learn",
      reason:
        "content is marked do_not_learn — excluded from every model surface at every tier, " +
        "for every subject, under every clearance. No role overrides this.",
      audit,
    };
  }

  // 2 · THE SECRET FLOOR. Before clearance is read.
  if (isSecretFloor(contentTier) && TIER_RANK[surface.ceiling] < TIER_RANK["local_only"]) {
    return {
      allowed: false,
      effectiveCeiling: surface.ceiling,
      boundBy: "secret-floor",
      reason:
        "secret floor — local_only content never reaches a model surface. This is enforced before " +
        "clearance is evaluated: no role, no group, no policy bundle and no break-glass in the " +
        "Enterprise edition reaches it.",
      audit,
    };
  }

  // 3 · the composed ceiling
  const { ceiling, boundBy } = effectiveCeiling(subject.clearance, surface.ceiling, purpose.ceiling);

  // 4 · CORE'S OWN GUARD, unmodified. Not a re-implementation of it (E1).
  const core = sensitivityGuard(contentTier, ceiling);

  if (!core.allowed) {
    return {
      allowed: false,
      effectiveCeiling: ceiling,
      boundBy,
      reason:
        `content is ${TIER_DISPLAY[contentTier]}; the effective ceiling is ` +
        `${TIER_DISPLAY[ceiling]}, bound by the ${boundBy} constraint ` +
        `(subject ${TIER_DISPLAY[subject.clearance]} ∧ surface ${TIER_DISPLAY[surface.ceiling]} ∧ ` +
        `purpose ${TIER_DISPLAY[purpose.ceiling]}).`,
      audit,
    };
  }

  return {
    allowed: true,
    effectiveCeiling: ceiling,
    boundBy: "none",
    reason: "ok",
    audit,
  };
}

/**
 * E2 · The per-tenant provider allowlist.
 *
 * A SEPARATE question from tier, and it is separate for a concrete reason: a
 * tenant may be perfectly willing for `public` content to reach a model, and
 * entirely unwilling for it to reach a model hosted in a jurisdiction they have
 * not approved. Tier answers "may this leave"; this answers "may it go THERE".
 *
 * D38 is the same shape of mistake one level down: tier encodes "may this leave
 * the machine", not "whose information is this", and those have different
 * answers.
 */
export function providerAllowed(
  surface: Surface,
  providerId: string,
): { allowed: boolean; reason: string } {
  // No allowlist configured means "not yet decided", and the safe reading of an
  // undecided question is NO. A tenant who has not chosen their approved
  // processors has not implicitly approved all of them.
  if (!surface.allowedProviders) {
    return {
      allowed: false,
      reason:
        `surface "${surface.id}" has no provider allowlist configured. An unconfigured allowlist ` +
        `denies rather than permits — an undecided question is not an approval.`,
    };
  }
  if (!surface.allowedProviders.includes(providerId)) {
    return {
      allowed: false,
      reason: `provider "${providerId}" is not in the allowlist for surface "${surface.id}" (${surface.allowedProviders.join(", ")}).`,
    };
  }
  return { allowed: true, reason: "ok" };
}

/**
 * THE INVARIANT THIS WHOLE SUBTREE RESTS ON.
 *
 * For every combination of content tier, clearance, surface and purpose:
 * IF THE ENTERPRISE ENGINE ALLOWS SOMETHING, CORE WOULD HAVE ALLOWED IT TOO
 * AT THE SAME SURFACE CEILING.
 *
 * Enterprise narrows. It never widens. `engine.test.ts` runs this over the full
 * cross-product on every build, and a customer's security review can reduce to:
 * "read Core's gate, then check that this function still passes."
 */
export function narrowsOnly(input: {
  contentTier: Tier;
  doNotLearn: boolean;
  subject: Subject;
  surface: Surface;
  purpose: Purpose;
}): { holds: boolean; detail: string } {
  const ee = evaluate(input);

  // What Core alone would have said, given only the surface.
  const coreAllowed =
    !input.doNotLearn && sensitivityGuard(input.contentTier, input.surface.ceiling).allowed;

  if (ee.allowed && !coreAllowed) {
    return {
      holds: false,
      detail:
        `WIDENING DETECTED: the Enterprise engine allowed ${TIER_DISPLAY[input.contentTier]} content ` +
        `at surface ceiling ${TIER_DISPLAY[input.surface.ceiling]}, which Core alone would have refused. ` +
        `Enterprise may only ever narrow.`,
    };
  }
  return { holds: true, detail: "ok" };
}
