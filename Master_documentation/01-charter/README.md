<!-- SPDX-License-Identifier: Apache-2.0 -->
# 01 · Charter

## What Sutra is

A governed personal knowledge substrate. Plain markdown in a git repo the user
owns; a sensitivity tier on every note; a deterministic pipeline; and a gate
between that knowledge and every model which the model cannot lift.

## The claim, exactly

> Your AI can reason over everything you know, and **provably** cannot leak what
> you marked private.

"Provably" is doing real work in that sentence. It means: one command reports
what is visible and what is withheld, computed by the same code the read paths
use; the gate is ~600 lines with one dependency; and no tool anywhere accepts a
ceiling as an argument.

## The eight invariants

They are the product. Everything else is negotiable. In full in
[`../../CLAUDE.md`](../../CLAUDE.md) §2; in brief:

1. The user's repo is the truth. Everything derived is disposable.
2. The gate is server-side and the model cannot lift it.
3. **The secret floor is absolute.**
4. Sensitivity is raise-only.
5. Never commit secrets.
6. Writes are narrow, floored, additive, audited.
7. Reversible-auto with an audit trail.
8. Deterministic-first.

## Principles

**Local-first, single-node by default.** A VPS, a tailnet, a public mirror are
optional modules, never assumptions.

**Harness-agnostic.** Usable from any harness, or from nothing at all. No
component may be a hard dependency of the governance core.

**Sovereignty.** No instance depends on another's devices, accounts or keys.

**Deterministic-first.** A model lifts one field. It never decides the file
layout, the ids, the tiers or the links — and everything degrades to a correct
deterministic result when no model is available.

**Degradation is allowed; silent degradation is not.** Every stage may produce
less than its ideal output. None may produce less and report success.

## Non-goals

Not a chat UI, a model router, a bot framework, a scheduler daemon, or a
multi-agent board. Harnesses have all of those, better. Sutra is the governed
substrate they plug into.

Not a cloud service, an account system, or telemetry. Local-first sovereignty is
the pitch; breaking it breaks the product.

Not multi-user, sync, or sharing in v1. The cross-user exchange seam is designed
but is a v2 concern — **a seam, never a shared store**.

## Who it is for

Someone with a substantial body of personal knowledge who wants an AI to reason
over it, and who has a concrete reason not to hand all of it over.
