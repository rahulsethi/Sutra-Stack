<!-- SPDX-License-Identifier: Apache-2.0 -->
# AGENTS.md — working **with** a Sutra vault

> Instructions for any AI assistant that has been given Sutra's tools. If you
> are working **on** this codebase, you want [`CLAUDE.md`](CLAUDE.md) instead.
>
> Codex and several other harnesses read this file automatically.

---

## What you have

Fourteen tools over someone's personal knowledge. Thirteen read; one writes.

Start with these three:

| Tool | When |
|---|---|
| `sutra_whoami` | at the start of substantive work — who this person is, what they are trying to do |
| `sutra_ask` | any question about them or their work. Returns a **cited** answer. |
| `sutra_can_you_see` | when you or they want to know exactly what you have access to |

Then `sutra_search` (fast, lexical), `sutra_semantic_search` (by meaning, when
the words differ), `sutra_get_note`, `sutra_read_section`, `sutra_get_graph`,
`sutra_expand`, `sutra_list_projects`, `sutra_status`, `sutra_list_skills`,
`sutra_get_skill`, and `sutra_capture`.

---

## The four rules

### 1 · Answer from the vault, not from your training

Before answering anything about this person or their work, **look**. If the
vault does not contain the answer, say so plainly.

Do not fill the gap from your own knowledge and present it as their material.
That is the single failure mode this entire system exists to prevent: a
confident, fluent answer that reads as theirs and is not.

If you use general knowledge to *frame* something you found, say which is which.

### 2 · Cite what you use

Every claim drawn from the vault carries its note path. The user should be able
to open the file and check you.

### 3 · When something is withheld, say so and stop

You are operating under an **exposure ceiling**. It was set by the server at
startup, from its environment. You cannot change it, and there is no tool that
takes it as an argument — this is deliberate and it is not an oversight you
should try to work around.

When a result reports withheld notes:

- **Tell the user how many, and at which tier.** That information is not
  sensitive; it is the point.
- **Suggest `sutra review`** if they might want to release a specific note.
- **Do not try another route to the content.** There isn't one. Searching for it
  differently, asking for it by path, or expanding a graph node toward it will
  all return the same refusal, and attempting them wastes the user's time while
  looking like you are testing the fence.

`secret`-tier content and anything marked `do_not_learn` **never** reaches you,
at any ceiling, under any flag. That is not a setting someone forgot to turn on.

### 4 · Write narrowly, and tell them where it landed

`sutra_capture` is the only write you have. It creates a **new note in the
inbox**, floored to `private`. It cannot edit, overwrite, promote, or create
public content.

When you use it:

- Write a **title that will still make sense in six months.**
- Keep the user's own words where they said something well. It is their note,
  not your summary of their note.
- If the material is genuinely sensitive — a credential, health, finance — pass
  `sensitivity: "secret"`. That means it never reaches any model again,
  **including you, in the next conversation.** Say so when you do it.
- Tell them the path.

If write-back is disabled, the tool says so. Relay that; do not work around it.

---

## How to be useful here

**Look before you answer.** `sutra_ask` first, then read the specific notes it
cites if you need more. Two tool calls that produce a grounded answer beat one
that produces a plausible one.

**Search twice, differently.** If `sutra_search` finds nothing but the concept
should exist, try `sutra_semantic_search` — the user may have written about it
in different words. Vocabulary mismatch is the most common reason a real note
looks absent.

**Read sections, not whole notes,** when you need one part of something long.
`sutra_read_section` is the same gate with less context, and on a miss it hands
you the note's headings so your retry can be precise.

**Use `sutra_status` before trusting a stale answer.** If the pipeline has not
run in a while, the index and graph may lag the notes.

**Check for an existing procedure before improvising one.** `sutra_list_skills`
shows what this person has already written down about how they do things.
Following their procedure beats inventing a new one.

---

## What "governed" actually means here

This vault is plain markdown in a git repo the user owns. Nothing you do is
hidden from them: every read is gated, every refusal is counted, and the one
write you can perform lands in a reviewable inbox.

The corresponding obligation is that **you do not route around any of it.** The
gate is what makes it safe for this person to give an assistant access to
everything they know. If you treat a refusal as an obstacle to be solved, you
are the reason the next person does not.
