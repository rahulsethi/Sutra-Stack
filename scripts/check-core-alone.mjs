#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * M0's verify check, and LICENSING.md §4 rule 1 — the one that matters:
 *
 *     rm -rf ee/ && build && full test suite   must pass.
 *
 * Without this, "Core depends on ee/" is discovered at release, when it is
 * expensive. With it, it is discovered on the commit that introduces it.
 *
 * Method: copy the tracked tree to a temp dir, delete ee/, install, build, test.
 * We copy rather than deleting in place because a check that can damage the
 * working tree is a check people stop running.
 */
import { cpSync, existsSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIP = new Set(["node_modules", ".git", "dist", "coverage", ".sutra", "graphify-out"]);

const work = mkdtempSync(join(tmpdir(), "sutra-core-alone-"));
let failed = false;

function run(cmd, args, cwd) {
  process.stdout.write(`  $ ${cmd} ${args.join(" ")}\n`);
  execFileSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
}

try {
  console.log(`core-alone: staging a copy at ${work}`);
  for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    cpSync(join(ROOT, entry.name), join(work, entry.name), {
      recursive: true,
      filter: (src) => !SKIP.has(src.split(/[\\/]/).pop()),
    });
  }

  const ee = join(work, "ee");
  if (!existsSync(ee)) {
    console.error("core-alone: FAIL — no ee/ directory found to delete.");
    console.error("  Either the subtree was renamed, or this check is now testing nothing.");
    process.exit(1);
  }
  rmSync(ee, { recursive: true, force: true });
  console.log("core-alone: ee/ deleted. Core must now stand entirely on its own.\n");

  run("npm", ["install", "--no-audit", "--no-fund", "--silent"], work);
  run("npm", ["run", "build"], work);
  run("npm", ["test"], work);

  // A build can succeed while a stale import string survives in source. Grep for
  // any reference back into the deleted subtree.
  const offenders = [];
  try {
    const out = execSync(
      `git grep -n -E "from ['\\"](\\.\\./)*ee/|require\\(['\\"](\\.\\./)*ee/|@sutra/ee" -- packages vault-template automation plugins skills tests`,
      { cwd: ROOT, encoding: "utf8" },
    );
    if (out.trim()) offenders.push(out.trim());
  } catch {
    // git grep exits 1 on no matches — that is the passing case.
  }
  if (offenders.length) {
    console.error("\ncore-alone: FAIL — Core source references ee/:\n" + offenders.join("\n"));
    failed = true;
  }
} catch (e) {
  console.error("\ncore-alone: FAIL — Core does not build or test without ee/.");
  console.error(String(e.message ?? e));
  failed = true;
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failed) process.exit(1);
console.log("\ncore-alone: OK — `rm -rf ee/` builds and passes the full Core test suite.");
