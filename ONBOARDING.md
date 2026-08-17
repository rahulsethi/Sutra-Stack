<!-- SPDX-License-Identifier: Apache-2.0 -->

# Onboarding — Sutra Core

A complete, first-run walkthrough. Fifteen steps, each with a **verify** you can
run to prove the step actually worked before you move on.

> **Why every step has a verify.** A setup step that half-worked is worse than one
> that failed, because you carry on believing it succeeded. Nothing here asks you
> to trust that something is wired — each step ends in a command that prints the
> answer.

**Enterprise features** — policy bundles, signed audit chains, external
classifiers, KMS-held keys, SBOM attestation — are in
[`ONBOARDING-ENTERPRISE.md`](ONBOARDING-ENTERPRISE.md). Start here first; the
enterprise guide builds on this one.

---

## Contents

**Part 1 — Prerequisites** · [Step 1](#step-1--node-20) · [2](#step-2--powershell-7) · [3](#step-3--git) · [4](#step-4--optional-a-local-model) · [5](#step-5--optional-web-and-pdf-extraction)
**Part 2 — Install** · [6](#step-6--clone-and-build) · [7](#step-7--install-the-git-hooks) · [8](#step-8--verify-the-build)
**Part 3 — Your vault** · [9](#step-9--create-the-vault) · [10](#step-10--see-the-gate) · [11](#step-11--write-your-first-note) · [12](#step-12--run-the-pipeline)
**Part 4 — Connect your AI** · [13](#step-13--wire-a-harness) · [14](#step-14--prove-the-gate-holds)
**Part 5 — Keep it running** · [15](#step-15--schedule-it) · [15b](#step-15b--optional-bring-your-own-model) · [Observability](#observability) · [Extending](#extending-sutra) · [Troubleshooting](#troubleshooting)

---

# Part 1 · Prerequisites

Five dependencies. **Three are required, two are optional** — and Sutra tells you
plainly which are missing rather than degrading quietly.

| | Required? | Why | Without it |
|---|---|---|---|
| Node.js 20+ | **yes** | the core, MCP server and CLI | nothing runs |
| PowerShell 7 | **yes** | the pipeline | no ingest, compile, graph or index |
| git | **yes** | the vault's history and undo | no reversibility |
| Ollama | no | local model answers | retrieval and cited answers still work |
| uv | no | HTML and PDF extraction | those files queue as `tool-missing`, retried when you install it |

---

## Step 1 · Node 20+

Sutra targets Node 20 LTS or newer. The core is runtime-agnostic — no Bun, no
Deno-specific APIs — and CI asserts that.

**Install:** <https://nodejs.org> (or `winget install OpenJS.NodeJS.LTS`,
`brew install node`, `apt install nodejs`).

**Verify:**

```sh
node --version      # v20.x or higher
npm --version
```

If `node --version` prints v18 or lower, upgrade. Sutra uses `node:test` and
`--test` directory globbing, which need 20+.

---

## Step 2 · PowerShell 7

**This is the dependency people get wrong**, so read the whole step.

PowerShell 7 (`pwsh`) is a cross-platform, open-source shell that runs on
Windows, macOS and Linux. It is **not** the same as Windows PowerShell 5.1
(`powershell.exe`), which ships with Windows and will not work here.

**Install:** <https://aka.ms/powershell>

```sh
# Windows
winget install Microsoft.PowerShell

# macOS
brew install --cask powershell

# Linux (Debian/Ubuntu) — see the link above for other distros
sudo snap install powershell --classic
```

**Verify:**

```sh
pwsh --version      # PowerShell 7.4.x or higher
```

If that says "command not found" but `powershell -version` works, you have 5.1
and still need 7. They coexist happily; installing 7 does not disturb 5.1.

> **Why PowerShell at all?** The pipeline is where the substrate does its heavy
> lifting — file walking, frontmatter rewriting, classification, graph export. The
> classifier exists in two bindings, TypeScript and PowerShell, reading **one**
> shared rule file, and a test asserts the two classify an identical corpus
> identically. A rule that exists in only one language is a rule that does not
> exist on the paths written by the other.

---

## Step 3 · git

The vault is a git repository. That is what makes automated maintenance safe to
run unattended: every action it takes is tracked and reversible.

**Install:** <https://git-scm.com/downloads>

**Verify:**

```sh
git --version
git config --get user.name     # must print something
git config --get user.email    # must print something
```

If either config value is empty, set it now — the pipeline takes safety commits
on your behalf and git refuses to commit without an identity:

```sh
git config --global user.name  "Your Name"
git config --global user.email "you@example.com"
```

---

## Step 4 · *(optional)* A local model

With no model at all, Sutra still gives you: keyword search, hybrid search,
graph traversal, section reads, and **cited answers assembled from your own
notes**. A model adds prose synthesis on top of those and nothing else.

A local model is the right default because it is the only kind that may see
`private` content. `secret` content reaches **no** model, local included.

**Install Ollama:** <https://ollama.com/download>

```sh
ollama pull qwen2.5:7b       # or any model you prefer
ollama serve                 # usually already running as a service
```

**Verify:**

```sh
ollama --version
curl http://127.0.0.1:11434/api/tags     # lists your installed models
```

**Skipping this is fine.** Sutra reports `provider: unconfigured` rather than
failing, and `unconfigured` is deliberately a different outcome from `failed` —
one means you have not set something up, the other means something broke.

---

## Step 5 · *(optional)* Web and PDF extraction

To ingest `.html` or `.pdf` files, Sutra shells out to external extractors.

```sh
# uv — for HTML extraction via trafilatura
# https://docs.astral.sh/uv/getting-started/installation/
curl -LsSf https://astral.sh/uv/install.sh | sh     # macOS/Linux
winget install astral-sh.uv                          # Windows

# pdftotext — part of poppler
brew install poppler          # macOS
sudo apt install poppler-utils # Debian/Ubuntu
winget install oschwartz10612.Poppler # Windows
```

**Verify:**

```sh
uv --version
pdftotext -v
```

**Skipping this is fine, and recoverable.** Those files are queued with the
reason `tool-missing`, which is a *different* enum value from `source-empty`.
That distinction matters: `tool-missing` items are retried automatically once the
tool appears, and `source-empty` items never are. Install the tool later, re-run
`sutra ingest`, and the backlog clears itself.

---

# Part 2 · Install

## Step 6 · Clone and build

```sh
git clone https://github.com/rahulsethi/Sutra-Stack.git
cd Sutra-Stack

npm install
npm run build
```

`npm install` pulls exactly **one** runtime dependency for the whole governance
core (`gray-matter`, for frontmatter parsing). The MCP server — the component
that decides what your AI can see — has **zero** external dependencies, so
auditing it means reading one file, not a dependency tree.

**Verify:**

```sh
ls packages/core/dist/index.js      # the core built
ls packages/mcp/dist/bin.js         # the MCP server built
ls packages/cli/dist/bin.js         # the CLI built
```

### Put `sutra` on your PATH

Everything below uses `sutra` as a bare command. Choose one:

```sh
# Option A — link it globally (recommended)
npm link --workspace packages/cli
sutra --version

# Option B — an alias, no global install
alias sutra="node $PWD/packages/cli/dist/bin.js"                       # bash/zsh
Set-Alias sutra "node $PWD/packages/cli/dist/bin.js"                   # pwsh

# Option C — call it in full every time
node packages/cli/dist/bin.js --version
```

**Verify:**

```sh
sutra --version
sutra                 # prints the command list
```

---

## Step 7 · Install the git hooks

```sh
git config core.hooksPath .githooks
```

This installs a pre-commit secret scan in **your clone**. Git does not do this
automatically — hooks are per-clone and never travel with a repository, so this
step is easy to skip and invisible when skipped.

**Verify** that the hook is live by trying to commit something it must refuse:

```sh
printf 'ANTHROPIC_API_KEY=sk-ant-api03-%s\n' "$(head -c 40 /dev/urandom | base64 | tr -d '/+=' | head -c 40)" > /tmp/leaktest.env
git add -f /tmp/leaktest.env 2>/dev/null || cp /tmp/leaktest.env ./leaktest.env && git add -f ./leaktest.env
git commit -m "this must be refused"
# EXPECTED: the commit is REFUSED, naming the rule that matched.
git reset && rm -f ./leaktest.env /tmp/leaktest.env
```

If that commit **succeeded**, the hook is not installed. Re-run the
`git config` line and check `git config --get core.hooksPath` prints
`.githooks`.

> Please do not use `--no-verify`. A hook that gets routinely bypassed leaves you
> with the *belief* that your commits are scanned while the large ones — the risky
> ones — are not. If a rule is wrong, fix the rule in
> `automation/policies/secret-patterns.json`, which is the single place every
> scanner reads.

---

## Step 8 · Verify the build

```sh
npm run verify
```

This runs, in order: build → the full test suite → the PowerShell suite → the
licence boundary → the runtime-agnostic check → the leak scan → the diagram
check → the commercial build → and finally `check:core-alone`, which **deletes
`ee/` and asserts the remaining Apache-2.0 product still builds and passes**.

**Verify:** it exits 0 and the last line reports every suite passing.

Individual gates, if you need to narrow down a failure:

| Command | Checks |
|---|---|
| `npm test` | the TypeScript regression suite |
| `npm run test:ps` | the PowerShell suites, incl. the two-binding classifier parity |
| `npm run leak-scan` | nothing personal or credential-shaped ships |
| `npm run check:license` | the Apache / commercial boundary |
| `npm run check:core-alone` | `rm -rf ee/` still builds and passes |
| `npm run check:no-bun` | the core stays runtime-agnostic |

If `npm run test:ps` reports that `pwsh` is missing, it **fails** rather than
skipping. That is deliberate: those suites contain the only assertion that the
two classifier bindings agree, and skipping it silently would leave you believing
a check ran that did not.

---

# Part 3 · Your vault

## Step 9 · Create the vault

```sh
sutra init ~/sutra-vault
```

`sutra init` is interactive and **idempotent** — safe to re-run any time. It
creates nothing outside the directory you name.

It will:

1. create the vault skeleton (`vault/`, `raw/`, `compiled/`, `graph/`, `logs/`, `state/`)
2. `git init` the vault and take a first commit
3. write starter templates — all defaulted to `sensitivity: private`
4. probe your prerequisites and report each one
5. run the gate self-test and print the result

**Verify:**

```sh
cd ~/sutra-vault && git log --oneline | head -3 && cd -
sutra status --vault ~/sutra-vault
```

### Tell Sutra where the vault is

```sh
export SUTRA_VAULT="$HOME/sutra-vault"        # bash/zsh — add to your profile
$env:SUTRA_VAULT = "$HOME/sutra-vault"        # pwsh — add to $PROFILE
```

Or pass `--vault ~/sutra-vault` to every command. The rest of this guide assumes
`SUTRA_VAULT` is set.

**Verify:** `sutra status` works with no `--vault` flag.

---

## Step 10 · See the gate

This is the command that makes the product's claim checkable, so run it before
you have any content — the numbers should all be zero, and that is itself
informative.

```sh
sutra gate
```

```console
  Ceiling: public.  Visible: 0.
  Withheld — private: 0, secret: 0, do_not_learn: 0.
```

**Verify:** it names a ceiling and gives you four counts.

The **ceiling** is the maximum sensitivity a given client may see. It is read
from the environment when a server starts and is **never** accepted as an
argument from a model. To see the vault at a different ceiling:

```sh
SUTRA_MCP_EXPOSURE=private sutra gate
SUTRA_MCP_EXPOSURE=secret  sutra gate     # your own local view
```

Note that `secret` here means *your* view on this machine. No model gets it.

---

## Step 11 · Write your first note

Two ways in. Use both, because they behave differently on purpose.

**A · Write a file yourself.** This is the normal path — your editor, your files.

```sh
cat > ~/sutra-vault/vault/10-notes/kafka-retention.md <<'EOF'
---
title: Kafka retention
sensitivity: public
status: active
type: Note
---

# Kafka retention

`retention.ms` is per-topic and overrides the broker default. Setting it to `-1`
keeps messages forever, which interacts badly with `log.retention.bytes`.
EOF
```

**B · Let an agent capture something.** This is the *only* write path an AI has,
and it is deliberately narrow:

```sh
sutra capture "Check whether the retention change shipped to staging"
```

**Verify:**

```sh
sutra search retention
sutra gate            # Visible should now be 1, with 1 withheld as private
```

Notice what happened: the note you wrote as `public` is visible. The captured
one is **floored to `private`** regardless of what was asked for. An agent write
can never land as `public`, cannot overwrite an existing file, and lands only in
the inbox.

> **Anything unlabelled is `private`.** Forgetting to set a sensitivity is safe;
> the failure mode of forgetting is *less* exposure, never more.

---

## Step 12 · Run the pipeline

```sh
sutra daily
```

Five stages, in order: **ingest → compile → graph → index → hygiene**. Each
reports its own outcome, and the outcomes are not interchangeable:

| Outcome | Means |
|---|---|
| `ok` | it did the work |
| `degraded` | it did *less* than ideal, and says why |
| `failed` | something broke |
| `skipped (no input)` | there was nothing to do — **not** an error |
| `skipped (policy)` | a rule prevented it — deliberate |
| `no-op` | it had input, ran, and produced nothing — **this is a warning** |

**Verify:**

```sh
sutra status            # the last run, stage by stage
sutra logs --since 1    # what happened, with reasons
```

Read the summary line for each stage. `no-op` on a stage that had input is the
one to investigate: it means the stage looked at your notes and produced nothing.

Individual stages, if you want to run them separately:

```sh
sutra ingest            # raw/inbox → extracts + manifests
sutra graph export      # rebuild the knowledge graph
sutra refresh-index     # rebuild the retrieval index
sutra hygiene           # the review queue
sutra backup            # a snapshot plus a git safety commit
```

Everything these produce is **derived**. Delete `compiled/`, `graph/` and the
index and re-run — you lose nothing but time.

---

# Part 4 · Connect your AI

## Step 13 · Wire a harness

```sh
sutra wire claude                              # Claude Code
sutra wire claude --exposure public            # pick the ceiling explicitly
sutra wire hermes
sutra wire codex
```

`--exposure` sets the ceiling **for that harness**. It is written into the
harness's server registration as an environment variable, which the server reads
once at startup. The model on the other side cannot change it.

Choose deliberately:

| `--exposure` | The harness sees | Use when |
|---|---|---|
| `public` | public notes only | the harness talks to a hosted model |
| `private` | public + private | the harness runs a local model |
| `secret` | — **refused**; the floor is absolute | never |

**Verify — and this step matters more than it looks:**

```sh
sutra doctor --harness claude
```

`sutra doctor` does not check that a config file exists. It **starts the server,
speaks the MCP protocol to it, and asserts the tool count and the ceiling**. A
harness upgrade that silently stops reading its registration leaves an empty tool
list and no error anywhere — the gated read path would be dead and nothing would
say so. Only speaking the protocol catches that.

Expect: `mcp.tools  14 tools at ceiling public`.

Then restart your harness and ask it something only your notes could answer.

---

## Step 14 · Prove the gate holds

Do this once, yourself. It takes two minutes and it is the whole point.

```sh
# 1 · Write a secret note.
cat > ~/sutra-vault/vault/10-notes/secret-thing.md <<'EOF'
---
title: The passphrase hint
sensitivity: secret
status: active
---

# The passphrase hint

The staging passphrase hint is "second dog, first street".
EOF

# 2 · Your own local view — you can see it.
SUTRA_MCP_EXPOSURE=secret sutra search passphrase

# 3 · A hosted model's view — it is GONE, and the omission is COUNTED.
SUTRA_MCP_EXPOSURE=public sutra search passphrase
SUTRA_MCP_EXPOSURE=public sutra ask "what is the staging passphrase hint?"

# 4 · The summary.
SUTRA_MCP_EXPOSURE=public sutra gate
```

**Verify:** at the `public` ceiling, step 3 returns no content from that note,
and step 4 counts it under `secret`. The answer in step 3 tells you something was
withheld — it does not pretend the note does not exist and it does not silently
give you a partial answer.

Then try the other direction — a planted credential:

```sh
printf -- '---\ntitle: scratch\n---\n\nsk-ant-api03-%s\n' \
  "$(head -c 40 /dev/urandom | base64 | tr -d '/+=' | head -c 40)" \
  > ~/sutra-vault/vault/00-inbox/scratch.md

sutra rescan            # report only
sutra rescan --apply    # re-tier what matched
head -5 ~/sutra-vault/vault/00-inbox/scratch.md
```

**Verify:** the note's `sensitivity` is now `secret`. Classification only ever
*raises* a tier — nothing in Sutra can lower one.

> Re-tiering is containment, not remedy. If a real credential was ever committed,
> it is still in git history and **only rotating it fixes that**. Sutra says so
> rather than implying it cleaned up for you.

---

## Step 15b · *(optional)* Bring your own model

You are not limited to Ollama. Any endpoint that speaks the OpenAI-compatible
`/v1/chat/completions` shape works — a commercial API, a company gateway, a model
you host yourself, LM Studio, vLLM, anything.

```sh
sutra provider list           # what is configured, and whose key is missing
```

Seven providers ship pre-declared and **all disabled**, so nothing is contacted
until you choose it. Enable one by adding your key and flipping `enabled`.

### Add your own

```sh
sutra provider add   --id my-gateway   --base-url https://llm.mycompany.com/v1   --key-env MY_GATEWAY_API_KEY   --model gpt-4o-mini   --reasoning
```

Then set the key — the command prints the exact syntax for your platform:

```sh
sutra provider key my-gateway
sutra provider test my-gateway      # probe it: reachable? credential accepted?
```

**Sutra never stores your API key.** The config records the *name* of an
environment variable, never its value. A key written into a config file inside a
git repository is a key that gets committed — and deleting the line afterwards
does not fix it, because the cleartext stays in history and only rotation does.
`sutra provider list` tells you *whether* each key is set and never prints a
character of one.

`sutra provider add` will refuse outright if you pass something key-shaped where a
variable name belongs.

### Two things `add` does for you

- **It adds the provider disabled.** You get a moment to read what you just wrote
  before it starts serving traffic. `--enable` skips that if you are sure.
- **It checks the secret scanner knows your key's shape,** and says so loudly when
  it does not. A configurable provider whose key the scanner cannot recognise is a
  credential that can be committed unnoticed. It prints the JSON to paste into
  `automation/policies/secret-patterns.json` — one file, read by the classifier,
  the commit hook and the leak scan alike.

### `--local` is the field that matters

| | `--local` | hosted (default) |
|---|---|---|
| Runs on | your machine | someone else's computer |
| May be handed | `public` **and `private`** | `public` **only** |
| `secret` content | never | never |

A hosted provider is **structurally ineligible** for private content. The router
filters by tier before it considers capability, cost or availability, and no
fallback re-admits what the tier filter excluded. So adding a commercial API
cannot widen your exposure — it adds an option for public work and nothing else.

### A different model per surface

This is the part worth knowing. Each surface gets **its own key and its own
ceiling**, both set in that surface's MCP registration:

```json
{
  "mcpServers": {
    "sutra": {
      "command": "node",
      "args": ["/abs/path/packages/mcp/dist/bin.js"],
      "env": {
        "SUTRA_VAULT": "/abs/path/your-vault",
        "SUTRA_MCP_EXPOSURE": "public",
        "MY_GATEWAY_API_KEY": "<the key for THIS surface only>"
      }
    }
  }
}
```

`sutra wire <harness>` writes that block for you. So you can run a hosted model at
a `public` ceiling for one harness and a local model at `private` for another, on
the same vault, at the same time — and neither can reach the other's ceiling,
because each server reads its own at startup and no model can change it.

**Verify:**

```sh
sutra provider list
sutra doctor              # the chain, plus any unconfigured key BY VARIABLE NAME
sutra ask "test question" # the real end-to-end check
```

`sutra doctor` reports a missing key as `unconfigured`, which is deliberately a
**different outcome** from `failed`. One means you have not set something up; the
other means something broke. Collapsing them is how every request ends up burning
attempts on providers that were never going to answer.

---

# Part 5 · Keep it running

## Step 15 · Schedule it

```sh
sutra schedule list         # what is registered right now
sutra schedule install      # PRINTS the exact commands to register it
```

Read that again, because it is deliberate: **`sutra schedule install` prints the
commands; it does not run them.** Registering a recurring job on someone's
machine is not something a CLI should do without them seeing the exact command
first. Copy the output and run it yourself.

It targets Task Scheduler on Windows, `launchd` on macOS, and `systemd --user` on
Linux, and it **refuses** if Sutra jobs are already registered — a job registered
twice double-runs, and two runs writing one derived artifact corrupt it. Pass
`--force` only if you are certain.

While you are there: **set the time limit from measured runtime, with headroom.**
Time your first few runs. A scheduler limit shorter than the job kills it
silently, and the only evidence is a log with a start line and no stop.

**Verify** with the platform's own tooling, not just `sutra schedule list`:

```sh
schtasks /query /tn "Sutra*"                       # Windows
launchctl list | grep -i sutra                     # macOS
systemctl --user list-timers | grep -i sutra       # Linux
```

Then confirm it actually *ran* — the day after:

```sh
sutra status            # the last run's timestamp should be recent
```

> **A scheduled job that never runs looks exactly like a healthy one.** The
> check that matters is not "is the timer installed" but "when did it last
> finish". `sutra status` will tell you loudly if a run started and never ended,
> or if no run has ever been recorded, or if the last run did nothing while input
> existed — three different alarms, because they have three different causes.

---

## Observability

You should never have to trust that Sutra is working. Four commands, and one file.

```sh
sutra doctor            # every component: wired, degraded, or broken
sutra gate              # what a model can see, and what is withheld, by tier
sutra status            # vault + pipeline health, including the last run
sutra logs --since 7    # what actually happened, with reasons
```

All four take `--json` for scripting. With `--json`, stdout is JSON *only* —
human notes go to stderr — so you can pipe safely.

### What gets recorded, automatically

| Where | What | Why it exists |
|---|---|---|
| `state/checks/last-run.json` | the current/last run, with `ended_at: null` while in flight | a run killed mid-flight writes no failure record; the only evidence is a start with no end |
| `state/metrics.csv` | **one appended row per run** — notes by tier, graph size, provider outcomes | a point-in-time value always looks fine; only a series answers "is this growing?" |
| `logs/sutra/provider.ndjson` | every provider attempt and its outcome | distinguishes a dead key from a rate limit — a key that has *never once* succeeded is a different problem |
| the audit log | every gate refusal, with counts and paths | never content |

The metrics CSV appends from day one, at roughly 250 bytes per run. It cannot be
added retroactively when you finally need it, which is always mid-incident.

### Reading the metrics series

```sh
sutra logs --json --since 30 | jq '.'
```

Two properties worth knowing:

- **Deltas are computed per host.** If two machines write into one vault, their
  rows are never compared to each other. Interleaving them produces graphs that
  appear to shrink when nothing was lost.
- **An unmeasurable value is a blank cell, never a zero.** "I could not measure
  this" and "this is zero" are different facts, and a threshold firing on the
  first is how a metric becomes misleading.

### The alarms that fire on their own

`sutra status` and `sutra doctor` raise these without being asked:

- a run **started and never ended** (usually a scheduler time limit shorter than the job)
- **no run has ever been recorded**
- the last run **did nothing while input existed**
- the graph **shrank** on this host, or its communities collapsed to zero
- a provider with **zero lifetime successes** — a dead key, not throttling
- the detection rule set **changed** since your notes were last classified, so a `sutra rescan` is due

---

## Extending Sutra

Sutra exposes exactly **one** surface: the MCP server. Everything — Claude Code,
Codex, Hermes, a chat bot, your own script — is a *client* of that surface.

```
                    ┌──────────────────────────┐
                    │  AATMA · the gate        │
                    │  ceiling fixed at start  │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │  HERMES · MCP server     │   ← one gate, one place
                    │  stdio JSON-RPC, 14 tools│
                    └────────────┬─────────────┘
         ┌──────────────┬────────┴───────┬──────────────┐
         ▼              ▼                ▼              ▼
   Claude Code       Codex           Hermes        your surface
                                                (Telegram, Slack,
                                                 a web UI, a script)
```

**The two rules any new surface must satisfy:**

1. **It is a client, never a second gate.** Call the MCP server. Do not read the
   vault directly, do not re-implement tier comparison, do not add a regex to your
   own scanner. There is one policy engine and one tier normaliser, and every
   duplicate of them has historically failed *open* in at least one copy.
2. **Its ceiling comes from its own environment, at startup.** Give each surface
   its own registration with its own `SUTRA_MCP_EXPOSURE`. A surface that takes a
   ceiling as a request parameter is broken by construction.

### Building one — Hermes as the worked example

Start from `plugins/hermes/`, which is a complete, small example:

```sh
ls plugins/hermes/
sutra wire hermes --exposure private
sutra doctor --harness hermes
```

### A chat surface (Telegram, Slack, Discord)

Perfectly viable, and the shape is always the same:

```
Telegram ──► your small bot process ──► MCP client ──► sutra-mcp ──► gate ──► vault
```

Your bot holds the platform token and speaks MCP to Sutra. Sutra itself never
learns the token, never opens a socket to a chat platform, and never sends a
message.

Three things to get right, each learned the hard way:

- **Give the chat surface a `public` ceiling.** A chat platform is a third party
  with its own retention, its own logs and its own breach surface. `private`
  content on it is exposure you did not choose.
- **Never replay a backlog on restart.** A poller that resumes from an offset
  after a crash re-executes commands the user already saw succeed. Acknowledge
  before acting, not after.
- **Do not scrape your own output for status.** If the bot needs to know whether a
  run succeeded, read `state/checks/last-run.json` or `sutra status --json`.
  Parsing your own rendered message is how a locale change turns a fifteen-alert
  day into a silent one, and how a platform length limit truncates the *bad* days
  specifically — a bad report is always a longer message than a good one.

> If you build an outbound chat sender **into this repository** rather than
> alongside it, the test suite will tell you so: the coverage gate watches for
> outbound-send APIs appearing in `packages/`, `automation/` or `ee/`, and asks
> for the accompanying test before that feature ships. Building your bot as a
> separate process, which is the recommended shape anyway, is unaffected.

### Adding a data source

To ingest a new file type, register an extractor in
`automation/scripts/ingest.ps1` and give it a reason enum value. Two rules:

- **Never truncate a source.** If a source exceeds the model's window,
  chunk-and-merge or refuse. Record `source_chars_seen` alongside
  `source_chars_total` so any shortfall is a fact on the artifact rather than
  something you would have to infer.
- **A missing tool and an empty source are different outcomes.** `tool-missing`
  is retried when the tool appears; `source-empty` never is. One string covering
  both leaves a backlog nobody can triage.

### Adding a model provider

Edit `automation/policies/provider-router.json`. Add the provider, and **add its
key shape to `automation/policies/secret-patterns.json` in the same commit** — CI
asserts those two stay in step, because a configurable provider whose key the
scanner cannot recognise is a credential that can be committed silently.

```json
{
  "id": "my-provider",
  "kind": "openai-compatible",
  "local": false,
  "enabled": true,
  "key_env": "MY_PROVIDER_API_KEY",
  "base_url": "https://api.example.com/v1",
  "reasoning_capable": true
}
```

`"local": false` makes it ineligible for `private` and `secret` content — the
gate filters by tier before it considers capability, and no fallback re-admits
what the gate excluded.

**Verify:**

```sh
sutra doctor            # the provider chain, and any unconfigured keys by name
npm run test:ps         # the router's own suite
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `pwsh: command not found` | PowerShell 7 missing (5.1 does not count) | Step 2 |
| `no vault root` | `SUTRA_VAULT` unset | `export SUTRA_VAULT=...` or pass `--vault` |
| Harness shows **no** Sutra tools | the harness is not reading its registration | `sutra doctor --harness X`, then restart the harness |
| `provider: unconfigured` | no model key set | expected; retrieval still works. Step 4 to add one |
| Items stuck as `tool-missing` | `uv` or `pdftotext` absent | Step 5, then `sutra ingest` — they retry automatically |
| A note you expected is missing from an answer | it is above that client's ceiling | `sutra gate` to confirm; `sutra review` grants a time-boxed exposure for **one** note |
| `sutra rescan` wants to re-tier everything | the detection rule set changed | expected after an update. Run `sutra rescan --apply` |
| The commit hook refused a real file | a detection rule over-matches | fix the rule in `automation/policies/secret-patterns.json` — not `--no-verify` |
| A pipeline stage reports `no-op` | it had input and produced nothing | `sutra logs --since 1` gives the reason |
| `npm run test:ps` fails with "pwsh not on PATH" | by design — not a skip | Step 2 |

### When you are genuinely stuck

```sh
sutra doctor --json > doctor.json
sutra status  --json > status.json
```

Both are safe to share: they carry counts, paths and outcomes — never note
content.

---

## What to read next

| | |
|---|---|
| [`ONBOARDING-ENTERPRISE.md`](ONBOARDING-ENTERPRISE.md) | policy bundles, signed audit chains, multi-user |
| [`DEPLOYMENT.md`](DEPLOYMENT.md) | node placement, local vs cloud, tier-partitioned topologies |
| [`AGENTS.md`](AGENTS.md) | for an assistant working *with* your vault |
| [`CLAUDE.md`](CLAUDE.md) | the invariants, if you intend to change the code |
| [`docs/diagrams/index.html`](docs/diagrams/index.html) | the gate, the pipeline, the MCP surface |
