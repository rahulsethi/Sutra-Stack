<!-- SPDX-License-Identifier: Apache-2.0 -->

# Release cycle

How Sutra ships: the two editions, how they stay separated, the cadence, the
gates, where it goes, and what to say when it lands.

---

## Contents

- [The two editions](#the-two-editions)
- [How the editions stay separated](#how-the-editions-stay-separated)
- [Versioning](#versioning)
- [Cadence](#cadence)
- [The release gates](#the-release-gates)
- [Packaging — Core](#packaging--core)
- [Packaging — Enterprise](#packaging--enterprise)
- [Before the first public release](#before-the-first-public-release)
- [Where to release](#where-to-release)
- [Launch copy](#launch-copy)
- [Social posts](#social-posts)
- [After launch](#after-launch)
- [The release runbook](#the-release-runbook)

---

## The two editions

| | **Sutra Core** | **Sutra Enterprise** |
|---|---|---|
| Licence | Apache-2.0 | commercial |
| Price | free, forever | per-seat or per-deployment |
| Audience | individuals, developers, researchers | teams, regulated environments |
| Distribution | public — GitHub + npm | private — licensed artifact |
| Repository paths | everything except `ee/` | `ee/` only |
| Support | community, best effort | contractual |

### What Core includes

**Everything that makes the product's claim true.** The tier model, the gate, the
secret floor, the pipeline, retrieval, the knowledge graph, the MCP server with
all 14 tools, the CLI, the scheduler, BYO models, the full observability stack.

Core is a complete product, not a trial. That is a positioning decision, and it
is the one that matters: a governance tool whose free tier is crippled cannot be
trusted, because the thing you would be verifying is the thing behind the
paywall. The gate is auditable *because* it is free.

### What Enterprise adds

Only what a **multi-user, accountable** deployment needs and a single user does
not: per-subject clearance, signed policy bundles, a hash-linked audit chain,
external classifier composition, KMS key custody, SBOM attestation, retention
classes.

Every one of those is **additive and narrowing**. There is no Enterprise feature
that grants access Core would refuse.

### The positioning sentence

> **Core proves the gate holds. Enterprise proves who saw what.**

That is the whole commercial story. Core answers *"can my AI leak this?"*.
Enterprise answers *"prove to my auditor what was disclosed, to whom, and under
which policy version."* The second question only exists once more than one person
is involved, which is exactly when someone is willing to pay.

### Deliberately never paywalled

Put this in writing and keep it there. It removes the most obvious objection
before anyone raises it.

- the gate, the secret floor, tier enforcement
- the ability to audit any of the above
- any security fix, ever
- the whole regression suite

---

## How the editions stay separated

Four mechanisms. **Three are structural** — they hold whether or not anyone
remembers the rule.

### 1 · `ee/` is not an npm workspace

The root `package.json` declares `packages/*` only. `npm install`, `npm pack` and
`npm publish` at the root **cannot reach `ee/`**. This is the primary containment
mechanism and it requires no discipline to maintain.

### 2 · Core never imports from `ee/`

```sh
npm run check:core-alone     # deletes ee/, rebuilds, runs the ENTIRE suite
```

Runs on every commit. If Core ever depends on Enterprise, the build fails on the
commit that introduced it rather than at release.

### 3 · SPDX headers, checked

```sh
npm run check:license
```

Every file carries a licence identifier, and the commercial identifier **never**
appears outside `ee/`.

### 4 · The narrowing property

Asserted over the full cross-product of subjects, purposes and surfaces on every
build. `ee/` can only narrow access, never widen it.

### The failure mode to watch

**A feature that "obviously belongs in Enterprise" being built in Core, or vice
versa.** The test is not commercial appeal — it is:

> *Does a single user with one vault need this?*

Yes → Core. Only meaningful with multiple people or an external auditor →
Enterprise. Getting this backwards in the *tempting* direction — moving something
useful behind the paywall — is how a trust product loses its audience.

---

## Versioning

Semantic versioning, with one addition that matters more than the rest.

| Change | Bump | Example |
|---|---|---|
| A gate behaviour change | **MAJOR**, always | any change to what is visible at a ceiling |
| A new detection rule | MINOR | a new provider's key shape |
| A new CLI verb or MCP tool | MINOR | `sutra provider` |
| A bug fix, a doc fix | PATCH | |
| A tier rename or alias change | **MAJOR** | a tier rename has silently no-op'd a repair script before |

**Core and Enterprise share a version number.** Enterprise `2.3.0` requires Core
`2.3.0`. Independent versions would produce a compatibility matrix nobody
maintains, and a mismatch there is a governance bug.

### The rule that overrides all of the above

**Any change to what a model can see is a MAJOR release, however small the
diff.** A user who upgrades within a minor version must never find that their
`private` notes became visible. If you cannot describe the exposure change in one
sentence in the changelog, it is not ready to ship.

---

## Cadence

| Kind | When | Contents |
|---|---|---|
| **Security** | immediately | one fix, nothing else. Never bundled with features |
| **Patch** | as needed | fixes, docs |
| **Minor** | ~monthly | features, new rules, new surfaces |
| **Major** | when a gate behaviour changes | with a migration note |

### Security releases

- **Never bundled with features.** A user must be able to take the fix without
  taking anything else.
- **Both editions, same day.** Enterprise customers do not wait, and Core users do
  not wait for Enterprise.
- **Say what was exposed, to whom, and since when** — in the release notes, not in
  a private email. If the answer is "we cannot determine that", say that instead
  of implying a narrower scope than you can prove.

---

## The release gates

No release ships without all of these green. Not "usually" — the gate exists
precisely for the release you are in a hurry for.

```sh
npm run verify
```

That single command runs:

| Gate | Asserts |
|---|---|
| `build` | it compiles |
| `test` | the full regression suite |
| `test:ps` | the PowerShell suites, incl. two-binding classifier parity |
| `check:license` | SPDX headers; the commercial identifier confined to `ee/` |
| `check:no-bun` | the core stays runtime-agnostic |
| `leak-scan` | nothing personal or credential-shaped ships |
| `check:diagrams` | the diagrams render, offline, in the right theme |
| `build:ee` / `test:ee` | Enterprise builds and passes |
| `check:core-alone` | **`rm -rf ee/` still builds and passes everything** |

Plus, manually, every time:

```sh
npm pack --dry-run -ws       # READ the file list. Every release.
npm run sbom                 # the dependency budget: core 1, mcp 0
```

### The defect-coverage gate

The suite includes a meta-test that reads the project's own defect register and
asserts **every entry has a named, passing absence test — or an explicit, dated
decision to accept it.** It fails the build if that is not true.

That gate is what stops a release from quietly shipping with a known class of
failure unguarded. It is not optional and it is not skippable.

### Never use `--no-verify`

If a rule is wrong, fix the rule. A hook that gets routinely bypassed leaves you
with the *belief* that commits are scanned, while the large, risky ones are the
ones that skip it.

---

## Packaging — Core

```sh
# 1 · THE GATE: Core stands alone.
npm run check:core-alone

# 2 · Clean build from a clean install.
rm -rf packages/*/dist node_modules
npm ci
npm run build

# 3 · Everything.
npm run verify

# 4 · READ what would ship.
npm pack --dry-run --workspace packages/core
npm pack --dry-run --workspace packages/mcp
npm pack --dry-run --workspace packages/cli

# 5 · Tag and publish.
git tag -a v1.0.0 -m "Sutra Core 1.0.0"
git push origin v1.0.0
npm publish --workspace packages/core --access public
npm publish --workspace packages/mcp  --access public
npm publish --workspace packages/cli  --access public
```

### Step 4 is not a formality

Read the file list. **If an `.npmignore` ever appears in this repository, it
*replaces* `.gitignore` for packing rather than adding to it** — so gitignoring a
file does not keep it out of the tarball. Sutra ships no `.npmignore` for exactly
that reason, and a test asserts none has appeared. If one ever does, that test
tells you to extend it before shipping.

The same trap applies to every ignore-like file: `.dockerignore`, `.vercelignore`,
`.easignore`. Each is a separate egress surface with its own rules. Answer "what
does the uploader see?" **empirically**, by asking that tool, rather than by
reasoning about what it probably does.

### The GitHub release

Attach: the source tarball, `sbom.json`, the changelog section, and the checksums.
The release notes lead with **what changed about exposure** — even when the answer
is "nothing", because that is the sentence people are looking for.

---

## Packaging — Enterprise

```sh
npm run build:ee
npm run test:ee
npm run sbom > ee-sbom.json

# A licensed artifact — never a public registry.
tar czf sutra-enterprise-1.0.0.tgz ee/dist ee/LICENSE ee/README.md ee-sbom.json
sha256sum sutra-enterprise-1.0.0.tgz > sutra-enterprise-1.0.0.tgz.sha256
```

Three rules:

1. **Never publish `ee/` to a public registry.** There is no undo. Verify the
   `private` flag and the absence of `ee` from workspaces before every publish.
2. **`ee/LICENSE` travels in the artifact.** A commercial component without its
   terms attached is a support ticket at best.
3. **Ship the SBOM unasked.** Enterprise buyers will ask; generating it during the
   release is cheaper than generating it under a deadline.

Delivery options, in ascending order of effort: a licensed tarball with checksums;
a private npm registry scope; a customer-specific git repository.

---

## Before the first public release

**Two owner-only tasks. Neither is delegable, and one is blocking.**

### 1 · Credential rotation — BLOCKING

If any real credential was ever committed to this repository's history, **rotate
it now.** Not re-tier it, not delete the line, not amend the commit.

Re-tiering is **containment, not remedy**. The cleartext stays in git history,
and history is what gets cloned. Only rotation fixes it.

```sh
# Every commit that ever touched a credential-shaped path:
git log --all --full-history --oneline -- '*Keys.md' '*.env' '*secrets*'
npm run leak-scan     # what is in the tree NOW
```

The leak scan tells you about the working tree. History is a separate question and
needs a separate answer.

### 2 · Confirm the licence decision

Apache-2.0 for Core, commercial for `ee/`, contributions under the CLA. This is
settled — but confirm it is still what you want before it becomes irrevocable,
because a published Apache-2.0 release cannot be un-published.

---

## Where to release

Ordered by where this audience actually is. Do not do all of it at once — pick the
first two, then expand.

### Tier 1 — do these

| Platform | Why | Notes |
|---|---|---|
| **GitHub** | the canonical home | releases, tags, discussions. README is the product page |
| **npm** | how developers install it | `@sutra/aatma-core`, `@sutra/hermes-mcp`, `@sutra/cli` |
| **Hacker News** — Show HN | the highest-signal audience for a governance/privacy tool | post once, be present in the thread for the whole day |
| **MCP server directories** | intent-driven discovery — people arriving already wanting this | list under privacy / knowledge-management |

### Tier 2 — when Tier 1 has landed

| Platform | Why |
|---|---|
| **r/LocalLLaMA** | local-first, privacy-conscious, technical. Strong fit |
| **r/PKMS**, **r/ObsidianMD** | the notes-and-knowledge audience |
| **X / Twitter** | where AI-tooling conversation happens |
| **LinkedIn** | where the enterprise buyer is |
| **Lobste.rs** | smaller, sharper, good technical feedback |

### Tier 3 — sustained

| Platform | Why |
|---|---|
| **Dev.to / Hashnode** | long-form technical posts, good SEO |
| **Awesome-* lists** | awesome-mcp, awesome-selfhosted, awesome-privacy |
| **YouTube** | a two-minute `sutra gate` demo is worth a lot of prose |
| **Product Hunt** | broad reach; a weaker fit for a developer tool. Optional |

### Platform-fit note

This is a **trust** product. Audiences that reward extraordinary claims are the
worst fit, because the claim is falsifiable and someone will try. Prefer audiences
that will *check* — they are harder to win and they stay.

---

## Launch copy

### The one-liner

> **Sutra — your AI can reason over everything you know, and provably cannot leak
> what you marked private.**

### The elevator paragraph

> Sutra is a governed knowledge substrate. Your notes stay plain markdown in a git
> repo you own. Every note carries a sensitivity tier, and a server-side gate sits
> between those notes and every AI model. The model cannot lift the gate — not with
> a clever prompt, not with a tool argument. One command shows you exactly what any
> given model can see.

### The demo — lead with this everywhere

```console
$ sutra gate
  Ceiling: public.  Visible: 812.
  Withheld — private: 401, secret: 37, do_not_learn: 12.
```

**That output is the entire pitch.** It is checkable in thirty seconds by anyone
who installs it, which is the only kind of trust claim worth making.

### The three things to say, in this order

1. **Local-first, no account, no key required.** Retrieval, tiering, linking, the
   graph and cited answers all work with no model at all.
2. **The gate is server-side and auditable.** ~120 lines, zero dependencies. Not
   "trust us" — *read it*.
3. **Your notes are plain markdown in your git repo.** Nothing else in the system
   is irreplaceable; delete the caches and rebuild.

### Claims to make carefully

Everything below is true, and each is stated with its limit attached. **Do not
strip the limits** — an overstated claim on a falsifiable product gets found, and
being found once costs more than the reach was worth.

| Say | Not |
|---|---|
| "`secret` content reaches no model, hosted or local — four independent enforcement points, no override" | "unhackable" |
| "the model cannot lift the ceiling: it is read at server startup and no tool accepts it as an argument" | "prompt-injection-proof" |
| "unlabelled notes default to private, so forgetting to classify is safe" | "classifies everything perfectly" |
| "withheld items are counted and named, never silently dropped" | "you always get a complete answer" |
| "the detection rules ship with fixtures asserted in CI" | "catches every secret" |

### What NOT to lead with

- **The architecture.** Nobody's first question is "how many layers does it have?"
- **The invariant list.** It is what keeps the promise; it is not the promise.
- **Enterprise.** Core has to earn trust first. The enterprise conversation follows
  adoption; it cannot precede it.

---

## Social posts

Ready to use. Adjust the URLs.

### Hacker News — Show HN

> **Title:** Show HN: Sutra — a knowledge base your AI can read, with a gate it
> can't lift

> Body:
>
> I wanted my AI assistant to know everything I know, without deciding note by
> note what was safe to send. So the tier lives on the note and a gate sits
> between the notes and the model.
>
> Notes are plain markdown in a git repo I own. Every note carries a sensitivity
> tier. A deterministic pipeline turns captures into linked, searchable knowledge.
> The exposure ceiling is read from the environment at server startup — no tool
> accepts it as an argument, and the build fails if one ever does.
>
> One command shows what any model can actually see:
>
>     $ sutra gate
>       Ceiling: public.  Visible: 812.
>       Withheld — private: 401, secret: 37, do_not_learn: 12.
>
> `secret` content reaches no model, hosted or local — four independent
> enforcement points and no override flag. Anything withheld is counted and named
> rather than silently dropped, so you know when an answer was partial.
>
> Local-first. With no model configured at all, retrieval, tiering, linking, the
> graph and cited answers still work; a model adds prose on top. Apache-2.0; the
> gate is ~120 lines with zero dependencies, so you can read the thing making the
> decision rather than trusting a dependency tree.
>
> Happy to talk about anything — especially where you think the gate is wrong.

*Post on a weekday morning US time. Then stay in the thread. On a trust product,
how you answer the sceptical comment matters more than the post.*

### X / Twitter — thread

> **1/** Your AI assistant is either ignorant of your notes or trusted with all of
> them.
>
> I got tired of that trade, so I built the third option.
>
> 🧵

> **2/** Sutra: plain markdown in a git repo you own. Every note carries a
> sensitivity tier. A server-side gate sits between your notes and every model.
>
> The model cannot lift it. Not with a prompt. Not with a tool argument.

> **3/** One command tells you exactly what any model can see:
>
>     $ sutra gate
>       Ceiling: public.  Visible: 812.
>       Withheld — private: 401, secret: 37, do_not_learn: 12.
>
> Thirty seconds to check for yourself. That's the point.

> **4/** `secret` never reaches any model — hosted or local. Four independent
> enforcement points, no override flag, no "admin mode".
>
> Anything withheld is counted and named. You always know when an answer was
> partial.

> **5/** Unlabelled notes default to **private**.
>
> Forgetting to classify makes you safer, not less safe. Defaults should fail
> toward caution.

> **6/** Local-first. No account, no API key, no network needed.
>
> Search, tiering, linking, the graph and cited answers all work with zero models
> configured. A model adds prose synthesis on top — nothing more.

> **7/** Apache-2.0. The gate is ~120 lines with zero dependencies.
>
> Not "trust us" — read it.
>
> github.com/rahulsethi/Sutra-Stack

### r/LocalLLaMA

> **Title:** Built a governed note substrate for local models — the sensitivity
> tier lives on the note, and the gate is server-side
>
> The thing that stopped me pointing a model at my notes was that it was
> all-or-nothing. So: every note carries a tier, and a gate sits between the notes
> and the model. The ceiling is read at server startup, never from a tool argument.
>
> Relevant here specifically: **a local model is the only kind that may see
> `private` content.** Hosted providers are structurally ineligible — the router
> filters by tier before it considers capability, and no fallback re-admits what
> the tier filter excluded. `secret` reaches nothing at all, local included.
>
> Works with Ollama out of the box, or any OpenAI-compatible endpoint via
> `sutra provider add`. With no model at all you still get BM25 + vector retrieval,
> a knowledge graph, and cited answers.
>
> MCP server, so it plugs into Claude Code / Codex / whatever you use. Apache-2.0.

### LinkedIn

> Most "AI knowledge base" tools ask you to choose between two bad options: an
> assistant that knows nothing about your work, or one you have handed everything
> to and hope for the best.
>
> I have been building a third option.
>
> Sutra keeps knowledge as plain markdown in a git repository you own. Every note
> carries a sensitivity tier, and a governance gate sits between that knowledge and
> every AI model. The exposure ceiling is set server-side at startup — the model
> cannot raise it, and there is no override that reaches the top tier.
>
> The part I care about most is that it is *checkable*. One command reports exactly
> what a given model can see and what is being withheld, by tier. A governance
> claim you cannot verify in thirty seconds is a marketing claim.
>
> Sutra Core is Apache-2.0 and complete — the gate, the pipeline, the retrieval,
> the graph, all of it. Sutra Enterprise adds what a shared deployment needs:
> per-subject clearance, signed policy bundles, and a tamper-evident audit chain
> for when you have to prove to somebody else what was disclosed.
>
> Core proves the gate holds. Enterprise proves who saw what.

### The short one — for directories and awesome-lists

> **Sutra** — a governed knowledge substrate for AI. Plain markdown in your own git
> repo, a sensitivity tier on every note, and a server-side gate the model cannot
> lift. Local-first; works with no model configured. MCP server, CLI, 14 gated
> tools. Apache-2.0.

---

## After launch

### The first week

- **Answer everything**, especially the sceptical comments. Someone finding a real
  hole and telling you publicly is the best outcome available.
- **File every "how do I…?" as a docs bug.** On a governance tool, confusion *is* a
  defect: a user who misunderstands the tiers is a user who mis-tiers a note.
- **Fix installation friction immediately.** The PowerShell 7 vs 5.1 distinction
  will trip people. Watch for it and make the error message better.

### What to measure

| Signal | Why it matters |
|---|---|
| People who ran `sutra gate` and posted the output | they checked the claim — the only conversion that counts |
| Questions about tiers | the model is not landing; fix the docs |
| Anyone claiming a leak | **drop everything.** Reproduce, fix, disclose, release |
| Enterprise enquiries | the second question ("prove who saw what") has arrived |

### When someone reports a gate bypass

1. **Reproduce it before responding.** Then write the test that fails.
2. **Fix it, and expect the test to find more than the report did.** A guard fixed
   without a test written first has a habit of leaving siblings in place.
3. **Release the fix alone**, same day, both editions.
4. **Disclose plainly** — what was exposed, to whom, since when. If you cannot
   determine the scope, say that rather than implying a narrower one.

The register of what has gone wrong is a feature of this project, not an
embarrassment. A trust product that has never published a mistake has either never
been used or is not telling you.

---

## The release runbook

Copy-paste, in order.

```sh
# ── 0 · Preconditions ────────────────────────────────────────────────────
git switch main && git pull
git status --porcelain          # must be empty

# ── 1 · Clean, from scratch ──────────────────────────────────────────────
rm -rf node_modules packages/*/dist ee/dist
npm ci
npm run build

# ── 2 · Every gate ───────────────────────────────────────────────────────
npm run verify                  # includes check:core-alone and the coverage gate
npm run sbom

# ── 3 · Read what ships ──────────────────────────────────────────────────
npm pack --dry-run -ws          # READ IT. Every time.

# ── 4 · Prove the demo on a FRESH vault ──────────────────────────────────
node packages/cli/dist/bin.js init /tmp/release-check
SUTRA_VAULT=/tmp/release-check node packages/cli/dist/bin.js gate
SUTRA_VAULT=/tmp/release-check node packages/cli/dist/bin.js doctor

# ── 5 · Changelog ────────────────────────────────────────────────────────
#   Lead with: DID ANYTHING CHANGE ABOUT WHAT A MODEL CAN SEE?
#   If yes → MAJOR, with a migration note.
#   If no  → say so explicitly. That is the sentence people look for.

# ── 6 · Tag ──────────────────────────────────────────────────────────────
git tag -a v1.0.0 -m "Sutra 1.0.0"
git push origin main --tags

# ── 7 · Publish Core ─────────────────────────────────────────────────────
npm publish --workspace packages/core --access public
npm publish --workspace packages/mcp  --access public
npm publish --workspace packages/cli  --access public

# ── 8 · Package Enterprise ───────────────────────────────────────────────
npm run build:ee && npm run test:ee
tar czf sutra-enterprise-1.0.0.tgz ee/dist ee/LICENSE ee/README.md ee-sbom.json
sha256sum sutra-enterprise-1.0.0.tgz > sutra-enterprise-1.0.0.tgz.sha256
#   Private delivery only. NEVER a public registry.

# ── 9 · GitHub release ───────────────────────────────────────────────────
#   Attach: source tarball, sbom.json, checksums, changelog section.

# ── 10 · Announce ────────────────────────────────────────────────────────
#   Tier 1 first. Then be present in the threads for the day.
```

### Verify the install from a stranger's position

Before announcing, on a machine that has never seen this repository:

```sh
git clone https://github.com/rahulsethi/Sutra-Stack.git && cd Sutra-Stack
npm install && npm run build && npm run verify
node packages/cli/dist/bin.js init ~/test-vault
SUTRA_VAULT=~/test-vault node packages/cli/dist/bin.js gate
```

If that sequence does not reach the gate summary, the release is not ready — no
matter how green CI is. CI runs in an environment you configured; a stranger's
machine is the actual test.

---

## See also

| | |
|---|---|
| [`ONBOARDING.md`](ONBOARDING.md) | Core setup, step by step |
| [`ONBOARDING-ENTERPRISE.md`](ONBOARDING-ENTERPRISE.md) | Enterprise setup and packaging |
| [`DEPLOYMENT.md`](DEPLOYMENT.md) | topology, nodes, hosting, extension surfaces |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | the CLA |
| [`ee/LICENSE`](ee/LICENSE) | the commercial terms |
