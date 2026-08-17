<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- This GUIDE is Apache-2.0. The `ee/` SUBTREE it describes is not — see ee/LICENSE. -->

# Onboarding — Sutra Enterprise

Sutra Enterprise (`ee/`) adds per-subject clearance, signed policy bundles, a
tamper-evident audit chain, external classifier composition, KMS-held keys, and
SBOM attestation.

**Do [`ONBOARDING.md`](ONBOARDING.md) first.** Enterprise does not replace Core;
it sits on top of it and can only ever *narrow* what Core already permits.

---

## Contents

- [Core vs Enterprise](#core-vs-enterprise)
- [The one property that matters](#the-one-property-that-matters)
- [Step 1 — licence and build](#step-1--licence-and-build)
- [Step 2 — subjects and clearance](#step-2--subjects-and-clearance)
- [Step 3 — a signed policy bundle](#step-3--a-signed-policy-bundle)
- [Step 4 — the audit chain](#step-4--the-audit-chain)
- [Step 5 — key custody](#step-5--key-custody)
- [Step 6 — external classifier composition](#step-6--external-classifier-composition)
- [Step 7 — SBOM and dependency policy](#step-7--sbom-and-dependency-policy)
- [Step 8 — bring your own model, per team](#step-8--bring-your-own-model-per-team)
- [Step 9 — deploy](#step-9--deploy)
- [Packaging and distribution](#packaging-and-distribution)
- [Observability and audit review](#observability-and-audit-review)
- [Troubleshooting](#troubleshooting)

---

## Core vs Enterprise

| | **Sutra Core** (Apache-2.0) | **Sutra Enterprise** (`ee/`, commercial) |
|---|---|---|
| Tier model, gate, secret floor | ✅ complete | inherits Core's, unchanged |
| Exposure ceiling | **one per server**, from the environment | **per subject × purpose × surface** |
| Who is asking | not modelled — one user | subjects derived from IdP claims |
| Policy | files in your repo | **signed, versioned, verifiable bundles** |
| Audit | append-only log | **hash-linked chain**, tamper-evident |
| Classification | the shipped rule set, two bindings | + **external classifier composition** |
| Key custody | environment variables | **KMS / HSM provider interface** |
| Supply chain | one dependency, zero in MCP | + **SBOM generation and dependency policy** |
| Retention classes | — | per-entry retention classification |
| Price | free, forever | commercial licence |

### What Enterprise is *not*

It is **not** a way to see more. There is no enterprise feature that grants
access Core would have refused, and there is no configuration that lifts the
secret floor. If you are looking for "an admin override that reads everything",
it does not exist in either edition — by design, and the tests enforce it.

### Choosing

**Core is enough** for one person, one vault, one ceiling per harness — which is
most individual use, and is genuinely complete rather than crippled.

**You need Enterprise** when two or more people share one governed corpus and
must see *different* subsets of it, or when you have to *prove* to somebody else
what was disclosed and to whom.

---

## The one property that matters

```
   effective ceiling  =  MIN( Core's ceiling,
                              subject clearance,
                              purpose limit,
                              surface limit )
```

**`ee/` can only narrow. Never widen.** This is asserted over the *full
cross-product* of subjects, purposes and surfaces on every single build — not
sampled, not spot-checked.

That property is what makes an enterprise security review tractable: it reduces
to **"read Core's gate"**, roughly 120 lines with no dependencies. Everything in
`ee/` is provably incapable of loosening it.

Two structural facts back this up, both enforced in CI:

1. **Core never imports from `ee/`.** `rm -rf ee/` must build and pass the entire
   suite. Enterprise is additive, so it cannot have removed a check.
2. **The commercial identifier never appears outside `ee/`.** Every file carries
   an SPDX header and the boundary is checked on every commit.

```sh
npm run check:core-alone     # deletes ee/, rebuilds, runs everything
npm run check:license        # the Apache / commercial boundary
```

Run both before you trust any of this. They are the evidence.

---

## Step 1 · Licence and build

`ee/` is **not** open source. Apache-2.0 does not apply to it. See
[`ee/LICENSE`](ee/LICENSE) before deploying it anywhere.

`ee/` is deliberately **not** an npm workspace, so a plain `npm install` never
pulls it in and cannot accidentally publish it.

```sh
npm run build:ee      # builds ee/ if present; a clean no-op if absent
npm run test:ee       # the enterprise suite
```

**Verify:**

```sh
ls ee/dist/policy/engine.js
npm run test:ee
npm run check:core-alone     # …and Core is STILL complete without it
```

If `ee/` is absent, `build:ee` and `test:ee` exit 0 and say so. That is the
Apache-only build, and it is a supported, tested configuration — not a
degradation.

---

## Step 2 · Subjects and clearance

A **subject** is who is asking. Enterprise derives one from your IdP's claims
rather than inventing its own user store.

```ts
import { subjectFromClaims, deriveClearance, explainClearance } from "./ee/dist/identity/subject.js";

const clearanceMap = {
  "sutra-readers":     "hosted_allowed",   // public only
  "sutra-staff":       "review_required",  // public + private
  // NOTE: there is no group that maps to local_only. See below.
};

const subject = subjectFromClaims(claims, clearanceMap);
const derived = deriveClearance(claims, clearanceMap);
console.log(explainClearance(subject, derived));
```

Three rules, and the third is the one people try to get around:

1. **A subject in several groups gets the LOWEST clearance**, not the highest.
   Set intersection, not union. Adding a group can never grant access.
2. **A subject in no known group gets the floor** — the least access, not a
   default of "staff".
3. **No group grants `secret`.** The secret floor is not delegable to an identity
   provider. Adding a group named `sutra-admins` and mapping it to `local_only`
   does not work; the mapping is rejected.

`explainClearance` exists because "why can this person not see that note?" is the
question you will actually be asked, and answering it from logs is miserable. It
returns the decision *and its reasoning*.

**Verify:**

```sh
npm run test:ee     # includes the full cross-product narrowing assertion
```

---

## Step 3 · A signed policy bundle

A policy bundle is your organisation's rules, versioned and signed, so a node can
verify what it is enforcing rather than trusting whatever file is on disk.

```ts
import { canonicalize, bundleDigest, validate } from "./ee/dist/policy/bundle.js";

const digest = bundleDigest(bundle);       // over the CANONICAL form
const result = validate(bundle, signature, publicKey);
if (!result.valid) throw new Error(result.reason);
```

`canonicalize` is the load-bearing piece. Two bundles that mean the same thing
must produce the same digest regardless of key order or whitespace — otherwise
signature verification fails for cosmetic reasons, somebody disables the check to
get work done, and you now have unsigned policy with a signing ceremony in front
of it.

**Deploy order matters:**

```sh
# 1 · validate BEFORE activating. Never the other way round.
node -e "require('./ee/dist/policy/bundle.js')" # then call validate()
# 2 · activate
# 3 · verify what the node believes it is enforcing
sutra doctor --json | jq '.policy'
```

An unverifiable bundle **fails closed**: the node falls back to Core's ceiling,
which is narrower, and says so loudly. It does not run on the last-known-good
bundle silently — a node quietly enforcing yesterday's policy is worse than one
that stops and tells you.

---

## Step 4 · The audit chain

Core's audit log is append-only. Enterprise's is **hash-linked**: each entry
carries the hash of the previous one, so removing or editing any entry breaks
every hash after it.

```ts
import { AuditChain, verifyChain, GENESIS } from "./ee/dist/audit/chain.js";

const chain = new AuditChain(path);
chain.append({ kind: "gate.withheld", subject: "alice@example.com", /* … */ });

const result = verifyChain(path);
if (!result.valid) {
  // Names the FIRST broken link — that is where to start looking.
  console.error(result.reason, "at entry", result.brokenAt);
}
```

**What is recorded:** counts, paths, subjects, purposes, surfaces, decisions,
retention class. **What is never recorded:** note content. An audit log that
quotes the material it is protecting is an exfiltration channel with good
intentions.

**Verify — and schedule this:**

```sh
node -e "
  const {verifyChain} = require('./ee/dist/audit/chain.js');
  console.log(verifyChain(process.env.SUTRA_AUDIT_CHAIN));
"
```

Verify the chain **on a schedule**, not only when you suspect something. A chain
nobody verifies is an append-only log with extra steps: tamper-evidence only
works if somebody looks.

### Retention classes

Every entry is classified for retention, because "keep all audit forever" and
"delete audit after 90 days" are both wrong and the difference is per-entry.
Rotate; do not delete. Provider and gate history is the ground truth you need
precisely when something has gone wrong.

---

## Step 5 · Key custody

```ts
import { EnvKeyProvider, posture, type KeyProvider } from "./ee/dist/keys/kms.js";

const provider: KeyProvider = new EnvKeyProvider();   // the default
console.log(posture(provider));   // states plainly what it does and does NOT give you
```

`EnvKeyProvider` reads keys from the environment. It is the default because it
works everywhere, and `posture()` **tells you its weaknesses rather than implying
it is sufficient**: no rotation, no per-use audit, no HSM boundary.

To use a real KMS, implement `KeyProvider` against AWS KMS, Azure Key Vault, GCP
KMS or an HSM. The interface is deliberately small.

**Verify:**

```sh
node -e "
  const {EnvKeyProvider, posture} = require('./ee/dist/keys/kms.js');
  console.log(JSON.stringify(posture(new EnvKeyProvider()), null, 2));
"
```

Read that output before you go to production. If it says you have no rotation and
no per-use audit, then you have no rotation and no per-use audit.

---

## Step 6 · External classifier composition

Bring your own DLP or classification service. Its verdict **composes** with
Sutra's — it does not replace it.

```ts
import { compose, type ClassifierAdapter } from "./ee/dist/classifier/external.js";

const result = compose(sutraVerdict, externalVerdict);
// STRICTEST WINS, always.
```

**Strictest wins, always.** `raiseOnly` is imported from Core rather than
reimplemented, so there is exactly one function in the system that can change a
tier, and it can only raise.

Consequences worth being explicit about:

- Your external classifier can make content **more** restricted. It can never make
  it less.
- If it is **unavailable**, composition degrades to Sutra's own verdict and records
  `degraded` — it does not fail open, and it does not pretend it ran.
- If it returns something **unparseable**, that is a `failed` classification, not a
  clean pass. Those two are different states and never share a counter.

---

## Step 7 · SBOM and dependency policy

```ts
import { generate, enforce, DEFAULT_POLICY } from "./ee/dist/supply/sbom.js";

const { sbom } = generate(root, packages);
const violations = enforce(sbom, DEFAULT_POLICY);
```

The default policy encodes the dependency counts as a **hard budget**:

| Package | Allowed runtime dependencies |
|---|---|
| `@sutra/aatma-core` | **1** |
| `@sutra/hermes-mcp` | **0** |

Zero for the MCP server is not an aspiration, it is the trust claim. The
component that decides what your AI can see is auditable by reading one file.
Adding a dependency to it is a policy violation that fails the build — and if you
genuinely need one, that is a decision to take deliberately and record, not a
number to bump.

```sh
npm run sbom
```

---

## Step 8 · Bring your own model, per team

Everything in [`ONBOARDING.md` Step 15b](ONBOARDING.md#step-15b--optional-bring-your-own-model)
applies. Enterprise adds one thing: the model choice can be **policy-bound**.

```sh
sutra provider add --id corp-gateway \
  --base-url https://llm.internal.example.com/v1 \
  --key-env CORP_GATEWAY_KEY --model gpt-4o --reasoning
sutra provider key corp-gateway
sutra provider test corp-gateway
```

The pattern that actually works in an organisation:

| Team | Ceiling | Model | Why |
|---|---|---|---|
| Everyone | `public` | corporate gateway | one contract, one bill, one audit trail |
| Named staff | `private` | **local only** | private content may not reach a hosted endpoint |
| Nobody | `secret` | none | the floor is absolute in both editions |

Two rules for a shared deployment:

- **Never put a shared API key in the vault or in a policy bundle.** Keys live in
  the environment or in your KMS. Sutra records the variable *name*; it has no
  field that can hold a key.
- **Give each surface its own key and its own ceiling**, both in that surface's MCP
  registration. A shared key across surfaces means one leak invalidates all of
  them, and one revocation breaks all of them.

---

## Step 9 · Deploy

See [`DEPLOYMENT.md`](DEPLOYMENT.md#topology-d--shared-team-deployment) for the
shared-node topology. The enterprise-specific checklist:

```sh
# ── Before ────────────────────────────────────────────────────────────
npm run verify                # everything, including the boundary checks
npm run check:core-alone      # Core is complete without ee/
npm run test:ee               # the cross-product narrowing assertion
npm run sbom                  # dependency budget

# ── Configure ─────────────────────────────────────────────────────────
#   1 · clearance map — LOWEST wins, no group grants secret
#   2 · policy bundle — validate BEFORE activating
#   3 · audit chain path — on durable storage, backed up
#   4 · key provider — read posture() and accept it knowingly
#   5 · per-surface ceilings — each in its own registration

# ── After ─────────────────────────────────────────────────────────────
sutra doctor --json           # every component, wired or not
sutra gate                    # the effective view, per ceiling
# verify the audit chain, and put that verification on a schedule
```

**Confirm the narrowing property on your own config**, not just in the abstract:
pick your most privileged subject and assert their effective ceiling is not above
Core's.

---

## Packaging and distribution

How to ship the two editions from one repository without them contaminating each
other.

### The boundary, restated as mechanics

| | Core | Enterprise |
|---|---|---|
| Paths | everything except `ee/` | `ee/` only |
| Licence | Apache-2.0 | commercial ([`ee/LICENSE`](ee/LICENSE)) |
| npm workspace | yes (`packages/*`) | **no — deliberately excluded** |
| Published to | a public registry | **never a public registry** |
| Build | `npm run build` | `npm run build:ee` |
| Tests | `npm test`, `npm run test:ps` | `npm run test:ee` |

`ee/` is not a workspace, so `npm install`, `npm pack` and `npm publish` at the
root cannot reach it. That is the primary containment mechanism, and it is
structural rather than procedural.

### Building the Core distribution

```sh
# 1 · Prove Core stands alone. THIS IS THE GATE, not a formality.
npm run check:core-alone

# 2 · Clean build
rm -rf packages/*/dist
npm ci
npm run build

# 3 · The full suite, including the boundary and leak checks
npm run verify

# 4 · Inspect what would actually ship — before publishing, not after
npm pack --dry-run --workspace packages/core
npm pack --dry-run --workspace packages/mcp
npm pack --dry-run --workspace packages/cli
```

**Read the `npm pack --dry-run` file list every time.** `.npmignore`, if one ever
appears, **replaces** `.gitignore` for packing rather than adding to it — so
gitignoring a file does not keep it out of a tarball. Sutra ships no `.npmignore`
for exactly this reason, and a test asserts none has appeared.

### Building the Enterprise distribution

```sh
npm run build:ee && npm run test:ee
npm run sbom > sbom.json
```

Distribute privately: a licensed tarball, a private registry, or a customer
repository. Three rules:

1. **Never publish `ee/` to a public registry.** There is no undo.
2. **Ship the licence with it.** `ee/LICENSE` travels in the artifact.
3. **Ship the SBOM with it.** Enterprise buyers ask; generate it as part of the
   release rather than on request.

### Release checklist

```sh
npm run verify              # build · test · test:ps · licence · no-bun ·
                            # leak-scan · diagrams · ee · core-alone
npm run leak-scan           # nothing personal or credential-shaped ships
npm run check:license       # SPDX headers; commercial id confined to ee/
npm run check:core-alone    # rm -rf ee/ still builds and passes
npm pack --dry-run -ws      # what actually ships
```

**Before the first public release, one owner-only task:** if any real credential
was ever committed to this repository's history, **rotate it**. Re-tiering,
deleting the line, or amending the commit is containment, not remedy — the
cleartext stays in git history and only rotation fixes it.

Full strategy, cadence, channels and launch copy: [`RELEASE.md`](RELEASE.md).

---

## Observability and audit review

Everything in [`ONBOARDING.md` § Observability](ONBOARDING.md#observability),
plus:

| What | Cadence | Command |
|---|---|---|
| Audit chain integrity | **daily, scheduled** | `verifyChain()` |
| Effective ceiling per subject | on every policy change | `explainClearance()` |
| Policy bundle digest matches what is deployed | on every deploy | `bundleDigest()` |
| Key posture | quarterly, and on any key change | `posture(provider)` |
| Dependency budget | every build | `npm run sbom` |
| Withheld counts by subject | weekly | audit chain query |

Two things to watch that are easy to miss:

- **A subject whose withheld count is suddenly zero.** That usually means their
  clearance widened, not that they stopped asking for things.
- **A gate refusal count that drops to zero across the board.** A gate that never
  refuses anything looks exactly like a gate that is not running. Core's own test
  suite applies the same rule to itself: a guardrail never seen to fail is not
  evidence of anything.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `build:ee` says nothing to do | `ee/` is absent | expected in the Apache-only build |
| Bundle signature invalid after a cosmetic edit | canonicalization | never hand-edit a signed bundle; re-sign it |
| A subject sees less than expected | lowest-clearance-wins across groups | `explainClearance()` gives the reasoning |
| A subject sees **more** than expected | **stop and read the audit chain** | this should be impossible; `npm run test:ee` asserts it |
| `check:core-alone` fails | something in Core imports from `ee/` | the boundary is broken; fix the import |
| External classifier unreachable | network or service | composition degrades to Sutra's verdict and records `degraded` |
| Audit chain broken at entry N | tampering, truncation, or a partial write | entry N is where to look; restore from backup and investigate |

---

## See also

| | |
|---|---|
| [`ONBOARDING.md`](ONBOARDING.md) | Core setup — do this first |
| [`DEPLOYMENT.md`](DEPLOYMENT.md) | topology, nodes, hosting, extension surfaces |
| [`RELEASE.md`](RELEASE.md) | release strategy, packaging, channels, launch copy |
| [`ee/LICENSE`](ee/LICENSE) | the commercial terms |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | the CLA |
