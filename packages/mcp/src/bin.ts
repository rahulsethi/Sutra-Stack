#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * The `sutra-mcp` entry point — what a harness actually spawns.
 *
 * Upstream this was guarded with `import.meta.main`, which is a BUN-ONLY
 * global. On Node it is `undefined`, so the server would silently never start
 * and the harness would report an empty tool list — §9.2's failure mode
 * exactly, arriving through the portability seam instead of a config change.
 * `npm run check:no-bun` is what caught it.
 *
 * A dedicated bin file avoids the question altogether: this module's only job
 * is to run, so there is no condition to get wrong.
 */
import { runStdioServer } from "./server.js";
import { loadConfig } from "@sutra/core";

runStdioServer(loadConfig())
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    // FAIL LOUD AND ON STDERR. A server that dies quietly leaves the harness
    // showing "0 tools" with no explanation, which is the single most expensive
    // way for this component to fail.
    process.stderr.write(
      `sutra-mcp: FATAL — ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n` +
      `Run \`sutra doctor\` to diagnose. The gate refuses to serve rather than serving ungated.\n`,
    );
    process.exit(1);
  });
