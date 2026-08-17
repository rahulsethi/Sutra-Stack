// SPDX-License-Identifier: Apache-2.0
/**
 * D25 · `vault/reconcile-is-safe` — WHERE THE OBVIOUS REMEDY IS THE FAILURE MODE.
 *
 * `git submodule update --init --recursive` **always** aborts on a node whose
 * vault working tree is dirty — which is every node that runs the pipeline,
 * because the pipeline is what dirties it.
 *
 * Git is *protecting* you. But the message reads as an obstacle, and every
 * search result for it suggests `checkout -f`, `reset --hard`, or `clean -fd` —
 * which are the **only** way to lose data here. The trap is that the reflexive
 * fix is the defect.
 *
 * ── WHAT THIS FILE CAN AND CANNOT ASSERT ───────────────────────────────────
 * D25's full specification describes a safe `sutra vault reconcile` verb:
 * snapshot tracked AND untracked onto a timestamped rescue branch, sync,
 * restore only real captures, upstream wins on conflict, keep the branch as the
 * undo. **That verb is deferred** — see `Master_documentation/12-deferred/`.
 *
 * So this file asserts the half that is enforceable today, and it is the half
 * that actually destroys data: **no code path in this product runs a
 * destructive git command.** Plus the inverse of created-≠-wired — that the
 * unbuilt verb is not advertised as though it existed, because a user who
 * believes `sutra vault reconcile` exists and finds it does not is a user
 * reaching for `reset --hard` under pressure.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string };
      if (pkg.name === "sutra") return dir;
    } catch { /* keep walking */ }
    dir = dirname(dir);
  }
  throw new Error("could not locate the repo root — this test would otherwise scan nothing and pass");
}

const ROOT = findRepoRoot();

/**
 * The commands that can lose a user's un-pushed work.
 *
 * Each is matched as a git INVOCATION, not as a bare phrase — `reset --hard`
 * appears in this file's own prose, in `INHERITED-DEFECTS.md`, and in several
 * doc comments explaining why it is forbidden. A scanner that flagged the
 * explanation would be turned off, and then it protects nothing (D6/D24).
 */
const DESTRUCTIVE: Array<{ label: string; pattern: RegExp; loses: string }> = [
  {
    label: "git reset --hard",
    pattern: /\bgit\s+(?:-{1,2}[\w-]+(?:[= ]\S+)?\s+)*reset\b[^\n]*--hard/,
    loses: "every uncommitted modification to a tracked file",
  },
  {
    label: "git checkout -f / --force",
    pattern: /\bgit\s+(?:-{1,2}[\w-]+(?:[= ]\S+)?\s+)*checkout\b[^\n]*(?:\s-f\b|--force)/,
    loses: "every uncommitted modification, silently",
  },
  {
    label: "git clean -fd",
    pattern: /\bgit\s+(?:-{1,2}[\w-]+(?:[= ]\S+)?\s+)*clean\b[^\n]*-[a-eg-z]*f/,
    loses: "EVERY UNTRACKED FILE — which is exactly where a fresh capture lives",
  },
  {
    label: "git restore --worktree without --source",
    pattern: /\bgit\s+restore\b[^\n]*--worktree/,
    loses: "uncommitted modifications (the modern spelling of checkout -f)",
  },
];

/** Every executable file in the product, with its repo-relative path. */
function executableSources(): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  const SKIP = new Set(["node_modules", ".git", "dist", "coverage", ".sutra", "docs", "graphify-out"]);

  const walk = (abs: string): void => {
    let entries;
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const p = join(abs, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(ps1|psm1|sh|bash|mjs|cjs|js|ts|mts|py|yml|yaml)$/.test(e.name)) continue;
      out.push({ path: p.slice(ROOT.length + 1).replace(/\\/g, "/"), text: readFileSync(p, "utf8") });
    }
  };

  for (const r of ["packages", "automation", "scripts", "plugins", "ee", ".githooks", ".github"]) {
    const abs = join(ROOT, r);
    if (existsSync(abs)) walk(abs);
  }
  return out;
}

/**
 * Strip comments and prose so the scan reads CODE.
 *
 * This is the part that decides whether the check survives contact: the reason
 * `reset --hard` is forbidden has to be written down SOMEWHERE, and the place it
 * belongs is next to the code that would otherwise use it.
 */
function codeOnly(text: string, path: string): string {
  let t = text;
  t = t.replace(/<#[\s\S]*?#>/g, " ");            // PowerShell block comments
  t = t.replace(/\/\*[\s\S]*?\*\//g, " ");        // C-style block comments
  t = t.replace(/^\s*#(?!!).*$/gm, " ");          // shell/PS/py line comments (keep shebangs)
  t = t.replace(/^\s*\/\/.*$/gm, " ");            // JS line comments
  t = t.replace(/^\s*\*.*$/gm, " ");              // JSDoc continuation lines
  if (/\.(yml|yaml)$/.test(path)) t = t.replace(/^\s*#.*$/gm, " ");
  return t;
}

// ─────────────────────────────────────────────────────────────────────────────

test("D25 · NO CODE PATH RUNS A DESTRUCTIVE GIT COMMAND", () => {
  const offenders: string[] = [];

  for (const { path, text } of executableSources()) {
    const code = codeOnly(text, path);
    for (const d of DESTRUCTIVE) {
      for (const line of code.split(/\r?\n/)) {
        if (d.pattern.test(line)) {
          offenders.push(`${path}\n    ${d.label} — loses ${d.loses}\n    ${line.trim().slice(0, 120)}`);
        }
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "A DESTRUCTIVE GIT COMMAND IS IN THE PRODUCT:\n\n" + offenders.join("\n\n") +
    "\n\nD25: these are the ONLY way to lose data during a vault reconcile, and they are what every " +
    "search result suggests when `git submodule update` aborts on a dirty tree. Snapshot to a rescue " +
    "branch instead — tracked AND untracked — then sync, then restore only real captures.",
  );
});

test("D25 · the scan actually fires — planted, in each shape", () => {
  // A guardrail never seen to fail is not evidence of anything. Each pattern is
  // shown catching the command it names.
  const planted: Array<[string, string]> = [
    ["git reset --hard", "  git reset --hard origin/main"],
    ["git reset --hard", "$out = git -C $VaultRoot reset --hard HEAD"],
    ["git checkout -f / --force", "git checkout -f main"],
    ["git checkout -f / --force", "git checkout --force -- ."],
    ["git clean -fd", "git clean -fd"],
    ["git clean -fd", "git clean -xfd -e node_modules"],
    ["git restore --worktree without --source", "git restore --worktree ."],
  ];

  for (const [label, line] of planted) {
    const d = DESTRUCTIVE.find((x) => x.label === label)!;
    assert.ok(d.pattern.test(line), `${label} did not match its own fixture: ${line}`);
  }
});

test("D25 · the scan does NOT fire on the safe forms, or on the prose", () => {
  // The counter-test, and the one that keeps the check installed. `reset --hard`
  // has to be explainable in a comment, and several safe git commands look
  // superficially similar.
  const safe = [
    "git stash push --include-untracked",
    "git checkout -b rescue/2026-08-17-1200",
    "git switch -c rescue-branch",
    "git clean --dry-run",
    "git reset --soft HEAD~1",
    "git restore --source=HEAD --staged file.md",
    "git ls-files -z",
    "git rev-parse --show-toplevel",
    "const tracked = execFileSync('git', ['ls-files', '-z'])",
  ];
  for (const line of safe) {
    for (const d of DESTRUCTIVE) {
      assert.equal(d.pattern.test(line), false, `${d.label} false-positived on a safe command: ${line}`);
    }
  }

  // …and the explanation of the rule is not itself a violation.
  const prose = "// Never run `git reset --hard` here — see D25. Snapshot first.";
  const stripped = codeOnly(prose, "x.ts");
  for (const d of DESTRUCTIVE) {
    assert.equal(d.pattern.test(stripped), false,
      "the scanner flagged a COMMENT explaining the rule — that is how a scanner gets deleted");
  }
});

test("D25 · the scan reads a real corpus, not an empty one", () => {
  // The failure this test class is most prone to: a walk that silently matches
  // nothing and reports a clean result.
  const sources = executableSources();
  assert.ok(sources.length > 30, `only ${sources.length} files scanned — the walk is wrong`);
  assert.ok(sources.some((s) => s.path.startsWith("automation/scripts/")), "no pipeline scripts scanned");
  assert.ok(sources.some((s) => s.path.endsWith(".ps1")), "no PowerShell scanned — that is where git runs");
  assert.ok(sources.some((s) => s.path.startsWith("packages/")), "no package sources scanned");
});

test("D25 · the DEFERRED reconcile verb is not advertised as existing", () => {
  // The inverse of created-≠-wired, and the reason it matters here specifically:
  // a user who believes `sutra vault reconcile` exists, tries it, and finds it
  // does not, is a user who then reaches for `reset --hard` under pressure.
  //
  // Either the verb exists and is routed, or it is not offered. Not both.
  const cliRoot = join(ROOT, "packages/cli/src");
  if (!existsSync(cliRoot)) return;

  const cliText: string[] = [];
  const walk = (abs: string): void => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const p = join(abs, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.ts$/.test(e.name) && !/\.test\./.test(e.name)) cliText.push(readFileSync(p, "utf8"));
    }
  };
  walk(cliRoot);
  const cli = cliText.join("\n");

  // Advertised = it appears in a user-facing command list or usage string.
  const advertised = /^\s*(?:"|')?(?:sutra\s+)?vault\s+reconcile\b/m.test(cli.replace(/\/\*[\s\S]*?\*\//g, " "));
  const routed = /case\s+["']reconcile["']|reconcile:\s*\(/.test(cli);

  assert.equal(
    advertised && !routed,
    false,
    "`sutra vault reconcile` is advertised in the CLI but not routed. D25's whole point is that a user " +
    "who cannot find the safe verb invents an unsafe one.",
  );
});
