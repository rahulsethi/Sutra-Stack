<!-- SPDX-License-Identifier: Apache-2.0 -->
> **Shipped as a product document, deliberately.**
>
> This is the post-mortem of the live system Sutra was extracted from. It is here
> because a project that hides its own failures teaches nothing, and because
> **every design decision in this repository cites one of these entries**. If you
> want to know why a piece of Sutra is shaped the way it is, the answer is
> usually a numbered defect below.
>
> A defect is "not inherited" only when its named test **exists, fails against a
> deliberately planted instance, and passes against the product**. The current
> state of that work — 17 of 39 covered — is in
> [`Master_documentation/10-implementation/`](Master_documentation/10-implementation/README.md).
>
> Citations to the original analysis (the issues register, the credential
> incident report, the research set) are rendered as plain text: those documents
> are private and are not shipped, and a link to something that does not exist is
> worse than a citation without one.

# Inherited defects — what Sutra Core must **not** ship

> **What this is.** Every defect the 2026-08-14/15 audit found in the live system, stated as a thing the
> redistributable product must not inherit. Sutra Core is an *extraction* of that system
> (`SYNTHESIS.md` V2), so by default it inherits every one of these — including the ones
> that had been shipping unnoticed for the life of the repo.
>
> **How to use it.** This is the **test manifest** for M7 and gate item 6 of
> `ROADMAP.md`. Each entry ends in a named test. A defect is "not inherited" when that
> test exists, fails against a deliberately planted instance, and passes against the product.
>
> **Sourcing.** Every claim traces to the
> issues register, the
> credential incident report, or
> `research/20-fixes-applied.md` — cited inline as *(register S3)*,
> *(incident 5)*, *(report 20 §Router)*. Five entries (D24, D25 and D36–D38) landed after the register
> was frozen and cite the code instead; D38 is also written up as §8 of the register. Nothing here is
> restated from those documents at length; go there for the measurements.
>
> **"Fixed in live" ≠ "absent from Core."** Most of these were fixed by patching the running system.
> Sutra Core is a different codebase; a patch is not a guarantee. Only the test is.

---

## Index

| # | Defect | Class | Live status | Absence test |
|---|---|---|---|---|
| **D1** | 6,000-character input clip in a synthesis path | correctness | routed around, clip still in the script | `synth/no-input-clip` |
| **D2** | Idempotency blocks repair (no `-Force`, 4 guards) | recoverability | fixed | `synth/repair-reaches-corpus` |
| **D3** | Missing `extract:` stamp class — 697 sources dropped | pipeline | fixed + applied | `pipeline/stamp-reconcile` |
| **D4** | Dead path-floor band in the classifier | security | fixed | `gate/path-floor` |
| **D5** | `sk-` cannot match `sk-proj-` / `sk-ant-` | security | fixed | `gate/key-shapes` |
| **D6** | Per-file `grep` hook → 128 `--no-verify` | security | fixed | `hook/speed-and-survival` |
| **D7** | `.easignore` supersedes `.gitignore` | security | fixed | `leak/ignore-supersession` |
| **D8** | Two routers, one confusion | operability | documented only | `doctor/router-identity` |
| **D9** | Scheduler overlap with no lock | integrity | fixed | `sched/resource-lock` |
| **D10** | Task time limit shorter than the job | availability | config fix pending | `sched/limit-exceeds-runtime` |
| **D11** | LLM failures counted as skips, exit 0 | observability | fixed | `run/failure-is-not-skip` |
| **D12** | No time series for anything | observability | fixed | `metrics/series-exists` |
| **D13** | Enrichment does not update the artifact header | integrity | **open** | `artifact/header-matches-body` |
| **D14** | Classify-once + OCR-ingested credentials | **security, root cause** | **open** | `gate/rescan-on-pattern-change` |
| **D15** | Anti-empty-stub guard defeated by own cross-links | quality | fixed | `synth/guard-not-self-defeating` |
| **D16** | Unconfigured provider silently dropped; `openai` aliased to Groq | availability | fixed / config | `route/unconfigured-is-loud` |
| **D17** | Quality-floor fallback re-admits the excluded provider | quality | fixed | `route/floor-cannot-be-reentered` |
| **D18** | KG rebuilt from a non-existent dir; 0-entity overwrite | data loss | fixed | `graph/anti-regression` |
| **D19** | `.Value` on `$null` killed every dispatch, misfiled as provider failure | attribution | fixed | `route/parse-error-attribution` |
| **D20** | Tier rename turned the repair script into a no-op | quality | routed around | `vocab/rename-safety` |
| **D21** | Freshness rubric measures "an LLM ran" | quality | **open** | `quality/capture-ratio-band` |
| **D22** | Review queue is 97 % machine artifacts | usability | fixed downstream | `queue/decision-bearing` |
| **D23** | Pending reason conflates two causes | recoverability | **open** | `extract/reason-enum` |
| **D24** | A fuzzy rule blocking a commit | security UX | fixed | `hook/banding` |
| **D25** | Submodule reconcile on a node that runs its own pipeline | **data loss** | fixed | `vault/reconcile-is-safe` |
| **D36** | The KG's only input store was gitignored — unreproducible off one disk | **data loss** | fixed | `graph/store-is-tracked` |
| **D37** | The merge drops the extractor provenance stamp | provenance | fixed | `graph/provenance-survives-merge` |
| **D38** | Third-party-identifiable content sits at hosted-egress tier | governance | **open (owner decision)** | `tier/named-third-party` |
| **D39** | Merge resolved conflicting facts by filename order | correctness | fixed | `merge/order-independent` |

Plus a table of idiom-level traps at the end — small, each one a real outage or a near miss.

---

## D1 · A 6,000-character input clip in a synthesis path

**What it was.** `scripts/backfill-synthesis.ps1:35` truncated every source to 6,000 characters before
sending it to the model. That script — unscheduled, in the parent repo, run **once by hand** — produced
**424 of the 595 pages** in the corpus. 160 had sources larger than the clip; the median page saw
**38 %** of its material, p25 saw 19 %, the worst **1.2 %** (register §0A, report 16 §4a).

**How it hid.** It does not produce *short* pages. It produces confident, fluent, correctly-formatted
400-word pages that are wrong in specifics — and page length is flat at ~406–470 words across two
orders of magnitude of source size, so nothing in the corpus looked anomalous. The freshness rubric
scored 164 of them "healthy" (D21). Documented damage, corrected only by re-synthesis over the full
source: a **twelve-week** plan described throughout as "an eight-week period"; an amplifier page
asserting one 12-inch speaker across a line whose real matrix is 12"×1 / 12"×2 / 5"×1; and a page
fabricated wholesale from an OCR extract (D14).

**Sutra Core must.** Have **no input clip anywhere in a synthesis path**. If a source exceeds the
provider's window, chunk-and-merge or refuse — never silently prefix. Record `source_chars_seen` and
`source_chars_total` on every generated page, so truncation is a *fact on the artifact*, not an
inference. And no producer of durable content may be an unscheduled hand-run script (see D28 in the
idiom table: "created ≠ wired" has a twin, "run ≠ scheduled").

**Test — `synth/no-input-clip`.** Synthesise from a 50,000-char fixture. Assert the synth function
received the whole body (the live fix does exactly this: report 20 test R13 asserts
`extract.Length` chars arrived), that `source_chars_seen == source_chars_total`, and grep the tree for
`Substring(0,` / `-Head` applied to an extract body.

---

## D2 · Idempotency blocks the repair it should enable

**What it was.** `auto-compile.ps1` had no `-Force` and four sequential skip guards, each alone
sufficient to skip the whole corpus — including a `compiled-hashes.json` check and a hard
`status: draft` requirement that blocked **583 of 595 pages**. With perfect keys, a clean run
re-synthesised **0** existing pages (report 16 §4b).

**How it hid.** Idempotency is a virtue, so nobody read it as a defect. The failure only surfaces when
you try to *repair*: "fix the keys and re-run" is the obvious remedy and it does nothing at all.

**Sutra Core must.** Separate "don't redo work" from "never redo work". A repair mode that bypasses
freshness guards **inside its own explicit selection only**, never for normal runs, with the tier rules
structurally unreachable rather than re-checked, and refuse-don't-stub so a repair can only improve a
page (report 20 §Auto-compile 2). Repair must also be **scheduled** — the live fix is still not wired
into `daily.ps1`, so I5 remains open.

**Test — `synth/repair-reaches-corpus`.** Plant a degraded page whose source is rich; run the normal
pipeline (asserts: not selected); run repair (asserts: selected, rewritten, `local_only` never routed
hosted under an adversarial synth function, a failed re-synthesis leaves the file **byte-identical**).

---

## D3 · A missing frontmatter key hid 697 already-extracted sources

**What it was.** `auto-compile.ps1:296` skips any manifest without an `extract:` key. **661 manifests
had a finished extract on disk and no key** (a retired `text-passthrough` extractor never wrote one),
plus 36 marked `pending` although the extract existed — 2.3× the entire compiled corpus, invisible
(report 16 §6a, register P9).

**How it hid.** The stamp was treated as ground truth and was unreliable in **both** directions. Every
count in the system measured manifests-with-a-stamp, so the dropped population did not appear as a
backlog anywhere — it simply did not exist.

**Sutra Core must.** Never let a derived flag be the sole authority on a fact the filesystem already
knows. Reconcile stamps against what is on disk as a routine `doctor` check, and make the stamper
**key-scoped** — rewrite only its own keys and verify every other key and the whole body byte-identical
before writing (the live re-implementation exists precisely because the shared helper re-serialised
whole files and had already dirtied 660 manifests).

**Test — `pipeline/stamp-reconcile`.** Fixture with an extract on disk and no stamp: `doctor` reports
it, `--apply` stamps it, the manifest differs by exactly the `extract*` lines, and the next compile
picks it up. *Live status: applied — the vault now shows 229 manifests with no `extract:` key (exactly
report 16's "no key and no extract file" bucket) and 283 pending, down from 319. Both the register
(`IN PROGRESS`) and report 20 (`-Apply has not been run`) are stale on this point.*

---

## D4 · The path-based floor band was dead code

**What it was.** `Classify.ps1`'s `_FloorPathPrefixes` matched `identity/accounts` and friends with
`StartsWith` against a **PARA-numbered** vault (`11-identity/…`). No real path could ever match, so one
of the three secret-floor layers had never once fired (register S3c).

**How it hid.** It is present, plausible, and referenced in the docs. Nothing counts how often a rule
fires, so a rule that fires zero times looks exactly like a rule protecting a clean corpus.

**Sutra Core must.** Assert *positive* coverage on every guard — each floor rule ships with a fixture
that it must match — and count rule hits so a permanently-cold rule is visible.

**Test — `gate/path-floor`.** 8 paths that must floor and 4 ordinary paths that must not (the shape the
live fix was verified with). Add a "no rule has zero lifetime hits" report to `doctor`.

---

## D5 · `sk-[A-Za-z0-9]{20,}` cannot match `sk-proj-` or `sk-ant-`

**What it was.** The hyphen ends the character run after three characters, so the flagship OpenAI and
Anthropic key shapes were structurally unmatchable — and there was **no rule at all** for `nvapi-`,
`gsk_`, `AIza`, `sk-or-v1-`, `github_pat_`, `hf_`, Telegram tokens or `AGE-SECRET-KEY-1`
(register S3a/b, incident §"Why it stayed invisible").

**How it hid.** The pattern *looks* right, and it does match legacy `sk-` keys, so tests written from
the same mental model passed. The list was never adversarially probed against the providers actually
in use.

**Sutra Core must.** Derive the pattern list from the provider registry the product ships — if a
provider is configurable, its key shape is in the scanner — and probe it with a real key shape per
provider plus benign look-alikes.

**Test — `gate/key-shapes`.** 13 planted shapes must classify `secret`; 8 benign strings must not
(including `sk-learning-and-development-notes`, a real false-positive candidate from this corpus).

---

## D6 · A commit hook that was untracked, slow, and therefore bypassed

**What it was.** The secret-scanning pre-commit hook lived **untracked** in `dimaag/.git/hooks/`; the
parent repo had none; `core.hooksPath` was unset in both — so **enforcement did not survive a clone**.
It also spawned one `grep` per staged file at ~1.05 s each, meaning 10+ minutes on a 748-file commit.
Result: `--no-verify` as standing policy — **128 occurrences across 91 files** (register S5).

**How it hid.** It did not hide. It was known and worked around, which is worse: the repo kept the
*belief* that commits were scanned while every large commit skipped the scan.

**Sutra Core must.** Ship hooks as tracked files installed via `core.hooksPath`, with one interpreter
spawn and one `git diff --cached`; fail **closed** if the interpreter or scanner is missing; and take
the file list from `--name-only -z` so **binary files are included** (a path list scraped from diff text
skips every `.wav`, which would have made the raw-audio guard unable to ever fire — register S6).
Budget: sub-second regardless of file count (live: 0.65 s).

**Test — `hook/speed-and-survival`.** Clean clone → plant a key → commit is rejected **without**
`--no-verify`; 1,000-file commit completes under 1 s; scanner removed → commit refuses rather than
passes; a staged `.wav` is seen.

---

## D7 · `.easignore` silently superseded `.gitignore`

**What it was.** When `.easignore` exists, EAS uses it *instead of* `.gitignore`. It excluded
`/dimaag/`, `/docs/`, `/scripts/` but not `Keys.md`, `SUTRA-MASTER-CONFIG.local.md`,
`parvo-app/CONFIG.local.md` or `parvo-app/config.*.local.json` — so **every APK build uploaded all
five** to Expo (register S1).

**How it hid.** Gitignoring the files felt like protection, and it was — for git. The supersession is
documented in EAS, not in this repo, and no test ever asked "what does the *uploader* see?".

**Sutra Core must.** Treat every ignore-like file (`.easignore`, `.npmignore`, `.dockerignore`,
`.vercelignore`) as a **separate egress surface** with its own leak test, and answer the question
empirically — replay the ruleset through the tool's own engine rather than reasoning about it.

**Test — `leak/ignore-supersession`.** For each ignore file present, build the effective file set and
assert no secret-shaped path survives (live method: replay through git's ignore engine in an isolated
repo — 21 secret-shaped paths excluded, 8 app paths still included, 0 failures).

---

## D8 · Two routers, one confusion

**What it was.** Two independent model routers — the pipeline synthesis router
(`provider-router.json` / `router.ps1`) and the harness gateway (`model:` / `fallback_providers:`) —
with different provider orders. Editing one fixes nothing in the other
(`00-MASTER-BUILD-BRIEF.md` §9.3).

**How it hid.** Both are "the router". Diagnosis of a bad answer would land on whichever one the reader
had in mind, and the fix would be applied there.

**Sutra Core must.** Name them distinctly, print **which router and which provider/model** served every
generated artifact (the live fix added `synthesis_provider:` / `synthesis_model:` frontmatter — written
only when a model actually answered, so their absence is itself the signal), and have `doctor` display
both chains side by side.

**Test — `doctor/router-identity`.** Misconfigure router A only; assert `doctor` shows A degraded and B
healthy, and that a generated page names the router that produced it.

---

## D9 · Four jobs writing one artifact, with no lock

**What it was.** `Sutra Daily` (02:00, now hours long), `Refresh Graphs` (05:00) and `Index Refresh`
(every 3 h) all write `cytoscape.json`, the embed index and `kg.json`. Only the VPS pipeline had a
lock. Task Scheduler's `MultipleInstances = IgnoreNew` guards a task against **itself**, never against
another (register P11, report 20 §Run locking).

**How it hid.** The overlap only became *guaranteed* when the daily run got slower — the defect was
latent for as long as jobs happened to finish early. Corruption of a derived JSON also looks like a
rebuild bug, not a concurrency bug.

**Sutra Core must.** Use **named, rank-ordered resource locks** (not one global lock — a global lock
would have frozen the KG for the whole duration of every long daily run, and this KG has already been
lost once). Acquire in ascending rank, all-or-nothing, throw on descending order so circular wait is
impossible by construction; a loser **skips and exits 0** (a red task in Task Scheduler for a normal
outcome trains people to ignore it); lock files are per-machine runtime state and must be gitignored,
or they arrive on another host as un-reclaimable foreign locks.

**Test — `sched/resource-lock`.** A live holder turns the second acquirer away and the guarded block
provably does not run; a dead same-host PID is reclaimed; a **foreign-host** lock is never
PID-reclaimed; descending acquisition throws and leaves no lock file; a nested in-process call does not
self-deadlock.

---

## D10 · A task time limit shorter than the job

**What it was.** `Sutra Daily` had `ExecutionTimeLimit = PT2H` while `curate` + `organize` alone took
≈1.6 h at measured rates. Windows terminated the run (`0x40010004`) **every night since 2026-08-10**;
everything downstream never ran (register P1).

**How it hid.** The logs are 103 bytes — a START line and no STOP. `last-run.json` still said `ok` from
an earlier run. A killed process writes no failure record, so the only evidence was an *absence*, and
nothing was watching for absences (D12).

**Sutra Core must.** Derive the scheduler's limit from measured runtime with headroom, alert when a run
exceeds a fraction of its limit, and **detect the missing STOP** — a run that starts and never ends is
the loudest possible signal and was sitting in the logs unread for 26 days.

**Test — `sched/limit-exceeds-runtime`.** `doctor` compares each job's p95 duration against its
platform time limit and fails when the margin is under 2×; a fixture log with START and no STOP raises
an alert.

---

## D11 · LLM failures counted as skips

**What it was.** `auto-promote.ps1` caught every LLM error with `catch { return $null }`; the caller
counted it as a *skip*; the summary printed `"N promoted, N skipped (pending/no-extract)"` —
mislabelling failure as missing input — and exited **0** (register P5).

**How it hid.** Perfectly. The message named a benign cause, the exit code was green, and the run
manifest said `ok`. This is the single sentence that let a 26-day outage look like a quiet week.

**Sutra Core must.** Distinguish outcomes structurally: `ok` / `degraded` / `failed` / `skipped
(no input)` / `skipped (policy)` are five different things and must never share a counter. A run that
produced only stubs reports `degraded`; an all-zero run reports `no-op`, not `ok`; a majority-failure
exits non-zero. `did_work` is **three-valued** — `true`, `false`, or `null` = *not measurable* — so the
fix cannot misfire in the other direction and cry "did nothing" without proof.

**Test — `run/failure-is-not-skip`.** Inject a provider error: assert the reason bucket is a failure,
the run result is `degraded`, and the exit code is non-zero past the threshold. Assert an **empty**
vault still exits 0 — no false alarm.

---

## D12 · No time series for anything

**What it was.** Every state file was overwritten each run. Answering "is my graph growing?" required
hand-parsing 90 snapshots — and produced the **wrong** answer, because two machines wrote into one
git-committed snapshot directory and sorting by mtime interleaved them into a fake shrink
(register §4, report 20 §Metrics).

**How it hid.** A point-in-time value always looks fine. The absence of history is not visible in any
artifact; you only discover it at the moment you need to answer a trend question, which is the moment
you are already in an incident.

**Sutra Core must.** Append one row per run from day one — cheap, tolerant, append-only, atomic, with
**deltas computed per host** and blank cells (never zeros) for anything unmeasurable. Cost is ~250
bytes/run. Add `merge=union` in `.gitattributes` if the series is tracked, or keep it untracked.

**Test — `metrics/series-exists`.** Three runs on two interleaved hosts produce correct per-host
deltas (not cross-host ones); a missing input yields a blank cell rather than an exception; the header
appears exactly once; observability failure never fails the run.

---

## D13 · Enrichment does not update the artifact header

**What it was.** `enrich-graph.py` adds edges to `graph/exports/cytoscape.json` and updates only
`meta.enriched` / `meta.enrich_floor` / `meta.enrich_K`. `meta.edge_count` is left at the pre-enrich
value. **Measured on the live export: header 16,291 vs `edges[]` 29,286 — 44 % low.**

**How it hid.** Both numbers are individually plausible, and the cheap reader is the one that is wrong.
The new metrics counter deliberately does a 2 KB head read (130 ms vs 1,251 ms for a full parse) — so
the fix that finally made the graph observable inherited a lying header, and the resulting series
under-reports.

**Sutra Core must.** Make it a rule: *a pass that mutates a derived artifact updates every counter that
summarises what it mutated.* Prefer counters computed at write time over counters copied forward.

**Test — `artifact/header-matches-body`.** For every derived JSON, assert each header counter equals
the length of the collection it describes — before and after every enrichment pass.

> **Correction.** The brief that commissioned this document put the delta at ~7,600 edges; the measured
> value today is 12,995. Same defect, different magnitude — recorded because a threshold would have
> been set from that number.

---

## D14 · Classification happens once, and OCR is where credentials arrive

**What it was.** **Thirteen source documents**, all tiered `hosted_allowed` — flagged safe to send to a
hosted model — contained plaintext credentials, PII, or both: a full Claude OAuth token JSON, five
OpenAI project keys, two GitHub PATs, an SAP Datasphere OAuth secret, five-plus production database
passwords, a password reused across four systems, and more (incident, §Containment). **Every one of the
worst offenders was a PDF or OneNote export processed by Tesseract.**

**How it hid.** Two mechanisms compounding:
1. **OCR** — the credentials entered as *images of text*, so no human ever read them and the output was
   indexed as ordinary prose.
2. **Classify-once** — content classified under an older pattern set is never re-examined, so the
   pattern fixes of D4/D5 changed **nothing retroactively**. The 13 were surfaced by agents reading
   extracts, not by any scan. The incident report names this item 5, its only ⛔, and calls it "the
   durable lesson".

Compounding it further: the first manual triage **under-called it** — 39 documentation hits were
filtered out and the remaining 26 were dismissed as low priority without opening them; **six of those
26 held real credentials.**

**Sutra Core must.**
- Content-hash the active pattern set; stamp it on the corpus at each full scan; **block the release**
  when the hash changed and no re-scan has completed (I15).
- Classify OCR output **more** conservatively than typed text, recording the extraction engine on the
  extract and feeding it to the classifier (I16). OCR is also where content arrives *corrupt* — one
  live page was fabricated from an extract whose font shifted every glyph 31 code points, silently
  deleting every digit in the document.
- Scan **extracts**, not only pages, before any hosted dispatch. In the live system nothing reached the
  public mirror only because `mirror-export.ps1` happens not to copy `compiled/extracts/` — a lucky
  omission, not a control.
- Remember that re-tiering is **containment, not remedy**: the cleartext stays in git history, so
  rotation is the only fix and it is owner-only.

**Test — `gate/rescan-on-pattern-change`.** Ingest a note containing a *future* key shape; add the
pattern; assert the release gate fails until a re-scan runs, and that the note is then re-tiered
upward. Second case: an OCR-engine extract lands at the OCR floor even when its text looks benign.

---

## D15 · The anti-empty-stub guard was defeated by the pipeline's own output

**What it was.** The guard strips headings and known placeholders and requires ≥120 characters of
residual prose. Its strip list did not remove `## Related` wikilink lines, so **six machine-generated
cross-links (~144 chars)** carried otherwise-empty pages over the floor. 57 empty pages were laundered
into `status: active` and indexed as real knowledge (report 16 §2, report 20 §Auto-compile 3).

**How it hid.** The guard reported that it was working. Its own measurement was contaminated by a
*later* pipeline stage's output, which no one thought of as content.

**Sutra Core must.** Measure guards on human-meaningful prose only — machine-generated links, banners,
placeholders and blockquotes never count — and test each guard against a fixture built from **the
pipeline's own artifacts**, not from hand-written text.

**Test — `synth/guard-not-self-defeating`.** An extract with no distillable content plus an index
yielding six cross-links: assert the page is **held**, not written, and the hold is counted as
degradation.

---

## D16 · A provider chain that was one deep and said nothing

**What it was.** `$isUsable` returned a bare `$false` both for "excluded by policy" and for "key not
configured", and dropped the provider silently. `GEMINI_API_KEY` and `OPENROUTER_API_KEY` were never
exported; `openai` was **deliberately aliased onto Groq's endpoint**, so hops 1 and 2 of the four-hop
chain shared one upstream and died together (register S7, P4).

**How it hid.** Rotation *looked* like resilience. Every item dutifully burned four provider attempts,
of which two were the same dead upstream and two were absent keys — and the only record was in a
per-call log nothing read.

**Sutra Core must.** Separate the two exclusions: **policy** exclusion is correct and verbose;
**missing key** is a warning naming the exact environment variable, deduped once per run; an **empty
chain throws**. Treat an empty-string key as absent. Assert at startup that no two providers resolve to
the same base URL.

**Test — `route/unconfigured-is-loud`.** Unset one key: assert a warning naming that variable and a
`unconfigured` entry in the health file. Unset all: assert a throw, with nothing dispatched.

---

## D17 · The quality floor could be re-entered by its own fallback

**What it was.** `if (-not $candidates) { $candidates = @($tc.providers[0]) }` re-admitted the provider
the `reasoning_capable` floor had **just** excluded. A reasoning task could be served, silently, by a
model structurally barred from reasoning (report 20 §Router 2 — demonstrated against the committed
router, fixed by deleting the fallback).

**How it hid.** It is a defensive line. "Never return nothing" reads as robustness, and the resulting
answer is a normal HTTP 200 from a real model.

**Sutra Core must.** Never let a fallback re-admit anything a policy layer excluded. Prefer failing
loudly to serving something the policy just rejected — and make it a general rule: **a guard's
fallback path must be tested for the guard's own inversion.**

**Test — `route/floor-cannot-be-reentered`.** Configure a chain in which every provider fails the
floor; assert **nothing is dispatched** and the failure is recorded.

---

## D18 · A rebuild that wrote an empty graph over a good one

**What it was.** `refresh-graphs.ps1` pointed `build-kg.py` at `dimaag/compiled/graph/batches` — a
directory that **does not exist** — so every run rebuilt from nothing. The KG froze at 2026-08-01 with
a 2-byte state file. The anti-regression guard lived only in the *caller*, which is exactly how the
2026-08-08 loss happened (register P7, P8).

**How it hid.** The guard worked: it correctly rejected the empty result, every night, silently. A
guard that fires constantly and says nothing is indistinguishable from a healthy system.

**Sutra Core must.** Put the anti-regression guard **inside the builder**, not the caller; make a
resolved input path a startup assertion (a builder pointed at a non-existent directory must fail, not
produce zero); and **count and report guard activations** — a guard firing every run is an alert.

**Test — `graph/anti-regression`.** Point the builder at an empty directory: assert it refuses, the
good artifact is untouched, and the refusal is surfaced. Rebuild from the real store and compare
sha256 against a known-good file (the live verification did exactly this: 1,415 entities / 2,727
relations, identical).

---

## D19 · A code bug misfiled as 2,109 provider failures

**What it was.** `(Get-Item env:X -EA SilentlyContinue).Value` returns `$null` when `X` is unset;
reading `.Value` off it throws under `Set-StrictMode -Version Latest`. `NVIDIA_API_BASE` is normally
unset, so **every nvidia dispatch died before any network I/O** — 2,109 times, all recorded as provider
errors (register §4, report 20 §Router 1; `ms=20–300` proves nothing left the machine).

**How it hid.** The error text (`The property 'Value' cannot be found…`) reads like a response-parsing
problem, and it was logged in the provider's own error stream. Any success-rate computed from those
logs blamed the provider.

**Sutra Core must.** Give client-side faults their own status — `parse_error`, `unconfigured`,
`excluded_policy`, `no_provider` — **excluded from the provider success-rate denominator** and reported
separately. Use a StrictMode-safe environment reader everywhere and lint for the unsafe idiom.

**Test — `route/parse-error-attribution`.** Return an unparseable body: assert `status=parse_error`,
that the provider's `auth_fail` / `rate_limited` / `other_error` counters all stay 0, and that a
tokenising lint fails the build if the unsafe `Get-Item env:` idiom reappears in code.

---

## D20 · A vocabulary rename turned the only repair script into a permanent no-op

**What it was.** `backfill-synthesis.ps1:32` hard-filtered on `sensitivity: hosted_allowed`. A later
tier normalisation renamed that tier to `public`. The script then skipped **100 %** of candidates
regardless of API-key state (report 16 §4c).

**How it hid.** It exits 0 having processed nothing, which is the same output as "nothing to do".

**Sutra Core must.** Resolve every tier through **one** normaliser that accepts historical spellings —
never compare a raw frontmatter string to a literal — and treat a selector that matches zero items as a
warning, not a success.

**Test — `vocab/rename-safety`.** Feed both spellings to every tier comparison; assert identical
behaviour. Assert any selector returning 0 of N candidates logs a warning.

---

## D21 · A quality band that really measured "an LLM ran"

**What it was.** The freshness rubric banded **520 of 595** pages "healthy", and `Band` is — to within
5 pages — a restatement of `synthesis_mode == hosted`. 164 of those "healthy" pages had been clipped at
6,000 chars, 56 of them from sources over 25,000 chars. Nothing in the corpus can score above 87, so
the rubric cannot separate good from adequate (report 16 §5).

**How it hid.** It produced a number that went up when the pipeline ran, which is what a health metric
is supposed to do.

**Sutra Core must.** Band on **capture ratio** (`page words × ~6 / extract chars`) plus source
resolution, and never award points for the mere fact that a model was invoked. Publish the metric's
own blind spots next to it.

**Test — `quality/capture-ratio-band`.** A 400-word page from a 100,000-char source must band
**thin**, not healthy — even though it is fluent, long enough, and LLM-generated.

---

## D22 · A review queue that was 97 % machine artifacts

**What it was.** Of 1,972 open queue items, **1,919 (97.3 %) were near-dup artifacts** between opaque
`src-2026-NNNNNN` slugs — including page↔its-own-extract pairs, which are structural, not duplicates.
The operator-review brief fed the model the raw top-18 lines and was faithfully reporting garbage
(register B2, report 16 §5).

**How it hid.** The output was a plausible-looking review, so the queue looked *used*. The upstream
cause is worse: ingest-time dedup is inert (`Test-NearDup` always returns false).

**Sutra Core must.** Exclude structural pairs from the detector, cap any single category's share of a
review surface, and select **decision-bearing** items first with a bounded sample of the rest. A review
surface nobody can act on is not a review surface.

**Test — `queue/decision-bearing`.** Given a queue that is 95 % near-dups, assert the rendered surface
leads with decision-bearing items and samples the remainder.

---

## D23 · One failure string for two different failures

**What it was.** `trafilatura: no content or uv unavailable` covers both "the tool is not installed on
this node" and "the page returned no content" — **240 of 319** pending items, unseparable from the
manifests alone (report 16 §6b).

**How it hid.** It reads like a precise diagnosis. Nobody notices a conflation until they try to decide
whether the backlog is recoverable, and cannot.

**Sutra Core must.** Use a **reason enum**, not a message string. Tool-missing must be retried when the
tool appears; source-empty must not be retried at all. Retry policy is a function of the enum.

**Test — `extract/reason-enum`.** Assert every pending item carries an enum value; assert
"tool-missing" items are re-queued after the tool is installed and "source-empty" items are not.

---

## D24 · A fuzzy rule that blocks a commit

**What it was.** `generic-api-key-kv` matches `key = value` shapes. It cannot distinguish
`password=dbutler_prod_9x2Kq` (a real secret) from `password=db_password` (a variable reference) —
they are **structurally identical**, so no regex separates them. Blocking commits on it is how a hook
earns a `--no-verify` habit (see D6). *(Landed after the register was frozen; verified in code at
`dimaag/automation/scripts/governance/Invoke-SecretScan.ps1:221-226`, where entries flagged
`Heuristic = $true` still floor the tier but are excluded from the blocking rule set.)*

**How it hid.** An attempt to tighten the pattern was written **and then reverted**: testing showed the
tightened version stopped flooring an identifier-shaped literal password — trading a harmless false
positive for a harmful false negative. The tempting fix was the wrong one, and only a test caught it.

**Sutra Core must.** Band every detection rule: **a fuzzy rule may raise a tier (safe when wrong) but
must never block a commit (costly when wrong).** Only high-confidence shapes — a matched key prefix, a
known secret path — may fail a commit. The property defaults to falsy so existing high-confidence rules
keep blocking unchanged.

**Test — `hook/banding`.** Every rule declares a band; assert no `heuristic` rule can produce a non-zero
hook exit, and that each still floors the tier. Regression fixture: an identifier-shaped literal
password must floor.

---

## D25 · Submodule reconcile on a node that runs its own pipeline

**What it was.** `git submodule update --init --recursive` **always** aborts on a node whose vault
working tree is dirty — which is every node that runs the pipeline, because the pipeline is what
dirties it. The reflexive fixes (`checkout -f`, `reset --hard`, `clean -fd`) are the **only** way to
lose data here. *(Landed after the register was frozen; pattern implemented at
`scripts/envy/reconcile-vault.ps1`.)*

**How it hid.** Git is *protecting* you, but the message reads as an obstacle, and every search result
suggests a destructive command. The trap is that the obvious remedy is the failure mode.

**Sutra Core must.** Ship the safe reconcile as a first-class verb rather than letting users invent one
under pressure: **snapshot everything (tracked *and* untracked) onto a timestamped rescue branch
first**, then sync, then restore only real captures — never derived artifacts — and keep the rescue
branch afterwards as the undo. A file present in both the snapshot and upstream is not overwritten:
upstream wins.

**Test — `vault/reconcile-is-safe`.** Dirty working tree + upstream divergence: assert the rescue
branch contains every pre-run file, that no untracked capture is lost, that derived artifacts are not
restored over upstream, and that the command never invokes `reset --hard` / `clean -fd`.

---

## D36 · The KG's only input store was gitignored

**What it was.** `build-kg.py` is a **full re-merge**: the knowledge graph is a pure function of the
batch store, and `kg.json` is a derived artifact carrying no history of its own. That store lived at
`scripts/kg/data`, which `scripts/kg/.gitignore:1` excludes. So the 50 batch files behind the entire
graph — every entity and relation ever extracted — existed on exactly **one laptop**, untracked and
unbacked-up, on a machine explicitly scheduled for retirement. Losing that disk would not have
degraded the KG; it would have made it **unreproducible**, permanently.

**How it hid.** Nothing was broken, so nothing complained. `kg.json` *is* committed, so the graph
looked safely version-controlled — the artifact travelled while its inputs did not. D18 made this
worse by pointing the builder at the vault path while the data sat in the ignored one: the "fix" for
D18 was to move the *pointer* to the data, which entrenched the data's untracked location.

**Sutra Core must.** Treat the batch store as **primary data, not scratch** — version-controlled and
inside the vault (`compiled/graph/batches/`), with the derived `kg.json` alongside it. A builder whose
inputs are gitignored must fail a doctor check. The general rule: *if an artifact is a pure function of
an input, the input is the thing you must not lose* — committing only the output is a backup illusion.
Tier safety comes from the export allow-list (`mirror-export` copies named directories, so all-tier
batches never reach a public node), **not** from gitignore.

**Test — `graph/store-is-tracked`.** Assert every input directory the builder resolves is (a) inside
the repo, (b) not matched by any `.gitignore`, and (c) non-empty; then assert a clean clone can rebuild
the graph and reach the same entity/relation counts. Live verification: 50 files relocated to
`dimaag/compiled/graph/batches/`, `git check-ignore` returns not-ignored, rebuild reached 2,816
entities / 5,338 relations against the 1,415 / 2,727 baseline.

---

## D37 · The merge drops the provenance it was given

**What it was.** The extractor was fixed to stamp `extractor: "claude-insession" | "ollama" | "gateway"`
on every record. `build-kg.py` then built its output records field-by-field — `name`, `type`, `aliases`,
`mentions`, `degree` — and simply never copied `extractor` across. The stamp was written on every one
of ~7,900 input records and present in **zero** output records.

**How it hid.** Both halves passed their own tests. The extractor's test asserted the stamp was written
to the batch file; the builder's test asserted counts and endpoint integrity. Neither test spanned the
seam, and the field's absence is invisible unless you go looking for it. This is the generic shape:
**a field added at one end of a pipeline dies at the first stage that enumerates fields explicitly.**

**Sutra Core must.** Make provenance a first-class, merged property (a set — one entity legitimately
has several extractors across batches), and test it **end to end**, not per stage. Prefer carrying
unknown fields through a merge over enumerating known ones.

**Test — `graph/provenance-survives-merge`.** Stamp a synthetic batch, merge it, assert the stamp is
present on the merged record and that two batches with different extractors produce a two-element set.
Live verification: 2,071 entities carry `claude-insession`, 745 legacy entities carry none — the split
matches the batch inventory exactly.

---

## D38 · Third-party-identifiable content at hosted-egress tier

**What it was.** A sweep of the corpus for recognisable client names found **27 files at
`hosted_allowed`** naming real customers (one national oil company ×18, two pharma ×4), carrying
substantive delivery detail — solution designs, model comparisons, data-product runbooks, migration
PoCs. `mirror-export.ps1` includes `vault/` and gates only on tier, so this material is eligible for
egress to third-party LLM providers.

**How it hid.** The tiering machinery worked perfectly — every gate did exactly what it was told. The
defect is that **tier encodes "may this leave the machine", not "whose information is this"**, and
those two questions have different answers. Personal-sensitivity heuristics (keys, PII, health) never
fire on a client name, which is not sensitive *to the author* at all. One compiled page had already
generalised its client name and left a note saying client-identifiable material should not sit at
public tier — a correct judgement, applied to exactly one page, invisible to the tiering system.

**Sutra Core must.** Add a **third-party-identifiability dimension orthogonal to sensitivity**: a
configurable named-entity list (employer, clients, counterparties) that the classifier checks
independently of secret/PII shapes, so the question "is this mine to send?" is asked separately from
"is this secret?". Ship it defaulting to warn-not-block, because the correct remedy is usually to
**generalise in place**, not to re-tier — re-tiering silently degrades whatever lane was built on the
material, turning a governance fix into a functional regression.

**Test — `tier/named-third-party`.** Configure a named third party, plant it in a `hosted_allowed`
note, assert the check reports it, does not auto-re-tier, and names the generalise-in-place remedy.
Assert an unconfigured deployment is silent (no false positives on a fresh install).

---

## D39 · The merge resolved conflicting facts by filename order

**What it was.** Eleven independent extractors each typed the entities they found. They disagreed about
**325 of 2,965 names (11 %)** — `REAPER` technology ×29 / product ×7, `MIDI` technology ×38 / concept ×1,
`Databricks` technology ×14 / organization ×11 / product ×3. `build-kg.py` merged with
`ents.setdefault(...)`, so the type that survived was **whichever batch `glob` returned first**. The
graph's entire type layer — which drives colour, filtering and grouping in both viewers — was an
artifact of filename sort order, and would flip if a batch were renamed.

**How it hid.** Every individual type was legal and plausible; no validator could object, because each
value was one an extractor had legitimately produced. The defect is invisible in the output and only
detectable by comparing *across* inputs — which nothing did. It also disguised itself as a judgement
call: a reviewer seeing `Databricks: organization` reads a debatable-but-defensible decision, not a
coin-flip.

**Sutra Core must.** Treat a merge as the **only stage that can see all the evidence**, and make it
resolve rather than arbitrate by accident. Conflicting values are voted on; ties break on an explicit,
documented precedence (specific beats generic; the value an unsure extractor emits by default must lose
to any positive assertion). The general rule: **a merge's output must not depend on the order or names
of its inputs.** Where a merge cannot resolve a conflict, it must record that the conflict existed
rather than silently pick.

**Test — `merge/order-independent`.** Merge a fixture set, shuffle the input filenames, merge again, and
assert the outputs are byte-identical. Separately, plant a 3-vs-1 type disagreement and assert the
majority wins; plant a 1-vs-1 and assert the documented precedence decides it.

---

## Smaller traps — each one a real outage or near miss

Short entries. Same rule: each ships with a test or it is not fixed.

| # | Trap | Test |
|---|---|---|
| **D26** | `Join-Path $Root 'state\checks'` — a backslash is a legal **filename** character on Linux, so this creates a directory literally named `state\checks` on the VPS (report 20 §Metrics 2) | build every path through one helper on `[IO.Path]::Combine`; assert on a Linux runner |
| **D27** | Derived artifacts unbounded: 343 MB of snapshots / 90 files, 7.5 MB of provider logs, never pruned (register O6) | retention with a **hard floor** (newest per host is never pruned) and provider logs **rotated, never deleted** — they are the health ground truth; `-WhatIf` must be exercised in CI |
| **D28** | "Created ≠ wired" and its twin, **"run ≠ scheduled"** — the script that produced 71 % of the corpus was never scheduled and ran once, by hand | CI rule: every installed script has a caller; every content-producing script has a schedule or is explicitly marked interactive |
| **D29** | The run manifest was unreachable from the dashboard **by construction** — `last-run` was missing from a four-name allowlist (register O5) | assert every artifact the UI claims to show is reachable through its own API on a clean provision |
| **D30** | `Remove-Item -LiteralPath` fails on 8.3 short-name paths *even under* `-ErrorAction SilentlyContinue` — a lock that cannot be deleted never releases (report 20 §Run locking) | delete through `[IO.File]::Delete`; test on a short-name path |
| **D31** | `ConvertFrom-Json` silently re-hydrates an ISO-8601 string into a `[datetime]`, and round-tripping renders it in the **current culture**, shifting every age computation by the UTC offset (report 20 §Run locking) | assert the round-trip is offset-free |
| **D32** | A poller holding its update offset in memory replays commands after a restart, then silently drops those issued while it was down (report 20 §Ops-bot 5) | persist the offset, commit **after** acting; assert a restart neither replays nor drops |
| **D33** | An emoji scan under a mis-declared multibyte locale silently matches nothing — turning a 15-alert day into "✅ nothing" (report 20 §Ops-bot 3) | run byte-wise under `LC_ALL=C`; test under a hostile locale |
| **D34** | A report long enough to exceed the messaging limit gets **truncated** — and a bad day is always a longer message than a good one | split on line boundaries; test with an over-limit failure report |
| **D35** | Two hosts writing one git-committed derived directory produce a **phantom shrink** when sorted by mtime (register §4) | group every series by host; assert cross-host deltas are never computed |

---

## What the audit itself got wrong

The register keeps a table of its own incorrect claims — six of them — and this document inherits that
discipline. **Four of the six came from measuring the wrong thing**, not from missing data: the raw
extract file instead of its body (which made 78 empty pages look recoverable); an environment-variable
read mistaken for a response-shape bug; key reordering mistaken for value changes; mtime ordering
mistaken for graph shrinkage.

Two rules follow, and they belong in the product, not just in the report:

1. **Where a number drives a destructive action, measure it two ways before acting.** The clipped-page
   count (160) is trustworthy precisely because two independent methods produced it.
2. **State what has *not* been verified, in the same breath as what has.** Every measurement behind
   this document was taken on one laptop; nothing has been verified on the trusted node or the VPS, and
   no scheduled run has yet completed cleanly with the fixes in place. That run is the only proof that
   matters, and it has not happened.

This document has one known error of its own, recorded above at D13: the edge-count delta was given to
me as ~7,600 and measures 12,995.
