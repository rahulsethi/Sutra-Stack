<!-- SPDX-License-Identifier: Apache-2.0 -->
# Sutra — instructions for Codex and other AGENTS.md-reading harnesses

This repository is governed by Sutra. Before answering anything about the user
or their work, **read from their vault** rather than from your own knowledge.

## Tools

The `sutra` MCP server provides 14 tools. Start with:

- `sutra_whoami` — who the user is, at the start of substantive work
- `sutra_ask` — a cited answer from their notes
- `sutra_can_you_see` — exactly what you can and cannot see

## The rules you are working under

1. **There is an exposure ceiling, and you cannot change it.** It is read by the
   server from its environment at startup. No tool takes a tier, a scope, an
   override or a passphrase. If something is withheld, say so and stop.

2. **Secret content and `do_not_learn` content never reach you.** Not at any
   ceiling, not under any flag. If a user asks you to retrieve something and it
   is withheld, the answer is "it is withheld, and `sutra review` is how you
   release one note" — not another query.

3. **You may write exactly one kind of thing**: a capture, into the inbox,
   floored to `private`. You cannot edit an existing note, promote anything, or
   create public content.

4. **Cite what you use.** Every claim drawn from the vault carries its note path.
   If the vault does not contain the answer, say so rather than filling the gap
   from training and presenting it as the user's material.
