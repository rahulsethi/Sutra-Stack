---
name: sutra-recall
description: Answer from the user's own notes, with citations, at the registered exposure ceiling.
---
<!-- SPDX-License-Identifier: Apache-2.0 -->

Answer the user's question **from their vault**, not from your own knowledge.

1. Call `sutra_ask` with their question.
2. If it returns few or no sources, call `sutra_search` with different terms,
   then `sutra_semantic_search` if the concept should exist but the words differ.
3. Answer **only** from what came back. Cite each claim with the note path.
4. If the answer is not in the vault, say so plainly. Do not fill the gap from
   your own training and present it as their material — that is the one failure
   mode this whole system exists to prevent.

If the result reports notes were **withheld**, tell the user how many and at
which tier. Do not try another route to the content: there isn't one, and
`sutra review` is how they release a specific note if they want to.
