<!-- SPDX-License-Identifier: Apache-2.0 -->
# Planted secrets — a fixture

> **Nothing here is real.** Every value below is a synthetic string with the
> *shape* of a credential and none of the substance. They exist so the detection
> rules can be tested against what they claim to match.

This file is named in `automation/policies/secret-patterns.json` under
`scanner_exempt_paths`, so the scanners do not flag it. That exemption is
narrow and deliberate: this file's **purpose** is to contain what the rules
match, and a scanner that flagged its own fixtures would be a scanner people
disable.

## Why a fixture file exists at all

D4. One of the three secret-floor layers in the upstream system had **never once
fired** — it was present, plausible, referenced in the docs, and matched nothing
at all. Nothing counted rule hits, so a rule that fires zero times looked exactly
like a rule protecting a clean corpus.

The remedy is **positive coverage**: every rule ships with something it must
match, asserted in CI. Most of that lives in the pattern set itself, as each
rule's `fixture` field. This file is the corpus-level version — a single
document a scanner can be pointed at end to end.

## The planted shapes

Every one of these is `EXAMPLEONLY`-marked and matches no real account.

```
openai-project      sk-proj-EXAMPLEONLYnotarealkey000000000000
anthropic           sk-ant-EXAMPLEONLYnotarealkey000000000000
openai-legacy       sk-EXAMPLEONLYnotarealkey00000000000000000
openrouter          sk-or-v1-EXAMPLEONLYnotarealkey0000000000
nvidia              nvapi-EXAMPLEONLYnotarealkey000000000000
groq                gsk_EXAMPLEONLYnotarealkey0000000000000
google              AIzaEXAMPLEONLYnotarealkey00000000000000
huggingface         hf_EXAMPLEONLYnotarealkey000000000000000
github-pat          github_pat_EXAMPLEONLYnotarealkey0000000000
github-classic      ghp_EXAMPLEONLYnotarealkey00000000000000
slack               xoxb-EXAMPLE-0000000000-notarealkey
telegram            1234567890:AAEXAMPLEONLYnotarealkey0000000000
age                 AGE-SECRET-KEY-1EXAMPLEONLYNOTAREALKEY000000000000000000000000000000
aws                 AKIAEXAMPLEONLY00000
pem                 -----BEGIN RSA PRIVATE KEY-----
```

## The benign strings that must NOT match

These are the false-positive candidates. A `definite` rule matching any of them
is a bug, because a scanner that cries wolf earns a `--no-verify` habit it never
recovers from — the upstream repo accumulated 128 of those across 91 files.

```
sk-learning-and-development-notes
sk-2026-planning
my api_key is stored in the vault, not here
AIza is the prefix Google uses
ghp_ tokens are the classic shape
-----BEGIN CERTIFICATE-----
Bearer token authentication is described in RFC 6750
postgresql://localhost:5432/dev
```

## The heuristic case

`password = dbutler_prod_9x2Kq` is structurally identical to
`password = db_password` — a real secret and a variable reference, and **no
regex separates them**.

So that rule is banded `heuristic`: it **raises the tier** (safe when wrong) and
**never blocks a commit** (costly when wrong). An attempt to tighten it upstream
was written and then reverted, because the tightened version stopped flooring an
identifier-shaped literal password — trading a harmless false positive for a
harmful false negative.
