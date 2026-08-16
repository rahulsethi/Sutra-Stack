<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- The SYNC-STAMP block below is refreshed by scripts/docstate-stamp.ps1. -->
# Sutra — CURRENT STATE

<!-- SYNC-STAMP:START (auto) -->
- **Updated:** 2026-08-16 (current)
- **Heads:** repo `a11b8fb`
<!-- SYNC-STAMP:END -->

## Headline

Sutra v1.0 is **built and working end to end**, verified by running it rather
than by reading it, and green in CI on Linux, macOS and Windows. A fresh `sutra init` reaches prove-it: it captures
something, answers a question with citations, and demonstrates the same question
returning different material at a local ceiling and a cloud one — with a secret
note provably withheld from the second.

**144 TypeScript tests and 33 PowerShell tests pass**, and **CI is green on
Linux, macOS and Windows**. The leak scan is clean, the licence boundary is
clean, and `rm -rf ee/` builds and passes the full suite.

It is **not released**. One owner action blocks that (credential rotation), and
three things are honestly incomplete — all listed below and in the drift table.

## What runs, and how to verify it

| Surface | Verify with | Last seen |
|---|---|---|
| `sutra init` | `node packages/cli/dist/bin.js init --yes --vault <path>` | reaches prove-it, both views rendered |
| `sutra ask` / `search` / `gate` / `capture` / `status` | run them against a vault | all green on a live 5-note vault |
| `sutra doctor` | `sutra doctor` | healthy, 4 optional-capability warnings |
| The MCP server | `sutra doctor --harness claude` | **14 tools at ceiling "public"** — asserted by speaking the protocol |
| The pipeline | `pwsh automation/scripts/orchestrator/daily.ps1 <vault>` | **ok (56.1 s)**, five stages |
| `sutra rescan` | plant a key in a public note, run it | detected, raised to secret, corpus stamped |
| The commit hook | stage a file containing a key shape | **refused in 297 ms** |
| The diagram set | `npm run check:diagrams` | 6 diagrams; two verified visually in a browser |
| `ee/` | `npm run test:ee` | 23 tests, incl. the 162-combination narrows-only sweep |
| CI | `gh run list` | **7/7 jobs green** on ubuntu, macos and windows (run `31955683697`) |

## Recently changed

The whole repository. Built in one autonomous session from
`vanilla-sutra/Opus 5/` — see [`../13-sessions/`](../13-sessions/).

## Blocked / pending

**⛔ Blocking public release:** credential rotation in the source vault's git
history. Re-tiering was containment; only rotation is remedy, and it is
owner-only. → [`../11-user-actions/`](../11-user-actions/) U1.

**Honestly incomplete**, in priority order:

1. **No provider dispatch.** `Invoke-Synthesis` selects a provider and returns
   `$null`. Deterministic-first is the shipped mode, and it works — but this is
   a gap, not a feature.
2. **The defect manifest is partial.** 17 of 39 defects have named absence
   tests.
3. **No retrieval eval.** `sutra eval` does not exist, so retrieval quality is
   unmeasured.

Full list with reasons: [`../12-deferred/`](../12-deferred/).

## New-thread handoff

> Read `Master_documentation/00-START-HERE.md`, then this file. Canonical docs
> live in `Master_documentation/`. **Read `06-mechanisms/` before touching any
> live surface** — it records how each piece of machinery fails *quietly*.
> Check `10-implementation/`'s drift table for what is actually true as opposed
> to what is claimed. Update this file and the owning section in the same commit
> as any change. Run `npm run verify` before committing.
