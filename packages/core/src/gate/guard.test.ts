// SPDX-License-Identifier: Apache-2.0
/**
 * The gate's regression net. This file is the reason anyone should trust Sutra.
 *
 * Release gate 1 (00-MASTER-BUILD-BRIEF.md §10): "with a hosted-ceiling MCP
 * registration, a local_only note and a do_not_learn note are provably absent
 * from every tool's output. This test is non-negotiable and runs in CI."
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sensitivityGuard,
  providerAcceptsTier,
  guardDispatch,
  isSecretFloor,
  mayEverLeaveMachine,
  type ProviderMode,
} from "./guard.js";
import type { Tier } from "./tiers.js";

const ALL_TIERS: Tier[] = ["hosted_allowed", "review_required", "local_only"];

test("hosted destination accepts ONLY hosted_allowed", () => {
  assert.equal(sensitivityGuard("hosted_allowed", "hosted_allowed").allowed, true);
  assert.equal(sensitivityGuard("review_required", "hosted_allowed").allowed, false);
  assert.equal(sensitivityGuard("local_only", "hosted_allowed").allowed, false);
});

test("local destination accepts every tier", () => {
  for (const t of ALL_TIERS) {
    assert.equal(sensitivityGuard(t, "local_only").allowed, true, `${t} → local`);
  }
});

test("review_required destination accepts public and private, never secret", () => {
  assert.equal(sensitivityGuard("hosted_allowed", "review_required").allowed, true);
  assert.equal(sensitivityGuard("review_required", "review_required").allowed, true);
  assert.equal(sensitivityGuard("local_only", "review_required").allowed, false);
});

test("a refusal explains itself in a sentence a human can act on", () => {
  const d = sensitivityGuard("local_only", "hosted_allowed");
  assert.equal(d.allowed, false);
  assert.match(d.reason, /local_only/);
  assert.match(d.reason, /hosted_allowed/);
  assert.notEqual(d.reason, "ok");
});

/**
 * INVARIANT 3 · THE SECRET FLOOR IS ABSOLUTE.
 *
 * Exhaustive, not representative. The claim is "never, under any
 * configuration", so the test enumerates every configuration rather than
 * sampling three of them.
 */
test("I13 · secret floor — local_only reaches NO destination but a local one", () => {
  const modes: ProviderMode[] = ["local", "hosted", "manual", "skip"];
  for (const mode of modes) {
    const decision = guardDispatch("local_only", mode);
    const onMachine = mode === "local" || mode === "manual";
    assert.equal(
      decision.allowed,
      onMachine,
      `local_only → ${mode} should be ${onMachine ? "allowed (stays on this machine)" : "REFUSED"}`,
    );
  }
});

test("I13 · secret floor — no destination tier admits local_only except local_only", () => {
  for (const dest of ALL_TIERS) {
    const allowed = sensitivityGuard("local_only", dest).allowed;
    assert.equal(allowed, dest === "local_only", `local_only → ${dest}`);
  }
});

test("isSecretFloor names the floor without rank arithmetic", () => {
  assert.equal(isSecretFloor("local_only"), true);
  assert.equal(isSecretFloor("review_required"), false);
  assert.equal(isSecretFloor("hosted_allowed"), false);
});

test("mayEverLeaveMachine refuses the floor and do_not_learn independently", () => {
  assert.equal(mayEverLeaveMachine("local_only", false).allowed, false);
  assert.equal(mayEverLeaveMachine("hosted_allowed", true).allowed, false,
    "a PUBLIC note marked do_not_learn still may not be sent — the axes are independent");
  assert.equal(mayEverLeaveMachine("review_required", true).allowed, false);
  assert.equal(mayEverLeaveMachine("hosted_allowed", false).allowed, true);
});

test("mayEverLeaveMachine's refusals name which rule fired", () => {
  assert.match(mayEverLeaveMachine("hosted_allowed", true).reason, /do_not_learn/);
  assert.match(mayEverLeaveMachine("local_only", false).reason, /secret floor/);
});

/** D17 — a guard's fallback path must be tested for the guard's own inversion. */
test("D17 · providerAcceptsTier('skip') returns null, and null blocks everything", () => {
  assert.equal(providerAcceptsTier("skip"), null);
  for (const t of ALL_TIERS) {
    const d = guardDispatch(t, "skip");
    assert.equal(d.allowed, false, `${t} → skip must be refused, not defaulted through`);
    assert.match(d.reason, /accepts no content/);
  }
});

test("D17 · a 'skip' destination refuses even PUBLIC content — no permissive default", () => {
  // The inversion this guards against: treating `null` as "unknown, therefore
  // allow". If that regressed, this is the assertion that would catch it, since
  // hosted_allowed is the tier a permissive default would happily let through.
  assert.equal(guardDispatch("hosted_allowed", "skip").allowed, false);
});

test("provider modes map to the tier floor they accept", () => {
  assert.equal(providerAcceptsTier("local"), "local_only");
  assert.equal(providerAcceptsTier("hosted"), "hosted_allowed");
  assert.equal(providerAcceptsTier("manual"), "local_only");
});

/**
 * The full 3×4 matrix, written out. A property test would be shorter; this is
 * deliberately not shorter. When someone changes the gate, the diff on this
 * table is the review.
 */
test("the complete tier × destination decision matrix", () => {
  const expected: Record<Tier, Record<ProviderMode, boolean>> = {
    hosted_allowed: { local: true, hosted: true, manual: true, skip: false },
    review_required: { local: true, hosted: false, manual: true, skip: false },
    local_only: { local: true, hosted: false, manual: true, skip: false },
  };
  for (const tier of ALL_TIERS) {
    for (const mode of ["local", "hosted", "manual", "skip"] as ProviderMode[]) {
      assert.equal(
        guardDispatch(tier, mode).allowed,
        expected[tier][mode],
        `${tier} → ${mode}`,
      );
    }
  }
});
