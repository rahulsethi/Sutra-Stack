<!-- SPDX-License-Identifier: Apache-2.0 -->
# Sutra — START HERE

This is the canonical documentation set. **Every document lives inside one
numbered section here.** Anything outside it is working notes or legacy, and
loses to this on any disagreement.

## The four rules

1. **Self-contained.** This set is understandable without any other docs folder.
2. **Mechanism-first.** [`06-mechanisms/`](06-mechanisms/) is mandatory reading
   before touching a live surface. It records how each piece of machinery
   **silently breaks** — the thing nobody writes down and everybody needs.
3. **Created ≠ wired.** Nothing is `done` in
   [`10-implementation/`](10-implementation/) until it is verified *and* has a
   real caller. Anything built-but-unwired goes in the drift table.
4. **Update in the same commit.** Change something real → update the owning
   section and [`08-state/CURRENT-STATE.md`](08-state/CURRENT-STATE.md) in the
   same commit.

## The map

**Reference layer — what it is, how it is built:**

| # | Section | Owns |
|---|---|---|
| [01](01-charter/) | charter | why it exists, the principles, the non-goals |
| [02](02-architecture/) | architecture | layers, data model, flows, the licence boundary |
| [03](03-components/) | components | each package: what, where, status |
| [04](04-surfaces/) | surfaces | every entry point, and how each connects back |
| [05](05-decisions/) | decisions | the load-bearing choices and their alternatives |
| [06](06-mechanisms/) | **mechanisms** | **the hidden machinery, and how it fails quietly** |
| [07](07-setup/) | setup | bring-up, per surface |
| [08](08-state/) | state | where we are right now (auto-stamped) |
| [09](09-design/) | design | Nocturne, and the diagram set |

**Living layer — updated every session:**

| # | Section | Update when |
|---|---|---|
| [10](10-implementation/) | implementation | a feature lands or its status changes |
| [11](11-user-actions/) | user actions | you hit a step only the owner can do |
| [12](12-deferred/) | deferred | you postpone anything |
| [13](13-sessions/) | sessions | end of any meaningful session |

## If you only read three things

1. [`06-mechanisms/`](06-mechanisms/) — because that is where the outages live.
2. [`10-implementation/`](10-implementation/)'s **drift table** — because that is
   what is *actually* true, as opposed to what is claimed.
3. [`../INHERITED-DEFECTS.md`](../INHERITED-DEFECTS.md) — the post-mortem this
   product was built from. Every design decision here cites one of its entries.

## Related, outside this set

- [`../README.md`](../README.md) — the front door for a stranger.
- [`../CLAUDE.md`](../CLAUDE.md) — for an AI working **on** this codebase.
- [`../AGENTS.md`](../AGENTS.md) — for an AI working **with** a user's vault.
- [`../docs/diagrams/`](../docs/diagrams/index.html) — the visual counterpart.
