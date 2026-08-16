<!-- SPDX-License-Identifier: Apache-2.0 -->
# 06 · Mechanisms

> **Read this before touching any live surface.**
>
> The load-bearing machinery, and — the part that matters — **how each piece
> silently breaks**. Every entry: what it is → how it works → **how it fails
> quietly** → how to detect that → how to fix it → where the code is.

This section exists because the system Sutra was extracted from documented *what
existed* but not what *held it together*. Hidden mechanisms broke it repeatedly
because they were never surfaced: two routers with the same name, a quota cap, a
scheduler limit shorter than its job.

**A mechanism belongs here if it can fail without anything looking wrong.**

---

## M1 · The exposure ceiling

**What.** One value, read from `SUTRA_MCP_EXPOSURE` at MCP server startup,
deciding what any model can see.

**How it works.** `ceilingFromEnv()` resolves it once in `createDispatcher()`.
It is captured in a `Brain` whose `exposure` is `readonly`. No tool handler
receives it or can change it.

**How it breaks quietly.** A harness upgrade stops reading the config block that
registers the server. The tool list becomes **empty**. Nothing errors — the
assistant simply never mentions the vault again, and the user assumes they
phrased something badly. This happened upstream and *"the gated read path would
have been dead on the VPS unnoticed."*

The second way: a typo in the registration. `SUTRA_MCP_EXPOSURE=publik` is not a
tier, and a naive parser would fall back to a default.

**Detect.** `sutra doctor --harness <x>` — it speaks the protocol and asserts
**14 tools AND a ceiling**. File existence proves nothing.

**Fix.** Re-run `sutra wire <harness>`, then re-run doctor. **Run doctor after
every harness upgrade.**

**Where.** `packages/mcp/src/server.ts` · `packages/core/src/config.ts`
(`ceilingFromEnv` — an unrecognised value falls back to the *most restrictive*
reading, never the most permissive).

---

## M2 · The shared detection pattern set

**What.** `automation/policies/secret-patterns.json` — every secret-detection
rule, floor path and OCR engine, read by **four** consumers: the TypeScript
classifier, the PowerShell classifier, the commit hook, and the leak scan.

**How it works.** One file, content-hashed. Each binding compiles the same rules
and applies them in the same order.

**How it breaks quietly.** Two ways, both survived by every unit test:

1. **A binding adds a rule locally.** Now a rule exists on the paths written in
   one language and not the other. Upstream this reached *six re-implementations
   of one tier comparison across three languages*, and **every divergence failed
   open in at least one of them**.
2. **A rule stops matching.** A pattern that matches nothing looks *exactly*
   like a rule protecting a clean corpus. One upstream floor layer had never
   once fired in its entire life.

**Detect.** `Classify.test.ps1` asserts **parity** — both bindings classify an
identical corpus identically and hash the same file. `selfTestPatterns()`
asserts every rule matches its own declared fixture. `sutra doctor` runs both.

**Fix.** Add the rule to the **JSON**, never to a scanner. If you are about to
write a regex in a `.ts` or `.ps1` file, you are creating divergence.

**Where.** `automation/policies/secret-patterns.json` ·
`packages/core/src/gate/patterns.ts` · `automation/scripts/lib/Classify.ps1`

---

## M3 · The pattern-set hash, and re-scan (I15)

**What.** The content hash of the pattern set, stamped on the corpus at each
full scan.

**How it works.** `sutra rescan --apply` re-classifies every note under the
*active* rules and writes `state/checks/pattern-scan.json`. `rescanRequired()`
compares the stamp to the live hash.

**How it breaks quietly.** **This is the credential incident's own unfixed root
cause.** Content classified once, under an older pattern set, is never
re-examined — so improving the list changes *nothing retroactively*. Thirteen
source documents sat at hosted-egress tier with plaintext credentials in them,
and every one was surfaced by an agent happening to read the extracts, not by
any scan.

A scanner is only as good as its list. The list **will** be incomplete. Ship the
re-scan trigger, not just a longer list.

**Detect.** `sutra doctor` → "A FULL RE-SCAN IS DUE (I15)", naming both hashes.

**Fix.** `sutra rescan` to preview, `sutra rescan --apply` to write. Raise-only,
always.

**And then:** re-tiering is **containment, not remedy**. If a real credential
was found, the cleartext is still in git history. **Only rotation fixes it, and
that is owner-only work.**

---

## M4 · Resource locks

**What.** Named, rank-ordered, per-resource locks in `.sutra/locks/`.

**How it works.** Acquired in **ascending rank**, all-or-nothing. Descending
acquisition **throws**, which makes circular wait impossible by construction. A
loser **skips and exits 0**.

**How it breaks quietly.** Two jobs write one derived artifact and corrupt it.
The OS scheduler's "don't run twice" setting guards a task against *itself*,
never against another task. Upstream, three jobs wrote one graph export with
nothing between them — and the overlap only became *guaranteed* once the daily
run got slower, so the defect was latent for as long as jobs happened to finish
early.

Corruption of a derived JSON then looks like a rebuild bug, not a concurrency
bug, and gets debugged in the wrong place.

**Detect.** Look for a derived artifact that shrank without an explanation, or
two `logs/runs.ndjson` entries overlapping in time on the same host.

**Fix.** Ranked locks, already in place. If you add a resource, give it a rank
in `RESOURCE_RANK` — an unranked lock cannot participate in the deadlock proof.

**Gotchas.** Lock files are **per-machine** and gitignored: committed, they
arrive on another host as un-reclaimable foreign locks. A dead **same-host** pid
is reclaimed; a **foreign-host** lock never is, because pid 4242 exists on
almost every machine.

**Where.** `packages/core/src/run/lock.ts` · `automation/scripts/lib/RunLock.ps1`

---

## M5 · Run outcomes

**What.** Five outcomes — `ok` / `degraded` / `failed` / `skipped-no-input` /
`skipped-policy` — plus `no-op`, and a **three-valued** `did_work`.

**How it works.** Each stage reports its own; `summarise()` rolls them up
without collapsing the distinctions.

**How it breaks quietly.** **This is the most important entry in this file.**

Upstream, an LLM failure was caught with `catch { return $null }`, counted by the
caller as a *skip*, printed as `"N promoted, N skipped (pending/no-extract)"`,
and exited **0**.

It hid perfectly: the message named a benign cause, the exit code was green, and
the run manifest said `ok`. **That one sentence let a 26-day outage look like a
quiet week.**

**Detect.** `sutra logs` — a run reporting `no-op` while input existed, or
`degraded`. `staleRunAlert()` distinguishes three separate alarms: never
started, **started and never ended**, and completed-but-produced-nothing.

**Fix.** Never share a counter between outcomes. If a stage cannot measure its
own output, report `did_work: null` — *not measurable* — rather than `false`.
An observability fix that generates false alarms gets muted, and a muted alert
is worse than no alert.

**Where.** `packages/core/src/run/outcome.ts` ·
`automation/scripts/orchestrator/daily.ps1`

---

## M6 · The scheduler, and its time limit

**What.** One OS scheduler object per cadence.

**How it breaks quietly.** **Two ways, and both are silent.**

1. **A time limit shorter than the job.** Upstream, the daily pass had a 2-hour
   limit while two of its stages alone took ~1.6h. The OS killed it **every
   night for 26 days**, and everything downstream never ran. The evidence was a
   **103-byte log file** — a START line and no STOP. A killed process writes no
   failure record, so the only signal was an *absence*, and nothing was watching
   for absences.

2. **Two schedulers, one job.** Registered in both a harness cron and the OS
   scheduler, a job double-runs. See M4 for what that does.

**Detect.** `sutra doctor` compares each job's duration against its limit.
`staleRunAlert()` fires **loudly** on a run marker with `ended_at: null` — a run
that started and never ended is the loudest possible signal.

**Fix.** Derive the limit from *measured* runtime with headroom. Use
`sutra schedule list` to see what is registered where, and **one scheduler per
cadence**.

**Where.** `packages/cli/src/commands/wire.ts` (`cmdSchedule`) ·
`packages/core/src/run/outcome.ts` (`staleRunAlert`)

---

## M7 · The two routers

**What.** There are **two** independent model routers in any Sutra deployment,
and they are not the same router.

| | What it serves | Config |
|---|---|---|
| **`sutra route`** | the **pipeline's** synthesis — what writes durable pages | `automation/policies/provider-router.json` |
| **the harness's own** | **chat**. Sutra does not read, write or own it. | your harness's config |

**How it breaks quietly.** Both are "the router". Diagnosis of a bad answer
lands on whichever one the reader had in mind, and the fix is applied there —
changing nothing. Upstream they had **different provider orders**, so the two
disagreed about which model served what, indefinitely.

**Detect.** Every generated page records `synthesis_provider:` in its
frontmatter, written **only when a model actually answered** — so its *absence*
is itself the signal. `sutra doctor` shows both chains side by side.

**Fix.** Name them distinctly, always. Never edit a harness config from Sutra
(see M8).

**Where.** `automation/scripts/provider/router.ps1` ·
`automation/policies/provider-router.json`

---

## M8 · Harness config, and why we only ever add one key

**What.** `sutra wire` registers the MCP server with a harness.

**How it works.** For Claude Code (JSON) it **deep-merges** exactly one key —
`mcpServers.sutra` — and backs the file up first. For Hermes (YAML) and Codex
(TOML) it **prints** the block instead of writing it.

**How it breaks quietly.** A tool that round-trips someone's config through a
parser reorders keys, changes quoting and collapses blank lines. The user's
config still *works*, so nothing errors — they simply find their file rewritten,
and stop trusting the tool. Upstream, one config applier survived every apply
**only because its template contained no `model:` key**.

**Fix.** Touch only your own keys. Ever. Refusing to rewrite a file we cannot
round-trip losslessly is correct behaviour, not a limitation.

**Where.** `packages/cli/src/commands/wire.ts`

---

## M9 · Derived-artifact headers

**What.** `meta.node_count`, `meta.edge_count`, `meta.community_count` on the
graph export; `note_count` on the embedding index.

**How it breaks quietly.** An enrichment pass adds edges and updates only its
own meta keys, leaving the counters at their pre-enrich values. Measured on the
upstream export: header **16,291** vs `edges[]` **29,286** — 44% low.

Both numbers are individually plausible, **and the cheap reader is the one that
is wrong**: the metrics counter deliberately does a 2 KB head read (130 ms vs
1,251 ms for a full parse), so the fix that finally made the graph observable
inherited a lying header. That is the worst possible arrangement — the cheap
read wrong and the expensive read right.

**Detect.** `verifyHeader()`, run by `sutra doctor` and in CI on every derived
JSON. `graph-export.ps1` re-reads its own output and asserts before returning.

**Fix.** Compute every counter **at write time** from the collection it
summarises. Never copy one forward.

**Where.** `packages/core/src/retrieval/graph.ts` ·
`automation/scripts/graph-export.ps1`

---

## M10 · The anti-regression guard

**What.** A refusal to replace a large derived artifact with a drastically
smaller one.

**How it breaks quietly.** **The guard working is what hides the problem.**

Upstream, a caller pointed the graph builder at a directory that **did not
exist**, so every run rebuilt from nothing. The guard correctly rejected the
empty result — **every night, silently**. The knowledge graph froze for a week
with a 2-byte state file, and nothing complained, because a guard that fires
constantly and says nothing is indistinguishable from a healthy system.

**Detect.** The guard now **counts and reports** its activations. A guard firing
every run is an *alert*.

**Fix.** The guard lives **inside the builder**, not in the caller — the
upstream version lived only in the caller, which is exactly how the earlier
total loss happened. A resolved input path that does not exist is a **startup
assertion**, not a zero-result run.

**Where.** `automation/scripts/graph-export.ps1` ·
`packages/core/src/retrieval/graph.ts` (`antiRegressionCheck`)

---

## M11 · Builder inputs must be tracked (I19)

**What.** Every directory a builder reads must be inside the repo and **not**
gitignored.

**How it breaks quietly.** **Nothing is broken, so nothing complains.**

Upstream, the knowledge graph was a pure function of a batch store that
`.gitignore` excluded. The graph's output `kg.json` *was* committed — so the
graph looked safely version-controlled while **its inputs existed on exactly one
laptop**, untracked and unbacked-up, on a machine scheduled for retirement.

Losing that disk would not have degraded the graph. It would have made it
**unreproducible, permanently.**

The general rule: **if an artifact is a pure function of an input, the input is
the thing you must not lose.** Committing only the output is a backup illusion.

**Detect.** `sutra doctor` runs `git check-ignore` on every resolved input path.

**Fix.** Move the store inside the repo and remove the ignore rule. Tier safety
comes from the export allow-list, **not** from gitignore.

**Where.** `packages/cli/src/commands/doctor.ts` · `.gitignore` (which carries
this warning in its own header)

---

## M12 · The commit hook

**What.** A tracked pre-commit secret scanner, installed via `core.hooksPath`.

**How it breaks quietly.** **It does not hide. It gets routed around, which is
worse.**

Upstream the hook lived **untracked** in `.git/hooks/`, so enforcement **did not
survive a clone** — every fresh checkout had no scanning while everyone believed
it did. It also spawned one `grep` per staged file at ~1.05 s each, meaning ten
minutes on a large commit. The result was `--no-verify` as standing policy:
**128 occurrences across 91 files**.

The repo kept the *belief* that its commits were scanned while every large
commit skipped the scan.

**Detect.** `git config core.hooksPath` should be `.githooks`. `sutra doctor`
checks it.

**Fix.** Three properties, in order of importance: **fails closed** (missing
`pwsh` or scanner refuses the commit), **fast** (sub-second regardless of file
count — measured 0.65–1.1 s), and **only `definite` rules block**. A fuzzy rule
that blocks a commit is how a hook earns a `--no-verify` habit it never recovers
from.

**Where.** `.githooks/pre-commit` ·
`automation/scripts/governance/Invoke-SecretScan.ps1`

---

## M13 · OCR, and where credentials actually arrive

**What.** An extract produced by an OCR engine is floored to `secret`,
regardless of how benign its text looks.

**How it breaks quietly.** **Every one of the worst upstream credential cases
entered the vault as an IMAGE OF TEXT** — a PDF or an export run through
Tesseract. As an image, no human ever read it; the extracted text was indexed as
ordinary prose and tiered as safe.

OCR is also where content arrives **corrupt**: one live page was fabricated
wholesale from an extract whose embedded font shifted every glyph 31 code
points, **silently deleting every digit in the document**. The resulting page
was fluent and wrong.

**Detect.** The `extract_engine` frontmatter key. If it names an OCR engine and
the tier is not `secret`, the classifier is not being consulted.

**Fix.** Record the engine on the extract and feed it to the classifier. OCR
output is never eligible for a hosted route on an ingest-time tier alone.

**Where.** `automation/policies/secret-patterns.json` (`ocr_engines`) ·
`packages/core/src/gate/patterns.ts`

---

## M14 · Ignore files are egress surfaces

**What.** `.gitignore`, `.npmignore`, `.dockerignore`, `.vercelignore`,
`.easignore` — each is a **separate** ruleset for a **different** tool.

**How it breaks quietly.** `.easignore`, when present, **supersedes**
`.gitignore` entirely for that uploader. Upstream it excluded three directories
but not five credential files — so **every build uploaded all five**.

Gitignoring the files felt like protection, and it was — *for git*. The
supersession is documented by the tool, not by the repo, and no test ever asked
"what does the **uploader** see?"

**Detect.** `npm run leak-scan` warns whenever a second ignore file appears, and
classifies each finding by whether that file actually ships.

**Fix.** Answer the question **empirically** — replay the ruleset through the
tool's own engine rather than reasoning about it. Adding an ignore file means
adding a case to the leak scan.

**Where.** `scripts/leak-scan.mjs`

---

## M15 · The keyless path

**What.** With no model configured, `sutra ask` returns a cited context block.

**How it breaks quietly.** It doesn't break — **it gets mistaken for a failure
and "fixed".** Someone sees no `answer` field, assumes the feature is broken,
and adds a fallback that fabricates prose. At that point the product's central
property is gone and nothing reports it.

**Detect.** `synthesis_mode: deterministic` in the response, and a `degraded[]`
note naming what a model would add.

**Fix.** Understand that this is the **floor**, not the fallback. Every claim in
a deterministic answer is traceable by construction; a synthesised paragraph can
only approximate that. The context block is returned **even when a model did
run**.

**Where.** `packages/core/src/retrieval/ask.ts`

---

## Adding to this file

A mechanism belongs here if **it can fail without anything looking wrong.**

If it fails loudly, it belongs in the component docs. If it fails silently, it
belongs here, and the entry is not complete without the **"how it breaks
quietly"** and **"detect"** lines — those are the two nobody writes and the two
everyone needs.
