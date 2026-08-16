#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Run a command ONLY IF the `ee/` subtree is present.
 *
 * This tiny script is what makes `rm -rf ee/` a supported operation rather than
 * a broken build. `ee` is deliberately NOT an npm workspace and NOT part of the
 * default `build`/`test` scripts, because a workspace entry pointing at a
 * deleted directory fails `npm install` — and the whole open-core promise is
 * that deleting the commercial subtree leaves a working product.
 *
 * Absent ee/, this exits 0 and says so. That is the OPEN-SOURCE BUILD, and it
 * is a first-class configuration, not a degraded one.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

if (!existsSync(join(ROOT, "ee"))) {
  console.log("ee/: not present — skipping. This is the Apache-2.0 open-source build.");
  process.exit(0);
}

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error("usage: node scripts/if-ee.mjs <command> [args...]");
  process.exit(64);
}

const isNpx = !["node", "npm"].includes(cmd);
const r = spawnSync(isNpx ? "npx" : cmd, isNpx ? [cmd, ...args] : args, {
  cwd: ROOT,
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(r.status ?? 1);
