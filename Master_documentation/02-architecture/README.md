<!-- SPDX-License-Identifier: Apache-2.0 -->
# 02 · Architecture

Interactive view: [`../../docs/diagrams/architecture.html`](../../docs/diagrams/architecture.html)

## Layers

```
your vault  (a separate git repo you own)
    |   plain markdown + frontmatter. THE TRUTH.
    v
automation/            pwsh 7 pipeline: ingest -> compile -> graph -> index
    |
    v
packages/core          THE GATE. tiers · guard · exposure · patterns · redact · override
    |                  vault (client · brain · capture) · retrieval · run · audit
    |
    +--> packages/mcp        14 tools over stdio, ZERO dependencies
    +--> packages/cli        --json everywhere, governance exit codes
    +--> packages/daemon     OPTIONAL (shape c)
    +--> packages/dashboard  OPTIONAL (shape c)
    |
    v
plugins/               claude-code · hermes · codex
```

`ee/` sits **beside** Core and depends on it. Core never depends on `ee/`.

## The data model

| Artifact | Where | Nature |
|---|---|---|
| **Note** | `vault/**/*.md` | **The truth.** Markdown + frontmatter. |
| Manifest | `raw/manifests/*.md` | derived — one per ingested source |
| Extract | `compiled/extracts/*.txt` | derived — the text pulled from a source |
| Page | `compiled/pages/*.md` | derived — written from an extract |
| Graph | `graph/exports/cytoscape.json` | derived — nodes and edges from wikilinks |
| Index | `state/index/embeddings.json` | derived — local vectors |
| Run record | `state/checks/last-run.json` | derived — five outcomes, 3-valued did_work |

**Everything but the notes is disposable and rebuildable.** That is invariant 1,
and it is why there is no database.

## The flow

1. **ingest** — intake → manifest → extract → **classify and tier, before
   anything downstream can read it**
2. **compile** — extract → durable page. No input clip, ever.
3. **graph-export** — wikilinks → cytoscape, anti-regression guard inside the builder
4. **refresh-index** — cross-link, then embed locally if `uv` is present

Orchestrated by `daily.ps1`, which holds the resource locks and reports one of
five outcomes.

## The licence boundary

| Path | Licence |
|---|---|
| everything except `ee/` | Apache-2.0 |
| `ee/` | commercial |

Two rules, mechanically enforced on every commit: **Core never imports from
`ee/`** (`check:core-alone` deletes the subtree and runs the full suite), and
**every file declares its licence**, with the commercial identifier confined to
`ee/`.

## Why the vault is not a submodule

It is a separate, user-owned repo the CLI points at **by path**.

A submodule reconcile **always** aborts on a node whose vault working tree is
dirty — which is every node that runs the pipeline, because the pipeline is what
dirties it. Every remedy the internet offers for that message
(`checkout -f`, `reset --hard`, `clean -fd`) is a way to lose the user's
captures. The trap is that the obvious remedy *is* the failure mode.
