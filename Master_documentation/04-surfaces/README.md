<!-- SPDX-License-Identifier: Apache-2.0 -->
# 04 · Surfaces

Every entry point, and **how each connects back** to the gate.

| Surface | Ceiling | Writes? | Connects back via |
|---|---|---|---|
| `sutra` CLI | `secret` on a local terminal; **the gateway's ceiling under `SUTRA_HOSTED=1`** | capture, review, reveal | `Brain` directly |
| `sutra-mcp` | `SUTRA_MCP_EXPOSURE`, read at startup | capture only, opt-in | `Brain` at a fixed ceiling |
| `@sutra/daemon` | keys off the **bind host**, never the client | via the dashboard | `Brain` + `assertBindPolicy` |
| `@sutra/dashboard` | the daemon's | review, reveal (loopback only) | the daemon |
| the pipeline | n/a — it writes, it does not answer | yes, it is the writer | `Classify` at ingest |
| `llms.txt` | **public only, positive filter** | no | its own allow-list walk |

## The one that surprises people

**The CLI runs at the `secret` ceiling** — you reading your own notes on your
own screen, with no model in the loop.

**Unless** `SUTRA_HOSTED=1`, in which case this process is a child of a gateway,
stdout **is** an egress, and the ceiling drops to whatever the gateway set. A CLI
that assumed "local means trusted" would become a gate bypass the moment someone
wired it behind a chat bot — which is exactly the sort of thing people wire.

## The daemon's bind host is a governance input

A `local_only` ceiling on a loopback socket is a person reading their own screen.
The identical ceiling on `0.0.0.0` is the whole vault published to the network.

Same ceiling, completely different meaning. So the read ceiling keys off the
**bind host**, not the client address — an address that merely *appears* local
(a proxy, an SSRF, a shared network namespace) grants nothing, because the
decision was made when the daemon started.
