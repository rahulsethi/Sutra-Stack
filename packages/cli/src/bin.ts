#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * The `sutra` entry point.
 *
 * Kept to almost nothing on purpose: the process exit code is a governance
 * signal (see `exit.ts`), and an entry point with logic in it is an entry point
 * that can lose one.
 */
import { run } from "./index.js";

run(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    process.stderr.write(`sutra: FATAL — ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exit(1);
  });
