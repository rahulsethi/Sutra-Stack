<!-- SPDX-License-Identifier: Apache-2.0 -->
# CLAUDE.md — working on Sutra

> Instructions for any AI agent working **on this codebase**. If you are an
> assistant working **with** a user's Sutra vault, you want
> [`AGENTS.md`](AGENTS.md) instead.

---

## 1 · What this is

Sutra is a **governed personal knowledge substrate**. Notes are plain markdown
in a git repo the user owns. Every note carries a `sensitivity` tier. A
deterministic pipeline turns captures into durable, linked, searchable
knowledge. A **gate** sits between that knowledge and every AI model, and the
model cannot lift it.

The product's claim is not "another note app". It is: *your AI can reason over
everything you know, and provably cannot leak what you marked private.*

The demo that proves it is one tool call:

```
sutra gate
  Ceiling: public.  Visible: 812.
  Withheld — private: 401, secret: 37, do_not_learn: 12.
```

**Everything in this repository exists to keep that sentence true.** When a
change would make it less true, the change is wrong, regardless of what else it
improves.

---

## 2 · The eight invariants

These are the product. Everything else is negotiable.

1. **The user's repo is the truth.** Plain markdown plus git. Caches, indexes,
   graphs and exports are disposable and rebuildable. Never invent a parallel
   store.
2. **The gate is server-side and the model cannot lift it.** The exposure
   ceiling is read from the environment **at server startup**, never accepted as
   a tool argument.
3. **The secret floor is absolute.** `local_only` content never reaches any
   LLM, hosted or local-via-a-harness. Not under an override, not under a flag,
   not for convenience. Four independent enforcement points; all four stay.
4. **Sensitivity is raise-only.** Classification floors first, then only ever
   raises. No path may lower a tier.
5. **Never commit secrets.** The pre-commit guard is a release gate, not a
   nicety.
6. **Writes are narrow, floored, additive, audited.** The only agent write path
   is a capture into the inbox, floored to private, never overwriting, behind a
   fail-closed opt-in.
7. **Reversible-auto with an audit trail.** Automated maintenance may act
   without asking *because* every action is git-tracked and reversible.
8. **Deterministic-first.** A model lifts one field, never the file layout, the
   ids, the tiers or the links. Everything degrades to a correct deterministic
   result when no model is available.

---

## 3 · Rules for changing this code

### Degradation is allowed. Silent degradation is not.

Every stage may produce less than its ideal output — no key, no model, no
network, a tool missing. What it may **never** do is produce less and report
success.

The test for any change: *if this silently produced nothing for a month, how
would the user find out?* If the answer is "they wouldn't", the change is not
done.

Concretely: `ok` / `degraded` / `failed` / `skipped (no input)` /
`skipped (policy)` are **five different things** and must never share a counter.

### Write the test before you believe the fix

This is the rule the upstream project kept re-learning, at cost. On one
occasion a type-resolution bug was fixed and its invariant test written
afterwards — the test immediately **failed**, exposing three further instances
of the same defect the "fix" had left untouched.

It happened again during this build: the positive-coverage test caught three
detection rules whose fixtures were one character short of their own patterns —
dead rules that would have looked exactly like rules protecting a clean corpus.

Budget for the test finding more than you expected.

### Assert positive coverage on every guard

A rule that fires zero times looks **exactly** like a rule protecting a clean
corpus. Every detection rule ships with a fixture it must match, asserted in CI.
Every guard ships with a case that must trip it.

A guardrail test that has never been seen to fail is not evidence of anything.

### One policy engine, N thin bindings

The upstream system had **six re-implementations of one tier comparison across
three languages**, and five different `do_not_learn` predicates. *Every
divergence failed open in at least one of them.*

So: `automation/policies/secret-patterns.json` is the single source of truth for
detection, read by the TypeScript classifier, the PowerShell scanner, the
commit hook and the leak scan. `packages/core/src/gate/tiers.ts` is the single
tier normaliser.

**If you are about to add a regex to a scanner, add it to the JSON instead.** A
rule that exists in only one language is a rule that does not exist on the paths
written in the other. `Classify.test.ts` asserts the two bindings classify an
identical corpus identically.

### Never compare a raw frontmatter string to a literal

A tier rename once turned the only repair script into a permanent no-op: it
filtered on `hosted_allowed`, a later normalisation renamed that tier to
`public`, and it silently skipped 100% of candidates while exiting 0. Resolve
through `coerceTier` / `Resolve-Tier`, always.

### No input clip. Anywhere. Ever.

One line truncated every source to 6,000 characters before synthesis. It
produced 424 pages that were **confident, fluent, correctly formatted and wrong
in specifics** — and page length was flat across two orders of magnitude of
source size, so nothing looked anomalous.

If a source exceeds the window: chunk-and-merge, or refuse. Never prefix. Record
`source_chars_seen` and `source_chars_total` so truncation is a fact on the
artifact rather than an inference.

### Created ≠ wired

The most repeated failure in the upstream project. A timer installed but never
enabled. A script with no scheduler. Thirteen dashboard routes unreachable from
the dashboard's own navigation.

**After every build step, grep for the caller, not the file.** Its twin: *run ≠
scheduled* — the script that produced 71% of the upstream corpus was never
scheduled and ran once, by hand, with a truncation bug in it.

### Surgical changes

Touch only what the request requires. Match the surrounding style. Remove only
what your change made unused.

---

## 4 · Repository map

```
packages/core/       @sutra/core   — the governance core. ONE dependency.
  src/gate/          tiers · guard · exposure · containment · patterns · redact · override
  src/vault/         client · brain (the gated corpus) · capture (the floored write)
  src/retrieval/     lexical (BM25+RRF) · semantic · graph · hybrid · section · ask
  src/run/           outcome · metrics · lock
  src/audit/         log · provider health
packages/mcp/        sutra-mcp    — stdio JSON-RPC, 14 tools. ZERO dependencies.
packages/cli/        sutra        — --json everywhere; exit codes are governance signals
packages/daemon/     OPTIONAL, shape (c). Deleting it must break nothing.
packages/dashboard/  OPTIONAL, shape (c).
vault-template/      the skeleton. ZERO notes.
automation/          the pipeline (pwsh 7 + optional Python)
  policies/secret-patterns.json   ← THE single source of truth for detection
plugins/             claude-code · hermes · codex
ee/                  COMMERCIAL. Apache-2.0 does NOT apply here. See ee/LICENSE.
tests/defects/       one named absence test per inherited defect
```

### Where the important things live

| Question | Answer |
|---|---|
| What can a model see? | `packages/core/src/vault/brain.ts` → `visible()` |
| The gate itself | `packages/core/src/gate/guard.ts` — ~120 lines, no dependencies |
| Detection rules | `automation/policies/secret-patterns.json` — **never hardcode a pattern** |
| Exit-code meanings | `packages/cli/src/exit.ts` |
| Why is it built this way? | The defect manifest — every design decision cites one |

---

## 5 · Before you commit

```sh
npm run verify     # build · test · licence · no-bun · leak-scan · ee · core-alone
```

Individually:

| Command | Guards |
|---|---|
| `npm test` | the regression net |
| `npm run leak-scan` | §8 — nothing personal ships |
| `npm run check:license` | the Apache/commercial boundary |
| `npm run check:core-alone` | `rm -rf ee/` still builds and passes |
| `npm run check:no-bun` | the core stays runtime-agnostic |
| `pwsh automation/scripts/lib/Classify.test.ps1` | the PS/TS classifier parity |

**Install the hooks once per clone:** `git config core.hooksPath .githooks`

**Please do not use `--no-verify`.** The upstream repo accumulated 128
occurrences across 91 files because its hook cried wolf and hung — and thereby
kept the *belief* that its commits were scanned while every large commit skipped
the scan. If a rule is wrong, that is a bug worth fixing at the rule.

---

## 6 · The licence boundary

| Path | Licence |
|---|---|
| everything except `ee/` | Apache-2.0 |
| `ee/` | commercial — **not** open source |

Two rules, enforced in CI on every commit:

1. **Core never imports from `ee/`.** `rm -rf ee/` must build and pass the full
   suite.
2. **Every file carries an SPDX header,** and the commercial identifier never
   appears outside `ee/`.

Everything in `ee/` can only **narrow** access, never widen it — asserted over
the full cross-product on every build. That property is what lets a security
review reduce to "read Core's gate".

---

## 7 · Stop and ask

Three things are owner decisions, not agent decisions:

- **the licence** (settled: Apache-2.0 + CLA),
- **anything touching the secret floor**,
- **any change to the four hard-gate invariants** (I13, I14, I16, I19).

And one thing is owner-only work: **credential rotation**. Re-tiering is
containment, not remedy — cleartext stays in git history, and only rotation
fixes it.

---

## 8 · Report honestly

If a verify-check did not run, say so. Do not report a milestone complete on the
strength of code you have not exercised.

This project's own register carries a section for the wrong claims made during
its audit, precisely because that habit is load-bearing. Four of six were from
*measuring the wrong thing* rather than from missing data. Where a number drives
a destructive action, measure it two ways before acting — and state what has
**not** been verified in the same breath as what has.
