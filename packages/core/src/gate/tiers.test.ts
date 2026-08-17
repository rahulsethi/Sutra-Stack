// SPDX-License-Identifier: Apache-2.0
/**
 * AATMA · the tier-model regression net
 * and extended with the raise-only assertions that invariant I14 needs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  coerceTier,
  displayTier,
  TIER_DISPLAY,
  TIER_RANK,
  strictestTier,
  raiseOnly,
  isDownscope,
  isDoNotLearn,
  isKnownTierSpelling,
  UNLABELLED_TIER,
} from "./tiers.js";

test("coerceTier accepts the user-facing names as aliases → internal tiers", () => {
  assert.equal(coerceTier("secret"), "local_only");
  assert.equal(coerceTier("private"), "review_required");
  assert.equal(coerceTier("public"), "hosted_allowed");
});

test("coerceTier still accepts the internal names; junk/empty → private", () => {
  assert.equal(coerceTier("local_only"), "local_only");
  assert.equal(coerceTier("review_required"), "review_required");
  assert.equal(coerceTier("hosted_allowed"), "hosted_allowed");
  assert.equal(coerceTier("garbage"), "review_required");
  assert.equal(coerceTier(""), "review_required");
  assert.equal(coerceTier(undefined), "review_required");
  assert.equal(coerceTier(null), "review_required");
  assert.equal(coerceTier(42), "review_required");
  assert.equal(coerceTier({}), "review_required");
});

test("TIER_DISPLAY renders the user-facing spelling for every internal tier", () => {
  assert.equal(TIER_DISPLAY[coerceTier("local_only")], "secret");
  assert.equal(TIER_DISPLAY[coerceTier("review_required")], "private");
  assert.equal(TIER_DISPLAY[coerceTier("hosted_allowed")], "public");
  assert.equal(displayTier("secret"), "secret");
  assert.equal(displayTier("public"), "public");
});

/**
 * D20 — a tier rename turned the only repair script into a permanent no-op,
 * because it compared a raw frontmatter string to a literal. Both spellings
 * must behave IDENTICALLY through every comparison, forever.
 */
test("D20 · vocab/rename-safety — both spellings are byte-identical downstream", () => {
  const pairs: Array<[string, string]> = [
    ["public", "hosted_allowed"],
    ["private", "review_required"],
    ["secret", "local_only"],
  ];
  for (const [display, internal] of pairs) {
    assert.equal(coerceTier(display), coerceTier(internal), `${display} vs ${internal}`);
    assert.equal(TIER_RANK[coerceTier(display)], TIER_RANK[coerceTier(internal)]);
    assert.equal(displayTier(display), displayTier(internal));
  }
});

test("D20 · casing and whitespace do not change a tier", () => {
  assert.equal(coerceTier("  SECRET  "), "local_only");
  assert.equal(coerceTier("Public"), "hosted_allowed");
  assert.equal(coerceTier("Local_Only"), "local_only");
  assert.equal(coerceTier("local-only"), "local_only");
});

test("isKnownTierSpelling distinguishes a real tier from the fallback", () => {
  assert.equal(isKnownTierSpelling("secret"), true);
  assert.equal(isKnownTierSpelling("hosted_allowed"), true);
  // This is the point: coerceTier("typo") returns a valid tier, so a caller that
  // needs to know "was this actually labelled?" cannot use coerceTier alone.
  assert.equal(isKnownTierSpelling("typo"), false);
  assert.equal(coerceTier("typo"), UNLABELLED_TIER);
});

test("rank order is restrictive-ascending and is what the gate compares", () => {
  assert.ok(TIER_RANK.hosted_allowed < TIER_RANK.review_required);
  assert.ok(TIER_RANK.review_required < TIER_RANK.local_only);
});

test("strictestTier returns the most restrictive input", () => {
  assert.equal(strictestTier(["hosted_allowed", "review_required"]), "review_required");
  assert.equal(strictestTier(["hosted_allowed", "local_only", "review_required"]), "local_only");
  assert.equal(strictestTier(["hosted_allowed"]), "hosted_allowed");
});

test("strictestTier([]) is private — 'no sources' never means 'therefore public'", () => {
  assert.equal(strictestTier([]), "review_required");
});

/** INVARIANT 4 / I14 — sensitivity is raise-only. */
test("I14 · raiseOnly raises and never lowers", () => {
  assert.equal(raiseOnly("hosted_allowed", "local_only"), "local_only", "raise is honoured");
  assert.equal(raiseOnly("local_only", "hosted_allowed"), "local_only", "lower is refused");
  assert.equal(raiseOnly("review_required", "hosted_allowed"), "review_required", "lower is refused");
  assert.equal(raiseOnly("review_required", "local_only"), "local_only", "raise is honoured");
  assert.equal(raiseOnly("local_only", "local_only"), "local_only", "idempotent");
});

test("I14 · raiseOnly is total over every tier pair — no combination lowers", () => {
  const tiers = ["hosted_allowed", "review_required", "local_only"] as const;
  for (const from of tiers) {
    for (const to of tiers) {
      const result = raiseOnly(from, to);
      assert.ok(
        TIER_RANK[result] >= TIER_RANK[from],
        `raiseOnly(${from}, ${to}) = ${result} lowered the tier`,
      );
    }
  }
});

test("isDownscope names the transition I14 forbids", () => {
  assert.equal(isDownscope("local_only", "hosted_allowed"), true);
  assert.equal(isDownscope("local_only", "review_required"), true);
  assert.equal(isDownscope("review_required", "local_only"), false);
  assert.equal(isDownscope("hosted_allowed", "hosted_allowed"), false);
});

/**
 * ROADMAP E1 — the upstream system had FIVE `do_not_learn` predicates and every
 * divergence failed open in at least one of them. One predicate; assert its
 * edges, because the edges are where four of the five diverged.
 */
test("E1 · isDoNotLearn — one predicate, generous on true, strict on false", () => {
  assert.equal(isDoNotLearn({ do_not_learn: true }), true);
  assert.equal(isDoNotLearn({ do_not_learn: "true" }), true);
  assert.equal(isDoNotLearn({ do_not_learn: "TRUE" }), true);
  assert.equal(isDoNotLearn({ do_not_learn: " True " }), true);
  assert.equal(isDoNotLearn({ do_not_learn: "yes" }), true);
  assert.equal(isDoNotLearn({ do_not_learn: "1" }), true);

  assert.equal(isDoNotLearn({ do_not_learn: false }), false);
  assert.equal(isDoNotLearn({ do_not_learn: "false" }), false);
  assert.equal(isDoNotLearn({}), false);
  assert.equal(isDoNotLearn(null), false);
  assert.equal(isDoNotLearn(undefined), false);
});
