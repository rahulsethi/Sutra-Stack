// SPDX-License-Identifier: LicenseRef-Sutra-Commercial
/**
 * The Enterprise engine's contract tests.
 *
 * The exhaustive `narrowsOnly` sweep at the bottom is the one that matters. It
 * is the mechanical form of the claim a customer's security team is actually
 * buying: *reviewing Core's 600-line gate is sufficient, because Enterprise can
 * only ever answer "no" more often.*
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, effectiveCeiling, providerAllowed, narrowsOnly, type Subject, type Surface, type Purpose } from "./engine.js";
import type { Tier } from "@sutra/aatma-core";

const ALL: Tier[] = ["hosted_allowed", "review_required", "local_only"];

const subject = (clearance: Tier, groups: string[] = []): Subject => ({
  id: "u-1", tenant: "t-1", groups, clearance,
});
const surface = (ceiling: Tier, allowedProviders?: string[]): Surface =>
  allowedProviders ? { id: "s-1", ceiling, allowedProviders } : { id: "s-1", ceiling };
const purpose = (ceiling: Tier): Purpose => ({ id: "p-1", ceiling, description: "test" });

// ─────────────────────────────────────────────────────────────────────────────
// E2 · the composed ceiling
// ─────────────────────────────────────────────────────────────────────────────

test("E2 · the effective ceiling is the STRICTEST of the three", () => {
  assert.equal(effectiveCeiling("local_only", "review_required", "hosted_allowed").ceiling, "hosted_allowed");
  assert.equal(effectiveCeiling("hosted_allowed", "local_only", "local_only").ceiling, "hosted_allowed");
  assert.equal(effectiveCeiling("local_only", "local_only", "local_only").ceiling, "local_only");
});

test("E2 · the decision NAMES which constraint bound it", () => {
  // An access decision a customer cannot explain is one they cannot defend.
  const d = evaluate({
    contentTier: "private", doNotLearn: false,
    subject: subject("local_only"), surface: surface("local_only"), purpose: purpose("hosted_allowed"),
  });
  assert.equal(d.allowed, false);
  assert.equal(d.boundBy, "purpose");
  assert.match(d.reason, /purpose/);
});

test("E2 · purpose limitation binds independently of clearance", () => {
  // A fully-cleared subject on a fully-trusted surface, asking for a purpose
  // that does not admit private data. GDPR Art. 5(1)(b) in one assertion.
  const d = evaluate({
    contentTier: "private", doNotLearn: false,
    subject: subject("local_only"), surface: surface("local_only"), purpose: purpose("hosted_allowed"),
  });
  assert.equal(d.allowed, false, "clearance must not defeat purpose limitation");
});

test("E2 · a subject's clearance binds independently of the surface", () => {
  const d = evaluate({
    contentTier: "private", doNotLearn: false,
    subject: subject("hosted_allowed"), surface: surface("local_only"), purpose: purpose("local_only"),
  });
  assert.equal(d.allowed, false);
  assert.equal(d.boundBy, "subject");
});

// ─────────────────────────────────────────────────────────────────────────────
// The floor, which no role reaches
// ─────────────────────────────────────────────────────────────────────────────

test("NO CLEARANCE reaches secret content on a model surface", () => {
  // The question every enterprise buyer asks: can an admin override it?
  for (const clearance of ALL) {
    for (const purposeCeiling of ALL) {
      const d = evaluate({
        contentTier: "secret", doNotLearn: false,
        subject: subject(clearance, ["tenant-admin", "super-admin", "break-glass"]),
        surface: surface("hosted_allowed"),
        purpose: purpose(purposeCeiling),
      });
      assert.equal(d.allowed, false, `clearance=${clearance} purpose=${purposeCeiling} reached secret content`);
      assert.equal(d.boundBy, "secret-floor");
    }
  }
});

test("the secret floor is checked BEFORE clearance is read", () => {
  const d = evaluate({
    contentTier: "secret", doNotLearn: false,
    subject: subject("local_only", ["super-admin"]),
    surface: surface("hosted_allowed"), purpose: purpose("local_only"),
  });
  assert.equal(d.boundBy, "secret-floor", "the ordering is the guarantee, not a policy setting");
  assert.match(d.reason, /no break-glass/);
});

test("do_not_learn is absolute, at every tier and every clearance", () => {
  for (const contentTier of ALL) {
    for (const clearance of ALL) {
      const d = evaluate({
        contentTier, doNotLearn: true,
        subject: subject(clearance, ["super-admin"]),
        surface: surface("local_only"), purpose: purpose("local_only"),
      });
      assert.equal(d.allowed, false, `${contentTier}/${clearance} reached do_not_learn content`);
      assert.equal(d.boundBy, "do-not-learn");
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// E2 · the provider allowlist
// ─────────────────────────────────────────────────────────────────────────────

test("E2 · an UNCONFIGURED provider allowlist denies", () => {
  // A tenant who has not chosen their approved processors has not implicitly
  // approved all of them.
  const r = providerAllowed(surface("hosted_allowed"), "any-provider");
  assert.equal(r.allowed, false);
  assert.match(r.reason, /not yet decided|undecided|no provider allowlist/i);
});

test("E2 · the allowlist is a separate question from tier", () => {
  const s = surface("hosted_allowed", ["approved-eu"]);
  assert.equal(providerAllowed(s, "approved-eu").allowed, true);
  assert.equal(providerAllowed(s, "unapproved-us").allowed, false,
    "public content may still be barred from an unapproved processor");
});

// ─────────────────────────────────────────────────────────────────────────────
// THE INVARIANT — the exhaustive sweep
// ─────────────────────────────────────────────────────────────────────────────

test("ENTERPRISE NARROWS, NEVER WIDENS — over the full cross-product", () => {
  let checked = 0;
  const violations: string[] = [];

  for (const contentTier of ALL) {
    for (const doNotLearn of [false, true]) {
      for (const clearance of ALL) {
        for (const surfaceCeiling of ALL) {
          for (const purposeCeiling of ALL) {
            checked++;
            const r = narrowsOnly({
              contentTier, doNotLearn,
              subject: subject(clearance, ["tenant-admin"]),
              surface: surface(surfaceCeiling),
              purpose: purpose(purposeCeiling),
            });
            if (!r.holds) {
              violations.push(
                `content=${contentTier} dnl=${doNotLearn} clearance=${clearance} ` +
                `surface=${surfaceCeiling} purpose=${purposeCeiling}: ${r.detail}`,
              );
            }
          }
        }
      }
    }
  }

  assert.equal(checked, 3 * 2 * 3 * 3 * 3, "the sweep must cover every combination");
  assert.deepEqual(violations, [],
    "Enterprise widened exposure somewhere. That breaks the property a customer's security review " +
    "depends on: that reading Core's gate is sufficient.\n" + violations.join("\n"));
});

test("with every constraint maximally permissive, Enterprise matches Core exactly", () => {
  // The boundary of "narrows": at the limit it must be a no-op, or Enterprise
  // would be silently restricting things nobody configured it to restrict.
  for (const contentTier of ALL) {
    for (const surfaceCeiling of ALL) {
      const ee = evaluate({
        contentTier, doNotLearn: false,
        subject: subject("local_only"), surface: surface(surfaceCeiling), purpose: purpose("local_only"),
      });
      const coreWouldAllow = surfaceCeiling === "local_only" || contentTier === "hosted_allowed" ||
        (contentTier === "review_required" && surfaceCeiling === "review_required");
      assert.equal(ee.allowed, coreWouldAllow,
        `content=${contentTier} surface=${surfaceCeiling}: Enterprise diverged from Core at the permissive limit`);
    }
  }
});

test("the audit record carries everything an auditor needs and no content", () => {
  const d = evaluate({
    contentTier: "private", doNotLearn: false,
    subject: { id: "u-9", tenant: "acme", groups: ["eng"], clearance: "review_required", displayName: "A Person" },
    surface: surface("hosted_allowed"), purpose: purpose("review_required"),
  });
  assert.equal(d.audit.subject, "u-9");
  assert.equal(d.audit.tenant, "acme");
  assert.equal(d.audit.contentTier, "review_required");
  assert.equal(d.audit.subjectClearance, "review_required");
  // The record names the note's TIER, never its text or its path.
  assert.ok(!JSON.stringify(d.audit).includes("A Person"),
    "a display name is not needed for a decision and should not be in the decision record");
});
