<!-- SPDX-License-Identifier: Apache-2.0 -->
# Sutra

**A governed knowledge substrate for your AI.**

Your notes stay plain markdown in a git repo you own. Every note carries a
sensitivity tier. A gate sits between those notes and every model — and the
model cannot lift it.

The claim is not "another note app". It is:

> **Your AI can reason over everything you know, and provably cannot leak what
> you marked private.**

And "provably" means one command:

```
$ sutra gate

Ceiling: public
  local terminal, no model in the loop

  Visible:  812 of 1262 notes
  Withheld: private 401 · secret 37 · do_not_learn 12
```

---

## Start here

You need **Node ≥ 20**, **git**, and **PowerShell 7** (`pwsh` — it is
cross-platform; Windows PowerShell 5.1 is not a substitute).

```sh
git clone https://github.com/rahulsethi/Sutra-Stack.git sutra
cd sutra
npm install
npm run build
node packages/cli/dist/bin.js init
```

`sutra init` asks at most seven questions and ends by **proving the claim**: it
captures something, asks about it, and shows you the same question answered from
your terminal and from a cloud assistant's ceiling — with the secret note
provably withheld from the second.

It is idempotent. Re-run it any time.

> **No API key is required, and none is asked for.** With no model configured at
> all, Sutra does retrieval, tiering, linking, the graph, and **cited answers**.
> A model adds prose synthesis on top of those — nothing else. See
> [Why it works with no key](#why-it-works-with-no-key).

---

## What you get

```sh
sutra ask "what did I decide about the migration?"   # a cited answer from your own notes
sutra gate                                            # what can your AI actually see?
sutra capture "worth remembering"                     # floored to private, always
sutra doctor                                          # prereqs, wiring, and a live gate self-test
```

Every read command supports `--json`. Exit codes are a governance signal, not a
convention: `sutra help exit-codes`.

### Three shapes — pick one

| | What it is | Prereqs | Setup |
|---|---|---|---|
| **(a) CLI only** | `sutra` + your vault + the pipeline. No daemon, no harness, **no accounts, no keys, no network**. | Node, git, pwsh | ~5 min |
| **(b) Plugin into a harness** ⭐ | (a) + the MCP server wired into Claude Code, Hermes or Codex. The harness brings the model, keys, chat and scheduling. | (a) + a harness | +2 min |
| **(c) Full stack** | (b) + a local daemon and dashboard: graph explorer, review queue, secret reveal. | (b) + a port | +15 min |

**The gate is identical in all three.** Only the ceiling differs.

---

## The three tiers

| Tier | Your AI sees it | Use it for |
|---|---|---|
| `public` | yes, including a cloud model | reference, notes you would publish |
| `private` | **no** — unless you release one note, temporarily | the default. Most of your vault. |
| `secret` | **never. At any ceiling. Under any flag.** | credentials, health, finance, ID |

**Anything unlabelled is `private`.** That default is load-bearing: an
unlabelled note is not one you decided was safe to share — it is one nobody has
looked at yet.

There is a fourth, orthogonal marking: `do_not_learn: true` excludes a note from
every model surface *even at `public`*. Use it for someone else's words, a draft
you have not stood behind, a thing you are still deciding about.

---

## Wire it into your assistant

```sh
sutra wire claude --exposure public     # or: hermes, codex
sutra doctor --harness claude           # must report 14 tools at ceiling "public"
```

That second command is not ceremony. It **speaks the MCP protocol** and asserts
the tool count *and* the ceiling, because a harness upgrade once stopped reading
the block that registered this server and left the tool list **empty**, with no
error at all. Every file was present and correct. Re-run it after every harness
upgrade.

Your assistant then has 14 tools over your notes. Ask it *"what can you see?"* —
it will tell you the exact counts.

---

## Why it works with no key

A fresh install with no API key returns a **grounded, cited answer**: the
relevant passages from your own notes, each labelled with its source and tier,
in relevance order, with the withheld count stated.

That is not a placeholder for a real answer. Every claim in it is traceable by
construction, because every line came from a file whose path is printed next to
it — a property a synthesised paragraph can only approximate. It is returned
even when a model *did* run.

Adding a model adds prose synthesis over those same sources. It does not add
retrieval, tiering, linking, citation or the graph, because those never needed
one.

---

## Why you might trust it

The honest answer is: **read the gate.** It is about 600 lines, in
`packages/core/src/gate/`, with one runtime dependency. The MCP server has
**zero**. A supply chain is a poor foundation for a claim about what your AI can
see, so there mostly isn't one.

The gate is enforced at **four independent points**, and they are deliberately
redundant: each has failed independently in the system Sutra was extracted from,
and the other three held.

Nothing in this repo takes a ceiling as an argument. No tool accepts a tier, a
scope, an override or a passphrase — and a test walks every published tool
schema on every build to keep it that way. The exposure ceiling is read from the
environment once, at server startup.

See [`docs/diagrams/gate.html`](docs/diagrams/gate.html) for the picture.

---

## Built from a post-mortem

Sutra is an *extraction* from a live personal system, and that system had a bad
year. It was audited exhaustively, and the audit is a shipped document:
**[`INHERITED-DEFECTS.md`](INHERITED-DEFECTS.md)** — 39 defects, each with a
named test that must **fail against a deliberately planted instance** before it
counts as fixed.

A few, so you know what kind of document it is:

- One line truncated every source to 6,000 characters before synthesis. It
  produced **424 pages that were confident, fluent, correctly formatted, and
  wrong in specifics** — and page length was flat across two orders of magnitude
  of source size, so nothing looked anomalous.
- A secret-detection rule, `sk-[A-Za-z0-9]{20,}`, could not match `sk-proj-` or
  `sk-ant-`: the hyphen ends the character run after three characters. The
  flagship key shapes were **structurally unmatchable**, and the tests written
  from the same mental model passed.
- One of three secret-floor layers had **never once fired** — it matched
  `identity/accounts` against a numbered vault, so no real path could match it.
  Nothing counted rule hits, and a rule that fires zero times looks exactly like
  a rule protecting a clean corpus.
- A pre-commit hook lived untracked in `.git/hooks/` and took ten minutes on a
  large commit, so `--no-verify` became standing policy: **128 occurrences
  across 91 files** — while the repo kept the *belief* that its commits were
  scanned.

Every one of those is a design decision here, and the reasoning is in the code
next to the thing it explains.

The rule that produced all of them: **write the test before you believe the
fix.** During this build, the positive-coverage test caught three detection
rules whose fixtures were one character short of their own patterns — dead rules
that would have looked exactly like rules protecting a clean corpus.

---

## Documentation

| | |
|---|---|
| [`Master_documentation/00-START-HERE.md`](Master_documentation/00-START-HERE.md) | the canonical doc set |
| [`docs/diagrams/`](docs/diagrams/index.html) | six dark, interactive views. They render offline. |
| [`CLAUDE.md`](CLAUDE.md) | instructions for an AI working **on** this codebase |
| [`AGENTS.md`](AGENTS.md) | instructions for an AI working **with** a user's vault |
| [`INHERITED-DEFECTS.md`](INHERITED-DEFECTS.md) | the post-mortem, shipped as a product document |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | the CLA, and the testing discipline |

---

## Licence

| Path | Licence |
|---|---|
| everything except `ee/` | **Apache-2.0** |
| [`ee/`](ee/) | commercial — **not** open source. See [`ee/LICENSE`](ee/LICENSE). |

**`rm -rf ee/` leaves a complete, fully-tested, Apache-2.0 product.** CI proves
it on every commit by deleting the subtree, rebuilding, and running the entire
suite. Core never imports from `ee/`.

Everything in `ee/` can only *narrow* access, never widen it — asserted over the
full cross-product on every build. That property is what lets a security review
reduce to "read Core's gate".

---

## Status

**v1.0 — local, single-user, free, open.**

Not in v1: multi-user, RBAC, SSO, sync, sharing, an admin console, or anything
requiring a paid account. Those are [`ee/`](ee/README.md) and they are a
different product.

Contributions welcome — please read [`CONTRIBUTING.md`](CONTRIBUTING.md) first,
particularly the CLA and the note about writing the test before believing the
fix.
