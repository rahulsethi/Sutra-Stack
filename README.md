<!-- SPDX-License-Identifier: Apache-2.0 -->

# Sutra Stack

**Your AI can reason over everything you know, and provably cannot leak what you
marked private.**

Sutra is a governed knowledge substrate. Your notes are plain markdown in a git
repository you own. Every note carries a sensitivity tier. A deterministic
pipeline turns captures into durable, linked, searchable knowledge — and a
server-side **gate** sits between that knowledge and every AI model.

The model cannot lift the gate. Not with a clever prompt, not with a tool
argument, not by accident.

One command shows you exactly what any given model can see:

```console
$ sutra gate
  Ceiling: public.  Visible: 812.
  Withheld — private: 401, secret: 37, do_not_learn: 12.
```

---

## The four layers

| Layer | What it owns | Package |
|---|---|---|
| **Aatma** — governance & identity | tiers · the gate · exposure ceilings · redaction · audit | `@sutra/aatma-core` |
| **Dimaag** — knowledge substrate | ingest · classify · compile · graph · retrieval | `@sutra/aatma-core` + `automation/` |
| **Parvo** — persona & routing | identity bundle · turn routing · prompt assembly | `@sutra/aatma-core` |
| **Hermes** — integration surface | MCP server · CLI · optional daemon & dashboard | `@sutra/hermes-mcp`, `@sutra/cli` |

```
                        ┌──────────────────────────────────┐
   your editor ───────► │  your vault: plain .md + git     │  ← the only truth
   your phone  ───────► │  every note has a sensitivity    │
                        └───────────────┬──────────────────┘
                                        │
                          DIMAAG · ingest → classify → compile
                                    → graph → index
                                        │
                        ┌───────────────▼──────────────────┐
                        │  AATMA · THE GATE                │
                        │  ceiling read at startup,        │
                        │  never from a tool argument      │
                        └───────────────┬──────────────────┘
                                        │
                   PARVO · persona + which model may serve this turn
                                        │
                        ┌───────────────▼──────────────────┐
                        │  HERMES · MCP · CLI · daemon     │
                        └───────────────┬──────────────────┘
                                        │
                Claude Code · Codex · your own client · a local model
```

Everything below the vault is **derived and disposable**. Delete the caches, the
index and the graph; `sutra daily` rebuilds them. Your notes are never
at risk from a rebuild.

---

## Install

**Requirements** — all free, all cross-platform:

| | Needed for | Check |
|---|---|---|
| **Node.js 20+** | the core, MCP server and CLI | `node --version` |
| **PowerShell 7+** (`pwsh`) | the pipeline | `pwsh --version` |
| **git** | the vault's history | `git --version` |
| *(optional)* **Ollama** | local model answers | `ollama --version` |
| *(optional)* **uv** | HTML/PDF extraction | `uv --version` |

PowerShell 7 is not Windows-only and is not Windows PowerShell 5. Get it from
<https://aka.ms/powershell> — it runs on macOS and Linux too.

```sh
git clone https://github.com/rahulsethi/Sutra-Stack.git
cd Sutra-Stack

npm install
npm run build

# Install the git hooks in your clone (one time)
git config core.hooksPath .githooks

# Confirm the build is sound before you trust it with anything
npm run verify
```

Then create your vault:

```sh
node packages/cli/dist/bin.js init ~/sutra-vault
```

`sutra init` is interactive, creates nothing outside the directory you name, and
finishes by printing the gate summary above — so the first thing you see is proof
the gate works.

**Full walkthrough:** [`ONBOARDING.md`](ONBOARDING.md) — every step, every
dependency, what to do when one is missing, and how to verify each stage actually
ran. [`ONBOARDING-ENTERPRISE.md`](ONBOARDING-ENTERPRISE.md) covers policy
bundles, signed audit chains and multi-user deployment.

---

## Use it

```sh
sutra                       # what you can do
sutra gate                  # what a model can see, right now
sutra search "kafka"        # keyword search, gated
sutra ask "how do I ...?"   # cited answer, gated
sutra capture "a thought"   # write to the inbox, floored to private
sutra daily                 # ingest → compile → graph → index
sutra doctor                # is everything actually wired?
sutra provider list         # your models, and whose key is missing
sutra schedule list         # what runs on its own
```

Every read command takes `--json`. Exit codes are governance signals, not just
success/failure — see [`packages/cli/src/exit.ts`](packages/cli/src/exit.ts).

### Bring your own model

Any OpenAI-compatible endpoint — a commercial API, a company gateway, LM Studio,
vLLM, or Ollama locally.

```sh
sutra provider add --id my-gateway --base-url https://llm.example.com/v1                    --key-env MY_GATEWAY_API_KEY --model gpt-4o-mini
sutra provider key my-gateway     # how to set the key, for your platform
sutra provider test my-gateway    # reachable? credential accepted?
```

**Sutra never stores your API key** — the config records the *name* of an
environment variable, never its value. Each surface can carry its own key *and*
its own ceiling, so a hosted model can serve one harness at `public` while a
local model serves another at `private`, on the same vault.

A hosted provider is structurally ineligible for `private` and `secret` content.
Adding one cannot widen your exposure.

### Connect it to your AI

```sh
sutra wire claude           # or: hermes, codex
sutra doctor --harness claude
```

`sutra wire` registers the MCP server with your harness. `sutra doctor` then
speaks the protocol and asserts the tool count and the ceiling — because a
config file existing proves nothing about whether the harness reads it.

---

## The sensitivity model

Three tiers, plus one orthogonal flag.

| Tier | Meaning | Reaches a hosted model? |
|---|---|---|
| `public` | safe to send anywhere | yes |
| `private` | **the default for anything unlabelled** | only if the ceiling allows |
| `secret` | never leaves this machine | **never** |
| `do_not_learn` | excluded from every model, at every tier | never |

Four rules make this hold:

1. **The ceiling is server-side.** Read from the environment at server startup.
   No tool accepts a tier, ceiling, exposure or override argument — the build
   fails if one ever appears.
2. **The secret floor is absolute.** `secret` content reaches no model, hosted or
   local. Four independent enforcement points, no override, no flag.
3. **Sensitivity only ever rises.** Classification sets a floor; nothing lowers
   a tier.
4. **Unlabelled means private.** Forgetting to classify is safe by default.

Anything withheld is **counted and named in the response**, never silently
dropped — so you always know when the answer you got was partial.

---

## Local-first, cloud when you choose

The default topology is entirely on your machine. Nothing needs an account, an
API key or a network connection to work.

| Component | Default | Cloud option |
|---|---|---|
| Vault | your disk | your own private git remote |
| Pipeline | local `pwsh` | a self-hosted runner |
| MCP server | local stdio | — stays local, by design |
| Model | Ollama, or none at all | a hosted API, **public tier only** |
| Graph & index | local files | — |

With no model configured at all, retrieval, tiering, linking, the graph and
cited answers still work. A model adds prose synthesis on top and nothing else.

`secret` content never leaves the machine on any topology. That is not a
configuration setting.

See [`DEPLOYMENT.md`](DEPLOYMENT.md) for node placement, tier-partitioned
topologies, and what each option costs you.

---

## Extend it

Sutra exposes one surface — MCP — and everything plugs into that.

```sh
plugins/claude-code/    # Claude Code
plugins/codex/          # Codex
plugins/hermes/         # Hermes
```

Adding a new surface means adding a client of the MCP server, never a second
copy of the gate. [`DEPLOYMENT.md`](DEPLOYMENT.md#extending-with-a-new-surface)
walks through building one, including chat surfaces such as Telegram or Slack,
and the two rules any new surface has to satisfy.

---

## Observability

You should never have to trust that Sutra is working.

```sh
sutra doctor            # every component: wired, degraded, or broken
sutra gate              # what a model can see, and what is withheld, by tier
sutra status            # vault and pipeline health, including the last run
sutra logs --since 7    # what actually happened, with reasons
```

Every stage reports one of six distinct outcomes — `ok`, `degraded`, `failed`,
`skipped (no input)`, `skipped (policy)`, `no-op` — and they never share a
counter. A run that considered 400 notes and produced nothing reports `no-op`,
not success.

Every run appends one row to a CSV, from the first day. Every gate refusal is
audited with counts and paths, never content.

---

## Licence

| Path | Licence |
|---|---|
| everything except `ee/` | Apache-2.0 |
| `ee/` | commercial — see [`ee/LICENSE`](ee/LICENSE) |

`ee/` can only ever **narrow** access, never widen it, and that is asserted over
the full cross-product on every build. Delete `ee/` and you have a complete,
working, Apache-2.0 product — CI proves it on every commit.

Contributions welcome under the CLA: [`CONTRIBUTING.md`](CONTRIBUTING.md).

---

## For engineers

- [`CLAUDE.md`](CLAUDE.md) — the invariants, and the rules for changing this code
- [`AGENTS.md`](AGENTS.md) — for an assistant working *with* a user's vault
- [`DEPLOYMENT.md`](DEPLOYMENT.md) — topology, nodes, hosting, extension surfaces
- [`RELEASE.md`](RELEASE.md) — release cycle, edition separation, packaging, launch
- [`Master_documentation/`](Master_documentation/00-START-HERE.md) — architecture, mechanisms, decisions
- [`docs/diagrams/`](docs/diagrams/index.html) — the gate, the pipeline, the MCP surface
