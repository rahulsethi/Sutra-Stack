---
name: sutra-capture
description: Save something worth keeping into the user's inbox, floored to private.
---
<!-- SPDX-License-Identifier: Apache-2.0 -->

Save the thing under discussion into the user's vault with `sutra_capture`.

- Write a **title** that will still make sense in six months.
- Keep the user's own words where they said something well. A capture is their
  note, not your summary of their note.
- The tier is floored to `private` and **cannot be public**. If the material is
  genuinely sensitive — a credential, health, finance — pass
  `sensitivity: "secret"`, which means it never reaches any model again,
  including you.
- Tell the user the path it landed at.

If write-back is disabled the tool says so. Relay that; do not work around it.
