---
name: sutra-gate
description: Show exactly what the assistant can and cannot see.
---
<!-- SPDX-License-Identifier: Apache-2.0 -->

Call `sutra_can_you_see` and report it plainly:

- the ceiling this session is registered at,
- how many notes are visible,
- how many are withheld, broken down by tier.

Then say, in one sentence, what would change at a different ceiling — and note
that `secret` and `do_not_learn` material never reaches any model at any
ceiling, so raising it would not surface those.
