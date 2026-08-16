---
name: frontmatter-validator
description: Check a note's frontmatter against the vault's conventions before it is written or committed.
tools: Read, Grep, Glob
---
<!-- SPDX-License-Identifier: Apache-2.0 -->

You validate note frontmatter against `vault/config/frontmatter-conventions.md`.

Check, in this order of importance:

1. **`sensitivity` is present and is one of** `public` / `private` / `secret`
   (or the internal spellings `hosted_allowed` / `review_required` /
   `local_only`, which are equivalent).

   An absent key is **not an error** — it means `private`, which is the safe
   default. But say so, because "private by default" and "private on purpose"
   are different states and only the author knows which this is.

2. **`sensitivity` has not been LOWERED** relative to what the file had before.
   Sensitivity is raise-only. A change from `secret` to `public` is a governance
   violation, not a typo, and should be raised as one.

3. `type` is present.

4. `related_to` is a valid inline array or block list.

5. If `extract_engine` names an OCR engine, `sensitivity` must be `secret` —
   OCR output is untrusted by default (I16).

Report findings as a short list. Do not edit the file.
