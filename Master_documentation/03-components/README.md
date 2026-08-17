<!-- SPDX-License-Identifier: Apache-2.0 -->
# 03 · Components

| Package | What | Runtime deps | Status |
|---|---|---|---|
| `@sutra/aatma-core` | The governance core | **1** (`gray-matter`) | done |
| `@sutra/hermes-mcp` | stdio JSON-RPC 2.0, 14 tools | **0** | done |
| `@sutra/cli` | `sutra` — every read has `--json` | 0 external | done |
| `@sutra/daemon` | OPTIONAL. Loopback HTTP over the same gate. | 0 external | done |
| `@sutra/dashboard` | OPTIONAL. Zero-build static UI, 6 routes. | 0 external | done |
| `@sutra/ee` | COMMERCIAL. E1–E7 control plane. | core | done |
| `automation/` | pwsh 7 pipeline + optional Python | — | done |
| `vault-template/` | The skeleton. **Zero notes.** | — | done |

## `@sutra/aatma-core` internals

| Directory | Owns |
|---|---|
| `gate/` | `tiers` (the one normaliser) · `guard` (the comparison) · `exposure` · `containment` · `patterns` (the classifier) · `redact` · `override` |
| `vault/` | `client` (I/O, knows nothing about tiers) · `brain` (**the gated corpus walk**) · `capture` (the floored write) |
| `retrieval/` | `lexical` (BM25+RRF, always works) · `semantic` · `graph` · `hybrid` · `section` · `ask` |
| `run/` | `outcome` (five counters) · `metrics` (per-host series) · `lock` (ranked) |
| `persona/` | `routing` (a turn's local-vs-hosted decision, composed from the gate — never a re-implementation) · `prompt` (the system prompt, assembled from the ALREADY-GATED identity bundle) |
| `audit/` | append-only log, rotation, provider health |
| `quality/` | capture-ratio banding |

**The whole security review is `gate/`.** ~600 lines, no I/O beyond reading
policy files.

## The dependency counts are a claim, not a coincidence

One runtime dependency in Core, zero in the MCP server. The thing deciding what
your AI can see should be readable in an afternoon, and
`ee/src/supply/sbom.ts` enforces the ceiling so raising it is a decision rather
than an accident.
