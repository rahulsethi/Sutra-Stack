<!-- SPDX-License-Identifier: Apache-2.0 -->
# 07 · Setup

## Prerequisites

| Tool | Why | Required? |
|---|---|---|
| **Node ≥ 20** | the core, CLI and MCP server | yes |
| **git** | the vault is a git repo; it is how invariant 7 is true | yes |
| **PowerShell 7** (`pwsh`) | the pipeline. Cross-platform. | yes |
| `uv` | local embeddings + community detection | **no** |

`pwsh` is PowerShell 7 and runs on Windows, macOS and Linux. Windows PowerShell
5.1 is **not** a substitute, and Sutra deliberately does not fall back to it — a
fallback that half-works is harder to diagnose than an absence.

Without `uv`: no vector recall. Keyword search, BM25, tiering, linking, the
graph, the gate and cited answers are all unaffected.

## Bring-up

```sh
git clone <repo> sutra && cd sutra
npm install && npm run build
node packages/cli/dist/bin.js init
git config core.hooksPath .githooks      # once per clone
```

`sutra init` is idempotent and resumable: a step that fails records a blocker
and **later safe steps still run**. A missing `uv` must not prevent identity
being written.

## Wiring a harness

```sh
sutra wire claude --exposure public
sutra doctor --harness claude            # must report 14 tools AND a ceiling
```

Re-run `doctor` after **every** harness upgrade. See
[`06-mechanisms/`](../06-mechanisms/) M1 for why.

## Scheduling

```sh
sutra schedule install     # prints the exact OS commands; does not run them
```

It prints rather than runs because registering a recurring job on someone's
machine is not something a CLI should do without them seeing the command.

**One scheduler per cadence.** A job registered in both a harness cron and the
OS scheduler double-runs.

## Secrets

Never in a committed file. The override passphrase lives in
`state/secrets/override.key` (gitignored) or `SUTRA_OVERRIDE_PASSPHRASE`.
Enterprise replaces the resolver with a KMS — see `ee/src/keys/kms.ts`.
