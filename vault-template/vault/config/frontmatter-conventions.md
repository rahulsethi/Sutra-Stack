<!-- SPDX-License-Identifier: Apache-2.0 -->
# Frontmatter conventions

> Every note in a Sutra vault is plain markdown with a YAML frontmatter block.
> This file documents what those keys mean. It is the vault's schema, and it
> ships with the vault so the schema travels with the data.
>
> **`sensitivity` is the only key the gate reads.** Everything else is
> organisation; that one is governance.

---

## The governance keys

These two decide what your AI can see. Nothing else does.

| Key | Values | Meaning |
|---|---|---|
| `sensitivity` | `public` · `private` · `secret` | The exposure tier. **Absent means `private`.** |
| `do_not_learn` | `true` · `false` | When `true`, this note reaches **no** model at **any** tier, including `public`. |

### `sensitivity`

| Spelling | Internal id | What it means in practice |
|---|---|---|
| `public` | `hosted_allowed` | May be sent to a cloud model. |
| `private` | `review_required` | Stays local. Can be released one note at a time, temporarily, via `sutra review`. |
| `secret` | `local_only` | **Never** reaches any model — hosted or local-via-a-harness. Not under an override, not under a flag. |

Both spellings are accepted everywhere and always will be: `public` and
`hosted_allowed` are the same tier, and every comparison in the product resolves
through one normaliser. Never compare a raw frontmatter string to a literal in
your own tooling — a vocabulary change would silently turn your script into a
no-op, which is precisely what happened to the upstream repair script this
product was extracted from.

**Sensitivity is raise-only.** Classification floors a note first, then only
ever raises it. No automated path lowers a tier. If a note is more restricted
than you expected, something matched a rule; `sutra rescan` shows you which one.

### `do_not_learn`

An axis of its own, orthogonal to tier. A note marked `do_not_learn: true` is
excluded from every model surface even if it is tagged `public`. Use it for
material that is not secret but that you do not want a model reasoning from or
repeating back — someone else's words, a draft you have not stood behind, a
thing you are still deciding about.

---

## Core keys

| Key | Used on | Notes |
|---|---|---|
| `type` | every note | `Source`, `Topic`, `Daily`, `Identity`, `IdealStateArtifact`, `Type`, … Drives templates and graph node typing. |
| `id` | sources, projects | A stable identifier. `sutra get <id>` resolves it. |
| `title` | any | Optional — the first `# Heading` in the body wins if present. |
| `status` | any | `active`, `draft`, `imported`, `archived`. |
| `created` / `updated` | any | ISO dates. `updated` breaks exact ranking ties toward the newer note. |
| `tags` | any | Inline array: `tags: [one, two]`. Kept frontmatter-safe — no commas or brackets inside a tag. |
| `related_to` | any | Array of `[[wikilinks]]`. The graph's edges come from these plus inline links. |

## Provenance keys

Set by the pipeline, not authored by hand. They exist so that a claim in a
compiled page can be traced back to the thing it came from.

| Key | Meaning |
|---|---|
| `source_refs` | Array of ids/paths of the extracts a page was written from. |
| `source_date` | When the source material is FROM (not when it was ingested). |
| `ingested_at` | ISO timestamp the pipeline took it in. |
| `hash` / `source_sha256` | Content hash of the source. Drives idempotency and staleness. |
| `extract_engine` | Which extractor produced the text. **An OCR engine floors the note to `secret`** — see below. |
| `source_chars_seen` / `source_chars_total` | How much of the source a generated page actually saw. |
| `synthesis_provider` / `synthesis_model` | Which model wrote a page, when one did. Absent means none did. |

### Why `extract_engine` is a governance key, not a curiosity

Text that arrived as an **image of text** — a PDF or an export run through OCR
— is classified more conservatively than typed text, and is never eligible for
a cloud route on its ingest-time tier alone.

The reason is empirical. In the system Sutra was extracted from, every one of
the worst credential exposures entered the vault through OCR: as an image,
nobody ever read it, and the extracted text was indexed as ordinary prose. OCR
is also where content arrives *corrupt* — one page was written from an extract
whose embedded font had shifted every glyph 31 code points, silently deleting
every digit in the document, and the resulting page was fluent and wrong.

### Why `source_chars_seen` and `source_chars_total` exist

So that truncation is a **fact on the artifact** rather than something you have
to infer. If they differ, the page was written from part of its source, and it
should be treated as unverified until re-synthesised.

They exist because a single line of code once truncated every source to 6,000
characters before synthesis. It produced 424 pages that were confident, fluent,
correctly formatted, ~400 words — and wrong in specifics. Nothing looked
anomalous, because page length was flat across two orders of magnitude of source
size. Length is not a quality signal; **capture ratio** is.

---

## Where a note lives

The vault uses a PARA-style numbered layout. The numbers are for sort order and
carry no meaning to the code — a floor rule matching `identity/accounts` matches
`11-identity/03-accounts` too, because path matching strips numeric prefixes.

| Directory | Holds |
|---|---|
| `00-inbox` | Captures awaiting review. Everything a model writes lands here, floored to `private`. |
| `00-insights` | Synthesised observations. |
| `01-capture` | Raw captures from other surfaces. |
| `02-projects` | One directory per project, each with an `isa.md` (its target state). |
| `03-areas` | Ongoing responsibilities with no end date. |
| `04-people` | Notes about people. Consider `do_not_learn` here. |
| `05-topics` | Durable topic pages — the compiled knowledge layer. |
| `06-procedures` | How you do things. |
| `07-systems` | Systems you operate. |
| `08-daily` | Daily logs. |
| `09-reviews` | Weekly and periodic reviews. |
| `10-assets` | Reference material. |
| `11-identity` | `principal.md`, `telos.md`, `persona.md`. Read by `sutra_whoami`, gated per file. |
| `12-relationship` | Interpersonal context. Frequently `secret`. |
| `13-learning` | Study notes. |
| `14-planner` | Tasks and plans. |
| `config/` | **This directory.** Conventions, schemas, templates. **Never treated as knowledge** — a template cited as a source is a confident, useless answer. |

Directories outside `vault/` — `raw/`, `compiled/`, `logs/`, `state/`,
`graph/` — are pipeline territory. `raw/` in particular is unclassified by
definition and is structurally excluded from every retrieval path, before any
tier check runs.

---

## Defaults, and why they are what they are

**A new note with no `sensitivity` key is `private`.**

This is the single most load-bearing default in the vault. An unlabelled note is
not one you decided was safe to share — it is one nobody has looked at. If the
default were `public`, then every parse failure, every hand-written file and
every malformed frontmatter block would become an egress.

The shipped templates in `config/templates/` therefore default to `private`.
Change a note to `public` deliberately, per note, when you have decided it.
