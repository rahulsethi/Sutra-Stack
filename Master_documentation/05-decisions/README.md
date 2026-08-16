<!-- SPDX-License-Identifier: Apache-2.0 -->
# 05 · Decisions

Load-bearing choices: what, why, the alternative, and how reversible.

---

## D-001 · Apache-2.0 for Core, commercial for `ee/`
**2026-08-15 · owner decision · hard to reverse**

Apache's **explicit patent grant** is what enterprise legal teams check for; MIT
has none, and for a product whose pitch is governance that is a weak posture.

**Alternative considered:** AGPL, which would force a hosted competitor to
publish changes — but many companies **ban AGPL outright**, including the
enterprise buyer v2.0 targets. You would be protecting against a competitor by
excluding your own customer.

**Reversibility:** low. Relicensing needs every contributor's agreement, which is
exactly why D-002 exists.

---

## D-002 · CLA, not DCO
**2026-08-15 · owner decision · irreversible after the first outside PR**

Selling `ee/` under commercial terms requires the right to relicense what ships
in it. An Apache-2.0 patch grants a licence, **not** the ability to relicense —
so without a CLA, dual licensing quietly breaks.

**Alternative:** DCO plus keeping `ee/` strictly first-party. Workable, and a
real option.

**Reversibility:** none, retroactively.

---

## D-003 · Deterministic-only first run
**2026-08-15 · BUILD-PLAN M2's open dependency**

A fresh install with no key returns a **grounded, cited answer** — the relevant
passages from the user's own notes, labelled and traceable.

**Alternatives:** bundle a local model (a download size and a hardware floor in
the onboarding path); or ship a keyless free tier (a shared quota you pay for,
which **dies the moment the project is popular**).

**Why this one:** honest, zero-cost, works offline forever, and degrades in the
one direction that never breaks. An answer assembled from real sources with real
citations is useful even when it is not fluent.

**Reversibility:** high — a provider can be added later without moving the floor.

---

## D-004 · The vault is a separate repo, not a submodule
**Structural**

A submodule reconcile always aborts on a dirty working tree, which is every node
that runs the pipeline, and every remedy for that message is destructive. See
[`02-architecture`](../02-architecture/).

**Reversibility:** high, and would be a mistake.

---

## D-005 · One pattern set, N thin bindings
**Structural · the E1 lesson applied pre-emptively**

`secret-patterns.json` is the single source of truth, read by four consumers.
The upstream system had **six re-implementations of one tier comparison across
three languages**, and every divergence failed open in at least one of them.

**Alternative:** per-language rule sets kept in sync by discipline. That is
precisely what failed.

**Reversibility:** high, and would reintroduce the defect.

---

## D-006 · `ee/` may only narrow
**Structural · the reason Enterprise is sellable**

`tier ≤ min(clearance, surface, purpose)`. There is no path in `ee/` that makes
content more visible than Core would have. Asserted over all 162 combinations on
every build.

**Why:** it lets a customer's security review reduce to *"read Core's 600-line
gate, then check that assertion still passes"* — a review a team can finish.

**Reversibility:** technically high, practically none. Breaking it forfeits the
property the edition is sold on.

---

## D-007 · Deferred synthesis dispatch
**2026-08-16 · a gap, recorded honestly**

`Invoke-Synthesis` selects a provider, records health, and returns `$null`.
There is no HTTP client.

**Why:** Sutra ships deterministic-first, and a half-written client that
sometimes works is worse than an honest "no model configured". But this is a
**gap**, not a feature, and it is in the drift table.

**Reversibility:** trivial. Whatever implements it must receive the extract in
full — see D1.
