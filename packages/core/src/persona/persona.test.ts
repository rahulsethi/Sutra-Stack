// SPDX-License-Identifier: Apache-2.0
/**
 * The persona layer's regression net.
 *
 * The routing tests matter more than they look: a routing module is the most
 * likely place for a seventh re-implementation of the tier comparison to
 * appear, disguised as "just a quick check before we dispatch". So these
 * assertions are exhaustive over the tier × provider cross-product rather than
 * illustrative.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { routeTurn } from "./routing.js";
import { assemblePersonaPrompt, type PersonaBundle } from "./prompt.js";
import type { Tier } from "../gate/tiers.js";

const ALL: Tier[] = ["hosted_allowed", "review_required", "local_only"];

// ─────────────────────────────────────────────────────────────────────────────
// Routing
// ─────────────────────────────────────────────────────────────────────────────

test("a local model may receive every tier", () => {
  for (const t of ALL) {
    assert.equal(routeTurn(t, "local").allowed, true, `${t} → local`);
    assert.equal(routeTurn(t, "local").target, "local");
  }
});

test("a hosted model may receive PUBLIC only", () => {
  assert.equal(routeTurn("public", "openai").allowed, true);
  assert.equal(routeTurn("private", "openai").allowed, false);
  assert.equal(routeTurn("secret", "openai").allowed, false);
});

test("an UNRECOGNISED provider is treated as HOSTED, not local", () => {
  // The direction of this default is the whole point: a typo, a renamed
  // upstream, or a provider called `local-ish` must fail toward the restrictive
  // reading. The alternative is that a misspelling silently becomes a trusted
  // destination.
  for (const p of ["", "  ", "locale", "local-ish", "LOCAL_MODEL", "unknown", "llocal"]) {
    assert.equal(routeTurn("secret", p).target, "hosted", `provider "${p}" must be hosted`);
    assert.equal(routeTurn("secret", p).allowed, false);
  }
  // …and the positive control, so this cannot pass by calling everything hosted.
  assert.equal(routeTurn("secret", "local").target, "local");
  assert.equal(routeTurn("secret", " LOCAL ").target, "local", "case and whitespace are tolerated");
});

/** INVARIANT 3, through the routing path. */
test("I13 · SECRET + HOSTED is refused, override or not, over every combination", () => {
  for (const provider of ["openai", "anthropic", "google", "some-gateway", ""]) {
    for (const override of [false, true]) {
      const d = routeTurn("secret", provider, override);
      assert.equal(
        d.allowed,
        false,
        `secret reached a hosted model (provider="${provider}", override=${override}). ` +
        `The override branch must fire ONLY at the private tier.`,
      );
    }
  }
});

test("the override lifts PRIVATE for a hosted model, and only private", () => {
  assert.equal(routeTurn("private", "openai", false).allowed, false, "no override → refused");
  assert.equal(routeTurn("private", "openai", true).allowed, true, "override → allowed");
  assert.match(routeTurn("private", "openai", true).reason, /secret floor is untouched/);

  // The floor, restated as its own assertion so a future edit to the branch
  // condition breaks something named rather than something incidental.
  assert.equal(routeTurn("secret", "openai", true).allowed, false);
});

test("the override does nothing for a LOCAL target — it was already allowed", () => {
  for (const t of ALL) {
    assert.equal(routeTurn(t, "local", true).allowed, true);
    assert.equal(routeTurn(t, "local", false).allowed, true);
  }
});

test("D20 · both tier spellings route identically", () => {
  for (const [display, internal] of [["public", "hosted_allowed"], ["private", "review_required"], ["secret", "local_only"]]) {
    for (const provider of ["local", "openai"]) {
      const a = routeTurn(display!, provider);
      const b = routeTurn(internal!, provider);
      assert.equal(a.allowed, b.allowed, `${display} vs ${internal} on ${provider}`);
      assert.equal(a.ceiling, b.ceiling);
    }
  }
});

test("an unknown ceiling falls back to private, not public", () => {
  assert.equal(routeTurn("garbage", "openai").ceiling, "review_required");
  assert.equal(routeTurn("", "openai").allowed, false);
});

test("every refusal explains itself", () => {
  const d = routeTurn("secret", "openai");
  assert.notEqual(d.reason, "");
  assert.match(d.reason, /refused/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Prompt assembly
// ─────────────────────────────────────────────────────────────────────────────

const full: PersonaBundle = {
  principal: "A data architect who builds at the seam between governed data and agentic AI.",
  persona: "Direct. No preamble. Lead with the recommendation.",
  telos: "Ship a governed substrate that a stranger can stand up unaided.",
  withheld: [],
};

test("the prompt includes every identity section the gate cleared", () => {
  const p = assemblePersonaPrompt(full);
  assert.match(p, /Direct\. No preamble/);
  assert.match(p, /data architect/);
  assert.match(p, /governed substrate/);
});

test("a missing persona note falls back to a RESTRAINED default, not silence", () => {
  const p = assemblePersonaPrompt({ ...full, persona: null });
  assert.match(p, /no persona note is loaded/);
  assert.match(p, /concise, warm, direct/);
  // A florid default would be a personality the user did not choose.
  assert.ok(!/delightful|thrilled|passionate/i.test(p));
});

test("withheld identity is ACKNOWLEDGED, and its content never appears", () => {
  const p = assemblePersonaPrompt({
    principal: null,
    persona: "Direct.",
    telos: null,
    withheld: ["principal (secret)", "telos (private)"],
  });
  assert.match(p, /withheld at this sensitivity ceiling/);
  assert.match(p, /principal \(secret\)/);
  assert.match(p, /do not guess the rest/);
});

test("a model that is missing context is TOLD so — silence would invite confabulation", () => {
  const withNothing = assemblePersonaPrompt({ principal: null, persona: null, telos: null, withheld: [] });
  const withWithheld = assemblePersonaPrompt({ principal: null, persona: null, telos: null, withheld: ["principal (secret)"] });
  assert.ok(!withNothing.includes("withheld at this sensitivity ceiling"),
    "nothing was withheld, so nothing should be claimed to be");
  assert.ok(withWithheld.includes("withheld at this sensitivity ceiling"));
});

test("the floor is restated in the prompt, including 'do not look for another route'", () => {
  const p = assemblePersonaPrompt(full);
  assert.match(p, /never reveal or restate content the gate withheld/);
  assert.match(p, /do not look for another route/);
});

test("the prompt is DETERMINISTIC — identical input, byte-identical output", () => {
  assert.equal(assemblePersonaPrompt(full), assemblePersonaPrompt(full));
});

test("§8 · the shipped prompt carries no personal identifier", () => {
  // The generic prompt must name NOBODY. Identity comes from the user's own
  // vault at runtime, never from a literal in this file.
  //
  // Note what is NOT on this list any more: Parvo, Dimaag and Aatma. They were
  // here when they were internal codenames; they are now the stack's own layer
  // names, and a layer name is not a personal identifier. What is forbidden is a
  // PERSON, and one hardcoded name is what this test was written for.
  const empty = assemblePersonaPrompt({ principal: null, persona: null, telos: null, withheld: [] });
  for (const name of ["Rahul", "Sethi"]) {
    assert.ok(!empty.includes(name), `the generic prompt contains "${name}"`);
  }

  // …and it does not invent an assistant identity either. A default persona is a
  // persona the user did not choose.
  assert.ok(!/my name is|I am called/i.test(empty), "the generic prompt names the assistant");
});
