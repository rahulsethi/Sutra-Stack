// SPDX-License-Identifier: Apache-2.0
/**
 * Run EVERY PowerShell test in the tree.
 *
 * ── WHY THIS IS A DISCOVERY RUNNER AND NOT A LIST ──────────────────────────
 * It used to be a list — two paths, hardcoded in the CI workflow. Then four more
 * `*.test.ps1` files were written, and none of them ran anywhere. That is
 * "created ≠ wired", which is the single most repeated failure in the project
 * this codebase was extracted from: a timer installed and never enabled, a
 * script with no scheduler, thirteen dashboard routes unreachable from the
 * dashboard's own navigation.
 *
 * A hardcoded list of tests has the same shape as all of those. It requires
 * someone to remember, the cost of forgetting is invisible (the suite still
 * passes, just over less), and the failure is discovered — if ever — long after
 * the commit that caused it.
 *
 * So: glob, run everything found, and REFUSE TO PASS ON AN EMPTY SET.
 *
 * ── THE FLOOR ──────────────────────────────────────────────────────────────
 * `MINIMUM_SUITES` is the anti-regression guard for the runner itself. A glob
 * that matches nothing exits 0 and looks exactly like a green suite — the same
 * defect class as D18's builder pointed at a directory that does not exist. If
 * you legitimately remove a suite, lower the number in the same commit and say
 * why.
 */

import { readdirSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Lower this only when deliberately removing a suite, in the same commit. */
const MINIMUM_SUITES = 4;

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", ".sutra"]);

/** Every `*.test.ps1` under the repo, sorted so the run order is stable. */
function discover() {
  const found = [];
  const walk = (abs) => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const p = join(abs, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".test.ps1")) found.push(p);
    }
  };
  for (const r of ["automation", "packages", "ee", "scripts"]) {
    const abs = join(ROOT, r);
    if (existsSync(abs)) walk(abs);
  }
  return found.sort();
}

/** Is `pwsh` available? On a machine without it, say so — do not pass quietly. */
function pwshAvailable() {
  const probe = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore" });
  return probe.status === 0;
}

const suites = discover();

if (suites.length < MINIMUM_SUITES) {
  console.error(
    `\nFOUND ONLY ${suites.length} PowerShell test suite(s); the floor is ${MINIMUM_SUITES}.\n\n` +
    (suites.length === 0
      ? "The glob matched nothing. An empty run exits 0 and is indistinguishable from a green suite.\n"
      : `Found:\n${suites.map((s) => "  " + relative(ROOT, s)).join("\n")}\n`) +
    "\nEither a suite was deleted or renamed out of the `*.test.ps1` pattern. If the removal is\n" +
    "deliberate, lower MINIMUM_SUITES in this file in the same commit and say why.\n",
  );
  process.exit(1);
}

if (!pwshAvailable()) {
  // NOT a pass. The PS bindings are half the policy engine — the classifier
  // parity test is the only thing asserting the two implementations of one rule
  // agree, and E1 exists because divergence "fails open in at least one of
  // them". Skipping that silently is the worst available outcome.
  console.error(
    "\n`pwsh` (PowerShell 7) is not on PATH, so the PowerShell suite CANNOT RUN.\n\n" +
    "This is reported as a FAILURE, not a skip. These suites include the only assertion that the\n" +
    "PowerShell and TypeScript classifiers agree on an identical corpus, and a rule that exists in\n" +
    "only one language is a rule that does not exist on the paths written in the other.\n\n" +
    "Install PowerShell 7:  https://aka.ms/powershell\n" +
    "Or run the TS suite alone, knowingly:  npm test\n",
  );
  process.exit(1);
}

console.log(`\nPowerShell suites (${suites.length} discovered):\n`);

let failed = 0;
const results = [];

for (const suite of suites) {
  const rel = relative(ROOT, suite).replace(/\\/g, "/");
  console.log(`══ ${rel}`);
  const r = spawnSync("pwsh", ["-NoProfile", "-File", suite], { stdio: "inherit", cwd: ROOT });
  const ok = r.status === 0;
  if (!ok) failed++;
  results.push({ rel, ok, status: r.status });
  console.log("");
}

console.log("─".repeat(70));
for (const r of results) console.log(`${r.ok ? "  ok  " : "  FAIL"}  ${r.rel}${r.ok ? "" : ` (exit ${r.status})`}`);
console.log("─".repeat(70));

if (failed > 0) {
  console.error(`\n${failed} of ${suites.length} PowerShell suite(s) FAILED.\n`);
  process.exit(1);
}
console.log(`\nAll ${suites.length} PowerShell suites passed.\n`);
