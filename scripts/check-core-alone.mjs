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
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIP = new Set(["node_modules", ".git", "dist", "coverage", ".sutra", "graphify-out"]);

/**
 * BUILD STATE THAT MUST NOT TRAVEL.
 *
 * `tsconfig.tsbuildinfo` lives at the PACKAGE ROOT, not inside `dist/` — so
 * skipping `dist` is not enough. Copying it into a tree whose `dist` was
 * deliberately left behind makes `tsc --build` decide everything is up to date:
 * it emits NOTHING, exits 0, and this check reported a passing build with no
 * compiled output at all.
 *
 * That is D18's exact shape — a builder that produces nothing and reports
 * success — arriving inside the script that exists to catch such things. It was
 * only caught because the test step afterwards could not find `dist`.
 */
const isBuildState = (name) => name.endsWith(".tsbuildinfo");

const work = mkdtempSync(join(tmpdir(), "sutra-core-alone-"));
let failed = false;

function run(cmd, args, cwd) {
  process.stdout.write(`  $ ${cmd} ${args.join(" ")}\n`);
  execFileSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
}

try {
  console.log(`core-alone: staging a copy at ${work}`);
  for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
    if (SKIP.has(entry.name) || isBuildState(entry.name)) continue;
    cpSync(join(ROOT, entry.name), join(work, entry.name), {
      recursive: true,
      filter: (src) => {
        const name = src.split(/[\\/]/).pop();
        return !SKIP.has(name) && !isBuildState(name);
      },
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

  // D18 · ASSERT THE BUILDER ACTUALLY PRODUCED SOMETHING.
  //
  // A build that emits nothing and exits 0 is indistinguishable from a build
  // that succeeded, and that is precisely how this script itself was broken:
  // a stale `.tsbuildinfo` travelled with the copy, tsc decided everything was
  // up to date, emitted no output, and reported success. It surfaced only
  // because the test step afterwards could not find `dist`.
  //
  // So the check now asks the question directly rather than inferring it.
  for (const pkg of ["core", "mcp", "cli"]) {
    const dist = join(work, "packages", pkg, "dist");
    if (!existsSync(dist) || readdirSync(dist).length === 0) {
      console.error(
        `\ncore-alone: FAIL — the build reported success but emitted nothing into packages/${pkg}/dist.\n` +
        `  A build that produces no output and exits 0 is indistinguishable from one that worked.\n` +
        `  Usual cause: stale build state (a .tsbuildinfo) travelled with the staged copy.`,
      );
      failed = true;
    }
  }
  if (failed) throw new Error("build emitted no output");

  run("npm", ["test"], work);

  // A build can succeed while a stale import string survives in source. Grep for
  // any reference back into the deleted subtree.
  // Patterns are passed as ARGV, never interpolated into a shell string: the
  // regex contains quotes, parentheses and backslashes, and letting a shell see
  // them produced a spurious `'require' is not recognized as a command` on
  // Windows — a check that errors for its own quoting reasons is a check people
  // learn to ignore.
  const offenders = [];
  const patterns = [
    "from ['\"](\\.\\./)*ee/",
    "require\\(['\"](\\.\\./)*ee/",
    "@sutra/ee",
  ];
  for (const pattern of patterns) {
    try {
      const out = execFileSync(
        "git",
        ["grep", "-n", "-E", pattern, "--", "packages", "vault-template", "automation", "plugins", "skills", "tests"],
        { cwd: ROOT, encoding: "utf8" },
      );
      if (out.trim()) offenders.push(out.trim());
    } catch {
      // git grep exits 1 on no matches — that is the passing case.
    }
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
