<!-- SPDX-License-Identifier: Apache-2.0 -->
# Security

## Reporting a vulnerability

**Do not open a public issue for a vulnerability in the gate.**

Email the maintainer, or use GitHub's private vulnerability reporting on this
repository. Include what you did, what you expected, and what happened. A
proof-of-concept is welcome and is never required.

You will get an acknowledgement. If the finding is real you will be credited
unless you would rather not be.

## What counts as a vulnerability here

Sutra makes one security claim, and it is narrow:

> `secret`-tier content and anything marked `do_not_learn` never reaches any
> LLM — hosted or local-via-a-harness — and the model cannot lift the ceiling
> it was given.

**Anything that breaks that sentence is a vulnerability.** Concretely:

- Any path by which `local_only` content reaches a model surface.
- Any way for a tool call, a prompt, or a crafted note to raise the exposure
  ceiling the server was started with.
- Any way to lower a tier — invariant 4 says sensitivity is raise-only.
- `do_not_learn` content appearing anywhere a model can read.
- The agent write path producing anything other than a floored inbox capture.
- A `heuristic`-banded detection rule blocking a commit, or a `definite` rule
  that cannot match its own declared shape.

## What is NOT a vulnerability

Stated plainly, because a report is expensive for both of us:

**A withheld read leaves a queued exposure request.** That is deliberate. The
request records the note's *path* and the requesting surface, never its content,
so a refusal is reviewable rather than mysterious.

**The gate reports COUNTS of withheld notes.** `sutra gate` tells you 37 notes
are secret. That is the product working — an honest refusal has to be legible,
or nobody can tell it apart from a broken search.

**`sutra reveal` renders secret content.** It is per-item, single-use,
passphrase-gated, audited on success *and* failure, refuses outright under
`SUTRA_HOSTED=1`, and is reachable only from an interactive terminal. It is the
break-glass, and it is the user's own screen.

**The CLI runs at the `secret` ceiling on a local terminal.** You reading your
own notes is not an egress. Under `SUTRA_HOSTED=1` it drops to the gateway's
ceiling.

**A `heuristic` rule missing a real secret.** By design: heuristics raise a tier,
never block. A fuzzy rule that blocks commits is how a hook earns a
`--no-verify` habit, and then it protects nothing. See D24.

## The threat model, honestly

**In scope:** a model or a harness that tries to read above its ceiling; a
crafted note attempting to influence classification or prompt assembly; a
misconfigured registration; a plaintext credential entering the vault through
ingest, including via OCR.

**Out of scope:** an attacker with write access to your vault or your Sutra
install. At that point they can edit the tier on any note. Sutra is a governance
layer over files you control, not a sandbox against someone who controls those
files.

**Also out of scope:** the model provider itself. If you register at a `public`
ceiling, your public notes go to that provider. Sutra decides *what* leaves, not
what happens after.

### One claim we will not make

**"Pushing to your private git remote is not an egress."** That is defensible
threat-modelling and it is **false as a GDPR statement**. Your vault leaving
your machine is a data transfer, whoever hosts the remote.

## The four enforcement points

The secret floor is enforced at four independent points, and they are
deliberately redundant — **each has failed independently** in the system Sutra
was extracted from, and the other three held:

1. **Classification at ingest** — content is tiered before anything downstream
   can read it.
2. **`Brain.visible()`** — every read path walks the corpus through it, and
   `local_only` is never lifted by a promotion.
3. **`sensitivityGuard()`** — the rank comparison, ~120 lines, no dependencies.
4. **The MCP per-tool ceiling** — read from the environment at startup, never
   accepted as an argument.

If you are auditing Sutra, `packages/core/src/gate/` is the whole review: about
600 lines, one runtime dependency, and the MCP server has none.

## Credential rotation

If a real credential ever reaches a vault, **re-tiering is containment, not
remedy**. The cleartext stays in git history. Only rotating it at the provider
fixes it, and no tool can do that for you.

`sutra rescan` will find and re-tier it. It will also tell you this.
