<!-- SPDX-License-Identifier: Apache-2.0 -->
# Sutra for Hermes

## Wire it

```sh
sutra wire hermes --exposure public
```

This **prints** the registration rather than writing it. That is deliberate:
Hermes owns a YAML config, Sutra does not carry a YAML library, and a lossy
round-trip through one would reformat your file — reordering keys, changing
quoting, collapsing blank lines. Refusing to rewrite a file we cannot round-trip
losslessly is the correct behaviour, not a limitation.

Either run the CLI form it prints, or paste the block into your config.

## Then verify — and this step is not optional

```sh
hermes mcp test sutra          # must show 14 tools
sutra doctor --harness hermes  # must show 14 tools AT A CEILING
```

**Re-run this after every Hermes upgrade.**

A previous Hermes release stopped reading the `mcp_servers:` block in
`config.yaml`. Applying the old config left `hermes mcp list` **completely
empty**, with no error and no warning — the gated read path would have been dead
on that node, unnoticed, indefinitely. Every file was present and correct.

That is why `doctor` asserts a **tool count and a ceiling** by speaking the
protocol, instead of checking that a config file exists. File existence proves
nothing about a harness that has changed how it reads files.

## Choosing the ceiling

Hermes may be running a model on this machine or relaying to a cloud provider,
and only you know which.

| Ceiling | Choose it when |
|---|---|
| `public` | Hermes relays to any cloud model. The safe default. |
| `private` | You accept that whatever Hermes routes to will process your private notes. |
| `secret` | The model runs **entirely on this machine** and nothing leaves it. |

If you are unsure which of these describes your setup, the answer is `public`.

## Two routers, and they are not the same router

This is worth understanding once, because getting it wrong wastes an afternoon.

| | What it is | Config |
|---|---|---|
| **`sutra route`** | The **pipeline's** synthesis router — what writes durable pages. | `automation/policies/provider-router.json` |
| **Hermes's own chain** | What answers **chat**. Sutra does not read, write or own it. | your Hermes config |

They are independent and can have entirely different provider orders. Editing
one changes nothing in the other. Upstream, both were called "the router", and
diagnosis of a bad answer landed on whichever one the reader had in mind — so
`sutra doctor` prints both chains side by side, and every generated page records
`synthesis_provider:` in its frontmatter, written only when a model actually
answered. Its **absence** is the signal that none did.

## Scheduling

Hermes has cron. So does your OS. **Use exactly one of them.**

A job registered in both double-runs, and two runs writing one derived artifact
corrupt it. Sutra's own locks make that survivable rather than catastrophic —
the second run skips and exits 0 — but the right fix is not to register it
twice. `sutra schedule list` shows what is registered where.
