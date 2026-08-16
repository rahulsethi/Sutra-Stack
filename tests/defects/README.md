<!-- SPDX-License-Identifier: Apache-2.0 -->
# The absence tests

> One named test per inherited defect. A defect is **not inherited** only when
> its test exists, **fails against a deliberately planted instance**, and passes
> against the product.

Sutra is an *extraction* from a live system, so by default it inherits every
defect that system had — including the ones that had been shipping unnoticed for
the life of the repo. "Fixed in the upstream" is not "absent from Sutra": that
was a patch to a different codebase, and a patch is not a guarantee.

Only the test is.

## The rule these tests exist to enforce

**A guardrail test that has never been seen to fail is not evidence of anything.**

Every test in this directory therefore does two things:

1. **Plants the defect** and asserts the guard trips.
2. Asserts the guard is silent on the correct case.

A test that only did (2) would pass just as happily against a guard that had
been deleted. That is not a hypothetical: the upstream path-floor band had
*never once fired* — it was present, plausible, referenced in the docs, and
matched nothing at all. Nothing counted rule hits, so a rule that fires zero
times looked exactly like a rule protecting a clean corpus.

## Layout

| File | Covers |
|---|---|
| `no-input-clip.test.ts` | D1 — the 6,000-char clip, greps the tree for its shape |
| `secret-floor.test.ts` | I13 — the floor, and the import graph that keeps break-glass off agent paths |
| `no-ceiling-argument.test.ts` | Invariant 2 — no tool accepts a ceiling, at the schema level |
| `raise-only.test.ts` | I14 — no path lowers a tier, over the full tier cross-product |
| `created-not-wired.test.ts` | §9.1 — every declared job, script and route has a caller |
| `outcome-counters.test.ts` | D11 — five outcomes never share a counter |
| `header-matches-body.test.ts` | D13/I18 — every derived JSON header equals its body |

The per-defect tests that live closest to their subject stay there instead —
`gate/patterns.test.ts` carries D4, D5, D14 and D24; `run/lock.test.ts` carries
D9. This directory holds the ones that are **cross-cutting**: properties no
single module owns, which is exactly where a defect hides.

## Running them

```sh
npm run test:defects
```

They also run as part of `npm test` and in CI on every commit.
