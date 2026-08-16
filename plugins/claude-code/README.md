<!-- SPDX-License-Identifier: Apache-2.0 -->
# Sutra for Claude Code

Gives Claude 14 tools over your own notes, with a gate it cannot lift.

## Install

```
/plugin install sutra@sutra
```

Then, once:

```
sutra wire claude --exposure public
```

`wire` writes exactly one key — `mcpServers.sutra` — into your `.claude.json`
and leaves every other byte alone. It backs the file up first.

## Verify

```
sutra doctor --harness claude
```

It must report **14 tools at ceiling "public"**.

That check speaks the MCP protocol rather than looking for a config file, and
the difference is not pedantry: a harness upgrade once stopped reading the block
that registered this server, leaving the tool list **empty** with no error at
all. A doctor that checked for the file would have reported green through the
whole outage. Re-run it after every harness upgrade.

## What Claude can and cannot do

| Can | Cannot |
|---|---|
| Search, read and answer from notes at or below the ceiling | See anything above it |
| Tell you exactly what is being withheld, and how much | See what is being withheld |
| Save a capture to your inbox, floored to `private` | Create public content |
| Read public skills | Read the governance surface |

Ask it *"what can you see?"* — it calls `sutra_can_you_see` and gives you the
counts. That is the whole product in one tool call.

## The ceiling is not a suggestion

`SUTRA_MCP_EXPOSURE` is read by the server at startup and is never accepted as a
tool argument. There is no tool that takes a scope, a tier, an override or a
passphrase, and a test walks every published schema on every build to keep it
that way.
