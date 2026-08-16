// SPDX-License-Identifier: LicenseRef-Sutra-Commercial
/**
 * @sutra/ee — SUTRA ENTERPRISE EDITION.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THIS SUBTREE IS NOT OPEN SOURCE. See `ee/LICENSE`.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ── THE SHAPE ──────────────────────────────────────────────────────────────
 * A customer-hosted CONTROL PLANE issuing signed policy bundles to an UNCHANGED
 * file-and-git DATA PLANE — which keeps working, and stays air-gappable, when
 * the control plane is unreachable.
 *
 * We sell software and support. The customer brings the infrastructure. There
 * is no Sutra-operated service in this picture, because the product's entire
 * claim is that your knowledge stays where you put it, and running it for you
 * would contradict that.
 *
 * ── WHY THIS IS CREDIBLE, STATED HONESTLY ──────────────────────────────────
 * The enterprise-readiness scorecard behind this edition is 1 CURRENT / 7
 * PARTIAL / 8 MISSING, and the split is what makes it worth building: the DATA
 * PLANE — classification, egress gating, per-class provider allowlisting,
 * residency, offline operation — is largely built and battle-scarred. The
 * CONTROL PLANE — tenancy, identity, RBAC, SSO, KMS, retention, supply chain,
 * certification — was entirely absent, and it is commodity work.
 *
 * The differentiator was already there. The commodity half is what this is.
 *
 * ── THE INVARIANT THAT MAKES THIS SAFE TO SELL ─────────────────────────────
 * EVERYTHING IN THIS SUBTREE CAN ONLY NARROW. There is no code path here that
 * makes content more visible than the Apache-2.0 Core would have made it. It is
 * asserted over the full cross-product on every build
 * (`policy/engine.test.ts` → "ENTERPRISE NARROWS, NEVER WIDENS").
 *
 * A customer's security review therefore reduces to: read Core's ~600-line
 * gate, then confirm that assertion still passes. That is a review a team can
 * actually complete, which is worth more than a longer list of features.
 *
 * ── CORE NEVER IMPORTS FROM HERE ───────────────────────────────────────────
 * `rm -rf ee/` leaves a complete, fully-tested, Apache-2.0 product. CI proves
 * it on every commit (`scripts/check-core-alone.mjs`). The dependency arrow
 * points one way: ee -> core, never core -> ee.
 *
 * ── THE MODULES ────────────────────────────────────────────────────────────
 *   E1  policy/engine      one policy engine; the gate is imported, not re-implemented
 *   E2  identity/subject   SSO claims -> clearance; groups, RBAC
 *       policy/engine      purpose limitation, per-tenant provider allowlists
 *   E3  audit/chain        tamper-EVIDENT hash chain, retention classes, external anchor
 *   E4  keys/kms           KMS/HSM seam; no plaintext key material in the product
 *   E5  policy/bundle      signed, versioned, expiring bundles; break-glass is audited, not available
 *   E6  supply/sbom        SBOM, signed releases, dependency policy
 *   E7  classifier/external  the customer's own DLP supplies the tier; strictest wins
 */

export * from "./policy/engine.js";
export * from "./policy/bundle.js";
export * from "./identity/subject.js";
export * from "./audit/chain.js";
export * from "./keys/kms.js";
export * from "./classifier/external.js";
export * from "./supply/sbom.js";

/**
 * The edition banner, printed by `sutra doctor` when this subtree is present.
 *
 * It names what is NOT satisfied as readily as what is. A product that tells a
 * customer their KMS is unconfigured before their auditor does is one whose
 * other claims get believed.
 */
export function editionBanner(): string {
  return [
    "Sutra Enterprise Edition",
    "  Commercial licence (ee/LICENSE). Not covered by the Apache-2.0 root LICENSE.",
    "  `rm -rf ee/` leaves a complete, functional, Apache-2.0 product — CI proves it every commit.",
    "  Everything in this subtree can only NARROW access, never widen it.",
  ].join("\n");
}
