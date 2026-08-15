<!-- SPDX-License-Identifier: Apache-2.0 -->
# Contributing to Sutra

Thank you for considering a contribution. This document covers the licence
requirement first because it is the one thing that cannot be fixed after the
fact, then the practical mechanics.

---

## 1 · The licence boundary

This repository holds two differently-licensed bodies of code:

| Path | Licence | SPDX identifier |
|---|---|---|
| everything except `ee/` | Apache License 2.0 | `Apache-2.0` |
| `ee/` | Sutra Enterprise Edition License (commercial, **not** open source) | `LicenseRef-Sutra-Commercial` |

Two rules are enforced mechanically in CI on every commit:

1. **Core stands alone.** `rm -rf ee/` must build and pass the complete test
   suite. Core never imports from `ee/`.
2. **Every file declares its licence,** and `LicenseRef-Sutra-Commercial` never
   appears outside `ee/`.

Run both locally before opening a pull request:

```bash
npm run check:license      # SPDX headers + boundary
npm run check:core-alone   # deletes ee/ in a temp worktree, builds, tests
```

## 2 · The CLA

**Sutra requires a signed Contributor Licence Agreement before your first pull
request can be merged.** This is not bureaucracy for its own sake; it is a
direct consequence of the open-core model. Selling `ee/` under commercial terms
requires the right to relicense the code that ships in it. An Apache-2.0 patch
grants us a licence, not the ability to relicense — so without a CLA, dual
licensing quietly breaks.

We use the standard **Apache Individual Contributor License Agreement (ICLA)**,
and the **Corporate CLA (CCLA)** if you are contributing on behalf of an
employer. You keep the copyright in your contribution; you grant us the rights
we need to distribute it under both licences.

- Sign once. It covers all your future contributions.
- The CLA bot will comment on your first PR with a link.
- Contributions to `ee/` additionally require prior written agreement.

If signing a CLA is not something you can do, we would still very much like to
hear from you — open an issue describing the problem and the approach. A
well-specified issue is often worth more than the patch.

## 3 · What makes a good contribution here

Sutra has an unusual and non-negotiable core discipline, inherited from the
system it was extracted from. Read [`GOVERNANCE.md`](Master_documentation/GOVERNANCE.md)
before touching anything under `packages/core/src/gate/`.

**The eight invariants** (`CLAUDE.md` §3) are the product. In particular:

- **The secret floor is absolute.** `local_only` content never reaches any LLM
  — not under a flag, not under an override, not for convenience. It is
  enforced at four independent points and all four stay.
- **Sensitivity is raise-only.** No code path may lower a tier.
- **The gate is read from the environment at server startup,** never accepted
  as a tool argument.

A pull request touching the gate, the tier model, or the write path will be
reviewed against these invariants first and its functionality second.

### Write the test before you believe the fix

This is the rule the upstream project kept re-learning, at cost. On one
occasion a type-resolution bug was fixed and its invariant test written
afterwards — and the test immediately failed, exposing three further instances
of the same defect that the "fix" had left untouched.

Concretely:

- A bug fix arrives with a test that **fails without the fix**. Please say so
  in the PR description — "verified failing at `<commit>`" — because a
  guardrail test that has never been seen to fail is not evidence of anything.
- A new guard ships with a **positive-coverage fixture**: something it must
  match. A rule that fires zero times looks exactly like a rule protecting a
  clean corpus. (This is [D4](../INHERITED-DEFECTS.md); one of the three
  secret-floor layers had never once fired.)
- A defect from [`INHERITED-DEFECTS.md`](INHERITED-DEFECTS.md) is closed only
  when its named test exists, fails against a planted instance, and passes
  against the product.

### Degradation is allowed; silent degradation is not

Every stage may produce less than its ideal output — no key, no model, no
network, a tool missing. What it may never do is produce less and report
success. Concretely: `ok` / `degraded` / `failed` / `skipped (no input)` /
`skipped (policy)` are five different outcomes and must never share a counter.

The test for any change: *if this silently produced nothing for a month, how
would the user find out?* If the answer is "they wouldn't", the change is not
done.

## 4 · Mechanics

```bash
git clone <your fork>
cd sutra
npm install
npm run build
npm test
```

- **Node ≥ 20** and **PowerShell 7 (`pwsh`)** are the prerequisites. `pwsh` is
  cross-platform; Windows-only `powershell` is not used anywhere.
- Source is TypeScript, compiled with `tsc`. Tests are `node:test` — no test
  framework dependency.
- The pipeline is PowerShell 7 + optional Python (via `uv`).
- Keep `packages/core` at **one runtime dependency** (`gray-matter`). Adding a
  second requires justification in the PR.
- `packages/mcp` has **zero** dependencies, by design. This is not negotiable.

### Commit hooks

Install them once, per clone:

```bash
git config core.hooksPath .githooks
```

The pre-commit hook is a secret scanner. It is deliberately fast (sub-second
regardless of file count) and fails **closed** — if the scanner is missing, the
commit is refused rather than allowed. Only `definite` rules (a matched key
shape, a known secret path) can fail a commit; `heuristic` rules raise a tier
and warn but never block, because a guard that gets routed around is worse than
no guard.

**Please do not use `--no-verify`.** If the hook is wrong, that is a bug worth
filing — the upstream project accumulated 128 `--no-verify` occurrences across
91 files because its hook cried wolf, and thereby kept the *belief* that its
commits were scanned while every large commit skipped the scan.

### Before you open the PR

- [ ] `npm run build && npm test` green
- [ ] `npm run check:license` green
- [ ] `npm run check:core-alone` green
- [ ] `npm run leak-scan` green
- [ ] Your test fails without your fix, and you have said so
- [ ] No personal identifier, key, hostname, or path from your machine anywhere
      in the diff

## 5 · Reporting a security issue

**Do not open a public issue for a vulnerability in the gate.** See
[`SECURITY.md`](SECURITY.md).
