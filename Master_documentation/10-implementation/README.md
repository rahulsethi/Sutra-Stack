<!-- SPDX-License-Identifier: Apache-2.0 -->
# 10 · Implementation ledger

> **Nothing is `done` until it is verified AND wired.** Anything built but not
> reachable from a caller goes in the drift table below, not in the done column.
>
> Every row carries **verify-evidence** — the command that was actually run and
> what it printed. A row with no evidence is a claim, not a status.

Last updated: 2026-08-16.

---

## The build

Milestones follow `BUILD-PLAN.md`. A milestone is done when its verify-check
**passes**, not when its code exists.

| # | Item | Status | Verify-evidence |
|---|---|---|---|
| M0 | Licence boundary — Apache-2.0 + `ee/` commercial, SPDX everywhere | **done** | `npm run check:license` → *95 Core, 11 ee/, 10 exempt*. `npm run check:core-alone` → *`rm -rf ee/` builds and passes 123 tests*. |
| M1 | The governance core — gate, vault, retrieval, run, audit | **done** | `npm test` → *144 pass, 0 fail* on Node 20. `npm run check:no-bun` → *48 files runtime-agnostic*. |
| M2 | MCP server, 14 tools, zero deps | **done** | `sutra doctor` → *MCP server serves 14 tools at ceiling "public"* (speaks the protocol, not a file check). |
| M3 | The CLI — `--json` everywhere, governance exit codes | **done** | `sutra ask/search/get/gate/status/capture` all exercised against a live vault. |
| M4 | Substrate + pipeline (pwsh 7) | **done** | `daily.ps1` → *ok (56.1s)*, all five stages green, on a real vault. `Classify.test.ps1` → *22 passed* including PS/TS parity. |
| M5 | Strip gate | **done** | `npm run leak-scan` → *0 blocking*. It caught real personal content in a copied config file and two hardcoded key shapes in probe code. |
| M6 | Plugins — Claude Code, Hermes, Codex | **partial** | Artifacts written and reviewed. **Not yet installed on a clean machine** — see drift. |
| M7 | `sutra init` + `doctor` | **done** | `sutra init --yes` reaches prove-it end to end; both views rendered, secret withheld. |
| M8 | Optional daemon + dashboard | **done** | 15 tests. `assertBindPolicy` refuses a non-loopback bind with no secret and no TLS. |
| — | Sutra Enterprise (`ee/`, E1–E7) | **done** | 23 tests including the exhaustive narrows-only sweep over all 162 combinations. |
| — | Diagrams | **done** | `npm run check:diagrams` → *6 diagrams, all dark, masked, legended, offline-safe*. Two verified visually in a browser. |
| — | Persona layer (`core/persona/`) | **done** | 16 tests. Lifted per the extraction manifest; `routeTurn` composes the gate rather than restating it. |
| — | Defect manifest as tests | **partial** | 17 tests across D1, I13, §9.1, D28, D29. **Not all 39 defects have a named test** — see drift. |

---

## Drift — built but NOT wired, or claimed but not verified

This table is the point of this document. It exists because the upstream project
repeatedly marked things done that had never run.

| Item | What is actually true | What would close it |
|---|---|---|
| **Plugins on a clean machine** | The plugin artifacts exist and are internally consistent. **No plugin has been installed into a real harness on a machine that did not build it.** M4's verify says `/plugin install sutra@sutra` then `/sutra:sutra-recall` answers — that has not been done. | Install on a second machine; run the two commands. |
| **The defect manifest is incomplete** | 17 named tests cover D1, D4, D5, D9, D11, D13, D14, D15, D18, D24, I13, I14, §9.1, D28, D29. `INHERITED-DEFECTS.md` lists **39**. The rest are addressed in code with reasoning but have **no named absence test**. | One test per remaining defect, each failing against a planted instance. |
| **Provider dispatch is not implemented** | `Invoke-Synthesis` selects a provider, records health, and returns `$null`. There is **no HTTP client**. Sutra ships deterministic-first, and a half-written client that sometimes works is worse than an honest "no model configured" — but this is a gap, not a feature. | Implement dispatch; assert `extract.Length` chars arrive (report 20's test R13). |
| **Second-user validation has not happened** | Gate 1 requires a real second person to stand this up unaided and use it for two weeks. **Nobody has.** | Exactly that. It is the gate that is easiest to fudge and most worth honouring. |
| ~~CI is not running~~ | **CLOSED 2026-08-16.** Run `31955683697` — all 7 jobs green, including the release-gate job. | — |
| ~~No cross-OS run~~ | **CLOSED 2026-08-16.** Green on ubuntu-latest, macos-latest and windows-latest. The matrix caught a real D26 on its first run; see below. | — |
| **No retrieval eval** | M6/`sutra eval` — a golden set with known answers — does not exist. Retrieval quality is therefore **unmeasured**, and the register is explicit that an unmeasured retrieval layer cannot be improved safely. | A 50-question graded set over a shipped demo corpus, with a committed baseline. |

---

## Defects found *during this build*

Recorded because the discipline that found them is the deliverable, not just the
fixes.

| # | Found by | What it was |
|---|---|---|
| 1 | The positive-coverage test, on first run | **Three detection rules** whose fixtures were one character short of their own patterns. Dead rules — and a rule that matches nothing looks exactly like a rule protecting a clean corpus. |
| 2 | Running `sutra init` | The first cited answer on a fresh install quoted a **template file** full of `{{title}}` placeholders as a source. Structure is not knowledge. |
| 3 | Running `sutra init` | Prove-it asked at a *public* ceiling for a capture that `writeCapture` had correctly floored to private. **The gate was right and the demo was wrong.** |
| 4 | Reading the shipped templates | All five defaulted to `sensitivity: hosted_allowed` — templates that **mint public notes by default**, contradicting the vault's own rule. |
| 5 | `check-core-alone`, via its own failure | A stale `.tsbuildinfo` travelled with the staged copy, so tsc emitted **nothing** and exited 0 — a passing build with no compiled output. **D18's exact shape, inside the script written to catch it.** |
| 6 | The leak scan | Personal content in a config file copied from the source vault — references to the upstream personal feeder that §8 requires removed — plus two hardcoded key shapes in my own probe code. |
| 7 | **Opening a diagram in a browser** | Two CDN `<script>` tags in `<head>` without `defer` — with no network the page showed **nothing** until each request timed out. `check-diagrams` had passed it, because *"the dark token is in the file"* and *"the page renders dark"* are different claims. |
| 8 | `created-not-wired.test.ts`, on first run | `package.json` declared a `third-party` script pointing at a file that **did not exist**, and the CLI advertised `sutra backup` and `sutra publish llms` with **no scripts behind them**. |
| 9 | **The Linux CI runner, on its first run** | `Join-VaultPath` split on the regex `[\/]`. With ONE backslash that is an escaped forward slash, matching only `/` and never `\` — so it produced `/tmp/state\checks`, a single directory whose *name* contains a backslash. **D26, in the helper written to prevent D26.** Invisible on Windows, where `[IO.Path]::Combine` treats `\` as a separator anyway and the wrong split gives the right answer. |

Numbers 5 and 7 are the same lesson twice: **measuring the wrong thing** rather
than lacking data. The upstream register recorded that four of its own six wrong
claims had that cause.

| 10 | **A question from the owner** — "I do not see Dimaag or Parvo or Aatma listed there?" | The naming collapse was deliberate and documented, but `packages/core/src/persona/` had been **created at M0 and never filled** — the extraction manifest says LIFT. It sat empty for the entire build, invisible because **git does not track empty directories**, so it appeared in no clone and no diff. `INHERITED-DEFECTS.md` was likewise linked from four docs and never shipped. |

Number 9 is the argument for the cross-OS matrix, made by the matrix itself on
its first run. The test was already correct — it asserted **segment count**
rather than "the string contains no backslash", precisely because the naive
assertion passes vacuously on Windows, where the correct output and the bug are
character-identical. A test that could only fail on the platform that does not
exercise the bug would have proved nothing.

Number 10 is the one no automated check was looking for, and it is now covered:
`tests/defects/dangling-references.test.ts` asserts that no source directory is
empty, that every path a governance file names exists, that CLAUDE.md's repo map
matches the tree, and that every relative link in a shipped doc resolves. All
four are the same shape — **a reference to something that does not exist** — and
all four were true of this repo when the question was asked.

---

## The rule this table enforces

**After every build step, grep for the CALLER, not the file.**

`tests/defects/created-not-wired.test.ts` does this mechanically on every
commit — because "I checked" does not survive the next contributor, and finding
#8 above is what happens when a human checks instead.
