<!-- SPDX-License-Identifier: Apache-2.0 -->
# Git hooks

**Install once, per clone:**

```sh
git config core.hooksPath .githooks
```

`sutra init` does this for you. `sutra doctor` checks it.

## Why these are tracked

The system Sutra was extracted from kept its pre-commit hook **untracked**, in
`.git/hooks/`, with `core.hooksPath` unset. Enforcement therefore did not
survive a clone: every fresh checkout had no secret scanning at all, while
everyone involved believed it did.

That is the failure these files exist to prevent, and it is why the install step
is one line in the README rather than a script nobody runs.

## `pre-commit`

Scans the staging area for credential shapes. Three properties, in order of how
much they matter:

1. **Fails closed.** Missing `pwsh`, missing scanner, unreadable pattern set —
   all refuse the commit. A guard that disappears quietly is not a guard.

2. **Fast.** One interpreter spawn, one `git diff --cached`, regexes compiled
   once. Sub-second regardless of file count. The upstream version spawned one
   `grep` per staged file at ~1.05s each — ten-plus minutes on a large commit,
   and consequently `--no-verify` as standing policy (128 occurrences across
   91 files). A hook that is too slow is a hook that is not running.

3. **Only `definite` rules block.** A fuzzy rule may raise a tier and warn; it
   may never fail a commit. `password = <value>` cannot be distinguished from
   `password = <variable name>` by any regex, so blocking on it is how a hook
   earns a `--no-verify` habit it never recovers from.

## If the hook is wrong

**Please file it rather than reaching for `--no-verify`.** A guard that gets
routed around is worse than no guard, because it also carries the belief that it
is protecting you.
