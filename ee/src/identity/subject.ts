// SPDX-License-Identifier: LicenseRef-Sutra-Commercial
/**
 * E2 · IDENTITY — mapping an IdP's claims onto a Sutra `Subject`.
 *
 * SSO (OIDC/SAML), SCIM, groups, RBAC/ABAC. This module does the last mile:
 * turning "what the identity provider says about this person" into "the highest
 * tier this person may reach".
 *
 * It does NOT authenticate. Verifying a token is the gateway's job, and doing
 * it in two places is how the two implementations diverge.
 *
 * ── DERIVING CLEARANCE FROM GROUPS: THE LEAST-PERMISSIVE RULE ─────────────
 * A person in several groups gets the clearance of... which one?
 *
 * The intuitive answer is "the highest" — they are in the admin group, so they
 * get admin clearance. That is what most RBAC systems do, and for a system
 * granting CAPABILITIES it is right: being in one group that can restart a
 * service should let you restart the service.
 *
 * For a system granting VISIBILITY OF DATA it is the wrong default, and the
 * difference is worth being explicit about. `deriveClearance` takes the
 * HIGHEST mapped clearance, because that is what an administrator configuring
 * groups expects and violating it would be surprising — but the mapping is
 * EXPLICIT PER GROUP, with no wildcard and no inheritance, so a group that has
 * not been given a clearance has none. An unmapped group grants nothing.
 *
 * The safety does not come from the max/min choice. It comes from the fact that
 * clearance is only ever ONE of three inputs to `min()`, and the other two
 * (surface, purpose) are set by the deployment rather than by group membership.
 * A person in every group in the directory still cannot exceed the surface they
 * are asking through.
 */

import { type Tier, TIER_RANK, TIER_DISPLAY, coerceTier } from "@sutra/aatma-core";
import type { Subject } from "../policy/engine.js";

/** Claims as they arrive from OIDC or SAML, already verified by the gateway. */
export interface IdpClaims {
  sub: string;
  /** Group or role names, however the IdP presents them. */
  groups?: readonly string[];
  /** Tenant, from a claim or from the issuer. */
  tid?: string;
  name?: string;
  email?: string;
}

/** Group name -> clearance. Comes from the signed policy bundle (E5). */
export type ClearanceMap = Readonly<Record<string, Tier>>;

export interface DerivedClearance {
  clearance: Tier;
  /** Which group produced it, for the audit record and for "why can I see this?". */
  grantedBy: string | null;
  /** Groups the IdP sent that no policy mentions. Reported, never guessed at. */
  unmapped: string[];
}

/**
 * Derive a clearance from group membership.
 *
 * NO WILDCARDS, NO INHERITANCE, NO DEFAULT GRANT. A group absent from the map
 * contributes nothing — it does not fall back to a base tier, and it does not
 * match a pattern.
 *
 * The `unmapped` list exists because the failure this prevents is quiet: an
 * organisation renames a group in their directory, the mapping silently stops
 * matching, and a team's clearance drops to nothing with no error anywhere.
 * `sutra doctor` surfaces unmapped groups so that shows up as a question rather
 * than as a mysterious loss of access.
 */
export function deriveClearance(
  groups: readonly string[],
  map: ClearanceMap,
): DerivedClearance {
  let best: Tier | null = null;
  let grantedBy: string | null = null;
  const unmapped: string[] = [];

  for (const g of groups) {
    const mapped = map[g];
    if (mapped === undefined) {
      unmapped.push(g);
      continue;
    }
    const tier = coerceTier(mapped);
    if (best === null || TIER_RANK[tier] > TIER_RANK[best]) {
      best = tier;
      grantedBy = g;
    }
  }

  return {
    // NO GROUPS MAPPED -> `hosted_allowed`, which as a CEILING is the LEAST
    // permissive value: it admits public content only. Not `local_only`, which
    // as a ceiling would admit everything. This inversion is the easiest thing
    // in the file to get backwards, and getting it backwards would mean an
    // unrecognised user seeing more than a recognised one.
    clearance: best ?? "hosted_allowed",
    grantedBy,
    unmapped,
  };
}

/** Build a `Subject` from verified claims plus the tenant's clearance map. */
export function subjectFromClaims(
  claims: IdpClaims,
  map: ClearanceMap,
  opts: { tenant?: string } = {},
): { subject: Subject; unmapped: string[] } {
  const groups = claims.groups ?? [];
  const derived = deriveClearance(groups, map);

  const subject: Subject = {
    // The IdP's stable subject id. NEVER the email: addresses get reassigned
    // when people leave, and an audit trail keyed on a reassigned address
    // attributes one person's access to another.
    id: claims.sub,
    tenant: opts.tenant ?? claims.tid ?? "default",
    groups: [...groups],
    clearance: derived.clearance,
    ...(claims.name ? { displayName: claims.name } : {}),
  };

  return { subject, unmapped: derived.unmapped };
}

/**
 * Explain a subject's clearance in one sentence.
 *
 * "Why can this person see this?" is the question an access review asks, and
 * an RBAC system that cannot answer it in a sentence gets replaced by a
 * spreadsheet.
 */
export function explainClearance(subject: Subject, derived: DerivedClearance): string {
  const base = derived.grantedBy
    ? `${subject.id} has ${TIER_DISPLAY[subject.clearance]} clearance via the group "${derived.grantedBy}".`
    : `${subject.id} has no group mapped to a clearance, so their ceiling is ${TIER_DISPLAY[subject.clearance]} — public content only.`;

  const warn = derived.unmapped.length
    ? ` ${derived.unmapped.length} group(s) the directory sent are not mentioned in any policy ` +
      `(${derived.unmapped.join(", ")}) — if a group was renamed upstream, this is where that shows up.`
    : "";

  return base + warn +
    " Clearance is a CEILING, not a grant: the surface and the purpose also bound every request, " +
    "and the strictest of the three wins.";
}
