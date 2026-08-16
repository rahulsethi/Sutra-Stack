<!-- SPDX-License-Identifier: Apache-2.0 -->
# 13 · Sessions

Newest first. Cumulative summary on top.

---

## Cumulative

Sutra was built from `vanilla-sutra/Opus 5/` in a single autonomous session on
2026-08-15/16. It reached: the licence boundary, the governance core, the MCP
server, the CLI, the pwsh pipeline, Enterprise (`ee/`), shape (c), the plugins,
the diagram set, and a partial defect manifest.

**144 TypeScript tests + 33 PowerShell tests green.** Leak scan clean. Licence
boundary clean. `rm -rf ee/` builds and passes.

What is **not** done is in [`../10-implementation/`](../10-implementation/)'s
drift table and [`../12-deferred/`](../12-deferred/). Both are honest.

---

## 2026-08-15/16 — the build

**Owner decisions taken:** Apache-2.0 + CLA; deterministic-only first run;
private repo pending credential rotation.

**Milestones:** M0 through M8, plus `ee/` E1–E7.

**Eight defects were found during the build**, listed with their discovery
method in [`../10-implementation/`](../10-implementation/). Three were found by
*running* the thing rather than reading it, and two more by a check catching its
own over-broad or under-measuring rule.

The two that generalise:

- **`check-core-alone` reported a passing build with no compiled output** — a
  stale `.tsbuildinfo` travelled with the staged copy, tsc emitted nothing and
  exited 0. D18's exact shape, inside the script written to catch it.
- **A diagram rendered white offline** while the checker passed it, because
  *"the dark token is in the file"* and *"the page renders dark"* are different
  claims and only the first was being measured.

Both are the register's own most common category of wrong answer: **measuring
the wrong thing**, not lacking data.

**Verified live**, not claimed: `sutra init` reaching prove-it; the full daily
pipeline on a real vault; `sutra rescan` detecting a planted Anthropic key and
re-tiering the note; the commit hook refusing a planted key in 297 ms; the I15
gate firing when the pattern set changed; two diagrams screenshotted in a
browser.
