<!-- SPDX-License-Identifier: Apache-2.0 -->

# Deployment — nodes, hosting, and the pipelines

Where each part of Sutra runs, what it costs you to move a part into the cloud,
and how to add a new surface without adding a second gate.

New here? Do [`ONBOARDING.md`](ONBOARDING.md) first. This document assumes you
have a working vault.

---

## Contents

- [The seven moving parts](#the-seven-moving-parts)
- [Topology A — one machine (the default)](#topology-a--one-machine-the-default)
- [Topology B — many machines, one vault](#topology-b--many-machines-one-vault)
- [Topology C — tier-partitioned local + cloud](#topology-c--tier-partitioned-local--cloud)
- [Topology D — shared team deployment](#topology-d--shared-team-deployment)
- [Node placement reference](#node-placement-reference)
- [The pipelines, stage by stage](#the-pipelines-stage-by-stage)
- [Extending with a new surface](#extending-with-a-new-surface)
- [Operating it](#operating-it)

---

## The seven moving parts

Everything in Sutra is one of these. Only the first is irreplaceable.

| # | Part | What it is | If you lose it |
|---|---|---|---|
| 1 | **The vault** | plain `.md` + git, on a disk you own | **this is the only real loss** |
| 2 | **The pipeline** | `pwsh` scripts: ingest → compile → graph → index | re-run it |
| 3 | **Derived artifacts** | extracts, pages, graph, index | rebuilt by `sutra daily` |
| 4 | **The gate** | Aatma — a library, ~120 lines, no dependencies | it is code, not state |
| 5 | **The MCP server** | Hermes — one stdio process per harness | restart it |
| 6 | **The model** | Ollama, a hosted API, or none | answers lose prose, keep citations |
| 7 | **Observability** | run record, metrics CSV, provider log, audit log | you lose *history*, which cannot be rebuilt |

Two consequences worth internalising before you choose a topology:

- **Parts 2–5 are stateless.** You can run them anywhere, in parallel, or not at
  all. There is nothing to migrate.
- **Part 7 cannot be rebuilt.** Metrics and audit history only exist if they were
  being written at the time. That is why the metrics CSV appends from the very
  first run rather than being switched on when someone wants a trend.

---

## Topology A — one machine (the default)

```
┌─────────────────────────────────────────────────────────────┐
│  YOUR MACHINE                                               │
│                                                             │
│   ~/sutra-vault  ──►  pipeline (pwsh)  ──►  derived files   │
│         │                                        │          │
│         └──────────────►  AATMA · gate  ◄────────┘          │
│                                │                            │
│                     HERMES · sutra-mcp (stdio)              │
│                                │                            │
│              ┌─────────────────┼─────────────────┐          │
│              ▼                 ▼                 ▼          │
│        Claude Code          Codex          Ollama           │
│        (ceiling:            (ceiling:      (local model,    │
│         public)              public)        may see private)│
└─────────────────────────────────────────────────────────────┘

  Nothing leaves this box unless you configure a hosted model,
  and then only `public` content can reach it.
```

**Choose this unless you have a specific reason not to.** No account, no API key,
no network. Every guarantee in the product holds trivially because there is only
one trust boundary and it is your own disk.

```sh
export SUTRA_VAULT="$HOME/sutra-vault"
sutra daily
sutra wire claude --exposure public
sutra schedule install
```

**Optional: a private git remote for backup.** This is still Topology A — the
remote is a backup target, not a node.

```sh
cd ~/sutra-vault
git remote add origin https://github.com/YOUR-NAME/my-vault-private.git
# (or the SSH form, if you use SSH)
git push -u origin main
```

Before you do that, be certain the repository is **private**, and note that the
pre-commit hook only runs in clones where you have set
`git config core.hooksPath` — set it in the vault too.

---

## Topology B — many machines, one vault

A laptop and a desktop, both running the pipeline, syncing the vault over git.

```
   LAPTOP                                      DESKTOP
   ┌────────────────────┐                     ┌────────────────────┐
   │ vault (clone)      │◄──── git remote ───►│ vault (clone)      │
   │ pipeline           │      (private)      │ pipeline           │
   │ gate + MCP         │                     │ gate + MCP         │
   │ Ollama             │                     │ Ollama             │
   └────────────────────┘                     └────────────────────┘

   Both write metrics into the same CSV, tagged by host.
   Both take snapshots, named by host.
```

This works, and there are exactly three things to know.

**1 · Metrics are compared per host, never across hosts.** Two machines appending
to one CSV interleave by timestamp. Comparing consecutive rows across hosts
produces graphs that appear to shrink by hundreds of nodes when nothing was lost
— and an alert on a shrink that never happened trains you to ignore the alert
that matters. Sutra groups by host before computing any delta.

**2 · Backup retention has a per-host floor.** `sutra backup --prune` keeps the
newest N snapshots **from each host**. A global "keep the newest 3" is satisfied
entirely by the busier machine while the quieter machine's only copy ages out.
Snapshot directories carry the host in their name so this is possible at all.

**3 · Do not use `git submodule update --init --recursive` on a node that runs
the pipeline.** It always aborts on a dirty working tree — and the pipeline is
what makes the tree dirty. Git is protecting you; the message reads like an
obstacle, and every answer you will find online suggests `reset --hard`,
`checkout -f` or `clean -fd`, which are the only ways to lose data here.

```sh
# Safe reconcile, by hand:
cd ~/sutra-vault
git stash push --include-untracked -m "pre-sync $(date -u +%FT%TZ)"
git pull --rebase
git stash pop            # resolve conflicts in favour of upstream
```

No script in Sutra runs a destructive git command, and a test asserts that on
every commit.

---

## Topology C — tier-partitioned local + cloud

For when you want cloud compute but will not put private material on it.

```
        CLOUD NODE                          LOCAL NODE
   ┌──────────────────────┐            ┌──────────────────────────┐
   │ vault: PUBLIC subset │            │ vault: FULL              │
   │   (mirror-export)    │◄───push────│   public + private +     │
   │                      │  one-way   │   secret                 │
   │ pipeline             │            │ pipeline                 │
   │ gate @ ceiling PUBLIC│            │ gate @ ceiling PRIVATE   │
   │ hosted model         │            │ Ollama (local only)      │
   └──────────┬───────────┘            └────────────┬─────────────┘
              │                                     │
        team / web surface                    you, everything
```

The cloud node holds a **derived public subset**, produced by copying named
directories — never by relying on a gate at read time to keep an over-broad
artifact safe. The push is one-way. `private` and `secret` content is not present
on that node at all, so there is nothing for a misconfiguration to expose.

```sh
# On the local node — build and push the public mirror.
SUTRA_MCP_EXPOSURE=public sutra publish llms
sutra graph export
# then sync only the public subset to the cloud node's vault
```

**What this costs you.** The cloud node can only answer from public material, so
its answers are genuinely worse for anything personal. That is the trade, stated
plainly — do not expect the local node's quality from it.

**What it does not cost you.** No guarantee weakens. `secret` never left the
local machine, and the cloud node's ceiling is fixed at `public` at startup.

### Self-hosted CI runner

If you want the pipeline to run on a schedule without your laptop being open,
run it on a **self-hosted** runner with the vault checked out there. Do not use a
hosted CI runner for a vault containing `private` content: the checkout, the
logs and the cache all live on infrastructure you do not control.

---

## Topology D — shared team deployment

Multiple people, per-person clearance, one governed corpus. **This is where
Sutra Enterprise (`ee/`) is required** — Core has one ceiling per server, not
per subject.

```
   ┌──────────────────────────────────────────────────────────────┐
   │  SHARED NODE                                                 │
   │                                                              │
   │   corpus (git)  ──►  pipeline  ──►  derived                  │
   │        │                                                     │
   │        ├─► AATMA · Core gate            ← the floor          │
   │        └─► ee/ · policy engine          ← narrows further    │
   │                     │                                        │
   │        subject clearance × purpose × surface                 │
   │                     │                                        │
   │      ┌──────────────┼──────────────┐                        │
   │      ▼              ▼              ▼                        │
   │  alice@ (private) bob@ (public)  audit chain (hash-linked)   │
   └──────────────────────────────────────────────────────────────┘
```

The essential property: **`ee/` can only ever narrow access, never widen it.**
The effective ceiling is the *minimum* of Core's ceiling and every enterprise
policy that applies. That is asserted over the full cross-product of subjects,
purposes and surfaces on every build — which is what lets a security review
reduce to "read Core's gate".

See [`ONBOARDING-ENTERPRISE.md`](ONBOARDING-ENTERPRISE.md).

---

## Node placement reference

| Component | Local | Private cloud / self-hosted | Public cloud | Notes |
|---|---|---|---|---|
| Vault (working copy) | ✅ default | ✅ | ⚠️ public subset only | the only irreplaceable part |
| Vault (git remote) | — | ✅ private repo | ⚠️ private repo only | verify "private" before first push |
| Pipeline | ✅ default | ✅ self-hosted runner | ❌ | a hosted runner sees the whole checkout |
| MCP server | ✅ **always** | — | ❌ | stdio, one per harness; it is not a service |
| Daemon + dashboard | ✅ loopback only | ⚠️ behind your own auth | ❌ | optional; deleting them breaks nothing |
| Local model | ✅ | ✅ | — | the only kind that may see `private` |
| Hosted model | — | — | ✅ **`public` tier only** | the gate enforces this, not your config |
| Metrics / audit | ✅ with the vault | ✅ | ❌ | history cannot be rebuilt — do not lose it |
| `secret` content | ✅ **only ever here** | ❌ | ❌ | four enforcement points; no override |

**The MCP server stays local, always.** It is a stdio child process of your
harness, not a network service. There is no supported mode in which it listens on
a network interface. The optional daemon binds loopback and refuses any other
interface unless you explicitly configure otherwise — and it is optional
precisely so that this whole class of exposure is opt-in.

---

## The pipelines, stage by stage

`sutra daily` runs five stages in order. Each one is independently runnable, each
one reports its own outcome, and no stage silently substitutes for another.

```
  raw/inbox/*                                    your captures and drops
      │
      ▼
 ┌──────────────┐   ingest.ps1
 │ 1 · INGEST   │   extract text · CLASSIFY · write a manifest per source
 └──────┬───────┘   → compiled/extracts/, raw/manifests/
        │           the tier is set HERE, at the boundary, and only ever rises
        ▼
 ┌──────────────┐   auto-compile.ps1
 │ 2 · COMPILE  │   extract → a durable page. Deterministic first; a model
 └──────┬───────┘   lifts ONE field and never the layout, ids, tiers or links
        │           → compiled/pages/
        ▼
 ┌──────────────┐   graph-export.ps1
 │ 3 · GRAPH    │   notes + wikilinks → nodes + edges, every node tier-tagged
 └──────┬───────┘   → graph/exports/cytoscape.json
        │           refuses to overwrite a good graph with an empty one
        ▼
 ┌──────────────┐   refresh-index.ps1 (+ embed.py, optional)
 │ 4 · INDEX    │   BM25 always; vectors when an embedder is available
 └──────┬───────┘   → the retrieval index
        │
        ▼
 ┌──────────────┐   hygiene/all.ps1
 │ 5 · HYGIENE  │   the review queue: decision-bearing items first, capped
 └──────────────┘   per category so the surface stays actionable
```

| Stage | Command | Needs | Degrades to |
|---|---|---|---|
| Ingest | `sutra ingest` | `pwsh`; `uv`/`pdftotext` for web & PDF | text formats only, others queued as `tool-missing` |
| Compile | *(part of `sutra daily`)* | a model, optionally | a deterministic page — correct, less prose |
| Graph | `sutra graph export` | `pwsh` | — always available |
| Index | `sutra refresh-index` | an embedder, optionally | BM25-only, and it says so |
| Hygiene | `sutra hygiene` | `pwsh` | — always available |
| Backup | `sutra backup [--prune] [-WhatIf]` | git, optionally | file copy only, and it warns |

**Retrieval** is not a pipeline stage — it runs on demand, at query time, through
the gate: BM25 + vectors fused by Reciprocal-Rank Fusion, plus graph expansion
and section-level reads. It degrades to BM25 alone with no embedder, and to
citations without prose with no model.

### Two rules the pipeline will not break

- **No input is ever truncated.** If a source exceeds a model's window it is
  chunked and merged, or refused. A page records `source_chars_seen` and
  `source_chars_total` so any shortfall is a fact on the artifact, not something
  you have to infer from its length.
- **A stage that produced nothing says so.** `no-op` — had input, ran, produced
  nothing — is a distinct outcome from `ok` and from `skipped (no input)`. Those
  three never share a counter.

---

## Extending with a new surface

Sutra exposes **one** surface: the MCP server. Everything else is a client of it.

```
   ┌──────────────────────────┐
   │  AATMA · the gate        │   ceiling read from the environment
   │  ~120 lines, 0 deps      │   at startup, never from a request
   └────────────┬─────────────┘
                │
   ┌────────────▼─────────────┐
   │  HERMES · sutra-mcp      │   14 tools · stdio JSON-RPC 2.0
   └────────────┬─────────────┘
     ┌──────────┼──────────┬─────────────┐
     ▼          ▼          ▼             ▼
 Claude Code  Codex     Hermes      YOUR SURFACE
                                  (Telegram · Slack · web · script)
```

### The two rules

**1 · Be a client, never a second gate.**

Call the MCP server. Do not read the vault directly. Do not re-implement tier
comparison, and do not add a detection regex to your own scanner — add it to
`automation/policies/secret-patterns.json`, which every scanner in the system
reads. One policy engine, N thin bindings. Every duplicate of a tier comparison
in this system's history failed *open* in at least one copy.

**2 · Take your ceiling from your own environment, at startup.**

Each surface gets its own registration with its own `SUTRA_MCP_EXPOSURE`. A
surface that accepts a ceiling as a request parameter is broken by construction,
and Core's own build fails if any tool ever grows such an argument.

### Worked example — start from Hermes

```sh
ls plugins/hermes/                       # a complete, small integration
sutra wire hermes --exposure private
sutra doctor --harness hermes            # speaks the protocol; asserts tools + ceiling
```

Registering the server manually looks like this — three fields, no SDK:

```json
{
  "mcpServers": {
    "sutra": {
      "command": "node",
      "args": ["/abs/path/to/Sutra-Stack/packages/mcp/dist/bin.js"],
      "env": {
        "SUTRA_VAULT": "/abs/path/to/your-vault",
        "SUTRA_MCP_EXPOSURE": "public",
        "SUTRA_MCP_SURFACE": "my-surface"
      }
    }
  }
}
```

`SUTRA_MCP_SURFACE` is a label that appears in the audit log, so refusals are
attributable to the surface that triggered them.

**Always verify by speaking the protocol, never by checking the file exists:**

```sh
sutra doctor --harness claude
```

A harness upgrade that quietly stops reading its registration leaves an **empty
tool list and no error anywhere**. The gated read path would be dead and nothing
would say so. Only asking the server how many tools it has catches that, which is
why `doctor` does exactly that and prints the count and the ceiling.

### A chat surface — Telegram, Slack, Discord

Supported, and the shape is always the same:

```
Telegram ──► your bot process ──► MCP client ──► sutra-mcp ──► gate ──► vault
             (holds the token)
```

Your bot holds the platform token and speaks MCP to Sutra. Sutra never learns the
token, never opens a socket to a chat platform, and never sends a message. Keep it
that way — it is why Sutra has no chat-platform attack surface at all.

Four things to get right:

| Do | Why |
|---|---|
| **Ceiling `public`** for any chat surface | a chat platform is a third party with its own retention, logs and breach surface |
| **Acknowledge before acting**, never after | a poller that resumes from a stored offset after a crash re-executes commands the user already saw succeed |
| **Read status from `sutra status --json`**, never from your own rendered text | a locale change can turn a fifteen-alert day into a silent one, and a length limit truncates the *bad* days specifically — a bad report is always longer than a good one |
| **Paginate deliberately** | if a report exceeds the platform's limit, split it and say you split it; never let the platform truncate it for you |

> Build the bot as a **separate process alongside** this repository. If an
> outbound-send API appears inside `packages/`, `automation/` or `ee/`, the
> coverage gate in the test suite will flag it and ask for the accompanying
> absence test before that feature ships. That is the mechanism working, not an
> obstacle — but it is easier to simply not put a chat sender in the governance
> core.

### A read-only web UI

The optional daemon plus dashboard already does this, on loopback:

```sh
SUTRA_MCP_EXPOSURE=public node packages/daemon/dist/bin.js
```

It binds `127.0.0.1` and refuses other interfaces by default. If you expose it,
put your own authentication in front of it and give it a `public` ceiling. Both
the daemon and dashboard are optional shape-(c) components — deleting them
entirely must break nothing, and CI asserts that.

---

## Operating it

### Daily

Nothing. `sutra schedule install` runs the pipeline for you. Come back to
`sutra status` when you are curious.

### Weekly

```sh
sutra status                # any alarm? any stage doing nothing?
sutra hygiene               # the review queue — decision-bearing items first
sutra backup --prune -WhatIf   # see what retention WOULD remove
sutra backup --prune           # then actually do it
```

`-WhatIf` is a full dry run: it takes no snapshot, makes no commit, deletes
nothing, and prints every action it would have taken. Use it the first time.

### After updating Sutra

```sh
npm install && npm run build && npm run verify
sutra doctor
sutra rescan                # report: does the new rule set re-tier anything?
sutra rescan --apply        # apply it
```

`sutra rescan` matters after an update because detection rules change. If the
rule set has changed since your notes were last classified, `sutra doctor` tells
you a rescan is due — you do not have to remember.

### Moving to a new machine

```sh
git clone <your-vault-remote> ~/sutra-vault
cd ~/sutra-vault && git config core.hooksPath ../Sutra-Stack/.githooks
cd - && export SUTRA_VAULT="$HOME/sutra-vault"
sutra daily                 # rebuilds every derived artifact from scratch
sutra wire claude
```

Only the vault needs to move. Parts 2–6 rebuild.

### If something looks wrong

```sh
sutra doctor --json > doctor.json
sutra status  --json > status.json
sutra logs --since 7
```

The first two carry counts, paths and outcomes — never note content — so they are
safe to share when asking for help.

---

## See also

| | |
|---|---|
| [`ONBOARDING.md`](ONBOARDING.md) | first-run setup, step by step |
| [`ONBOARDING-ENTERPRISE.md`](ONBOARDING-ENTERPRISE.md) | policy bundles, audit chains, multi-user |
| [`AGENTS.md`](AGENTS.md) | for an assistant working with a vault |
| [`Master_documentation/`](Master_documentation/00-START-HERE.md) | architecture and mechanisms |
| [`docs/diagrams/index.html`](docs/diagrams/index.html) | the gate, the pipeline, the MCP surface |
