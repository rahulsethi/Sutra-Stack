// SPDX-License-Identifier: Apache-2.0
/**
 * D7 · `leak/ignore-supersession` — AN IGNORE FILE IS AN EGRESS SURFACE.
 *
 * When `.easignore` exists, EAS uses it **instead of** `.gitignore` — not in
 * addition to it. The upstream `.easignore` excluded three directories but not
 * five credential-bearing files, so **every app build uploaded all five** to a
 * third-party build service.
 *
 * ── WHY IT HID ─────────────────────────────────────────────────────────────
 * Gitignoring the files felt like protection, and it *was* — for git. The
 * supersession is documented by the tool, not by the repo, and no test ever
 * asked the only question that mattered: **"what does the UPLOADER see?"**
 *
 * ── THE RULE THIS ENFORCES ─────────────────────────────────────────────────
 * Treat every ignore-like file as a **separate egress surface with its own
 * rules**, and answer the question **EMPIRICALLY** — replay the ruleset through
 * that tool's own engine rather than reasoning about what it probably does.
 *
 * For git, that means asking git. The live method below is the one the upstream
 * remediation used: build the effective file set in an isolated repo and assert
 * no secret-shaped path survives.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
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
  throw new Error("could not locate the repo root — this test would otherwise check nothing and pass");
}

const ROOT = findRepoRoot();

/** Every ignore-like file, and which tool it governs. */
const IGNORE_SURFACES: Array<{ file: string; tool: string; supersedesGitignore: boolean }> = [
  { file: ".gitignore", tool: "git", supersedesGitignore: false },
  { file: ".npmignore", tool: "npm pack / publish", supersedesGitignore: true },
  { file: ".dockerignore", tool: "docker build", supersedesGitignore: true },
  { file: ".vercelignore", tool: "vercel deploy", supersedesGitignore: true },
  { file: ".easignore", tool: "EAS build upload", supersedesGitignore: true },
];

// ─────────────────────────────────────────────────────────────────────────────
// 1 · Which surfaces exist at all
// ─────────────────────────────────────────────────────────────────────────────

test("D7 · every ignore-like file present is a KNOWN surface with a test", () => {
  // The failure mode is someone adding `.npmignore` for a good reason and not
  // realising it silently replaces `.gitignore` for `npm publish`.
  const present = IGNORE_SURFACES.filter((s) => existsSync(join(ROOT, s.file)));
  assert.ok(present.some((s) => s.file === ".gitignore"), "no .gitignore — that cannot be right");

  const superseding = present.filter((s) => s.supersedesGitignore);
  assert.deepEqual(
    superseding.map((s) => s.file),
    [],
    "AN IGNORE FILE THAT SUPERSEDES .gitignore IS PRESENT:\n" +
    superseding.map((s) => `  ${s.file} — governs ${s.tool}, and REPLACES .gitignore for it`).join("\n") +
    "\n\nThat is a separate egress surface. Extend this test to replay ITS ruleset through ITS tool's " +
    "engine and assert no secret-shaped path survives. `.easignore` did exactly this upstream and " +
    "shipped five credential files on every build.",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 · The empirical check — ask git what git would ship
// ─────────────────────────────────────────────────────────────────────────────

/** Paths that must never appear in any shipped file set. */
const SECRET_SHAPED = [
  /(^|\/)Keys\.md$/i,
  /(^|\/)[^/]*\.local\.(md|json|ya?ml|toml|js|ts)$/i,
  /(^|\/)secrets(\/|$)/i,
  /(^|\/)state\/secrets(\/|$)/i,
  /\.age$/i,
  /\.pem$/i,
  /(^|\/)\.env($|\.)/i,
  /(^|\/)id_(rsa|ed25519)/i,
  /(^|\/)override\.key$/i,
];

test("D7 · nothing secret-shaped is TRACKED — asked of git, not reasoned about", () => {
  // "What would ship" is a property of the REPOSITORY, so it can only be asked
  // where there is one. `check-core-alone` stages a COPY of the tree without
  // `.git`, deliberately — and in that context this question has no meaning
  // rather than a failing answer.
  //
  // The skip is STATED, not silent. A test that quietly does nothing is
  // indistinguishable from one that passed, which is this repo's whole thesis.
  let tracked: string[];
  try {
    tracked = execFileSync("git", ["ls-files", "-z"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64e6,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\0")
      .filter(Boolean);
  } catch {
    console.log("    (skipped — not a git repository; this asks what GIT would ship)");
    return;
  }

  if (tracked.length === 0) {
    console.log("    (skipped — no tracked files; this is a staged copy, not the repo)");
    return;
  }

  assert.ok(tracked.length > 50, "git reported almost no files — the query is wrong, not the repo");

  const offenders = tracked.filter((p) => SECRET_SHAPED.some((re) => re.test(p)));
  assert.deepEqual(
    offenders,
    [],
    "SECRET-SHAPED PATH(S) ARE TRACKED and would ship in every clone:\n" + offenders.join("\n"),
  );
});

test("D7 · the check actually fires — planted, in an isolated repo", () => {
  // The upstream remediation's own method: replay the ruleset through git's
  // engine in an isolated repo. Doing it here proves the assertion above can
  // fail, rather than passing because the pattern list matches nothing.
  const dir = mkdtempSync(join(tmpdir(), "sutra-ignore-"));
  const run = (...args: string[]): string =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" });

  run("init", "-q");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "test");

  // A repo whose .gitignore does NOT cover the credential file — the exact
  // upstream situation, where the ignore rules looked comprehensive.
  mkdirSync(join(dir, "app"), { recursive: true });
  writeFileSync(join(dir, ".gitignore"), "node_modules/\ndist/\n");
  writeFileSync(join(dir, "Keys.md"), "placeholder\n");
  writeFileSync(join(dir, "app", "config.local.json"), "{}\n");
  writeFileSync(join(dir, "app", "main.ts"), "export const ok = 1;\n");

  run("add", "-A");
  const tracked = run("ls-files", "-z").split("\0").filter(Boolean);

  const caught = tracked.filter((p) => SECRET_SHAPED.some((re) => re.test(p)));
  assert.ok(
    caught.length >= 2,
    "the pattern list did not catch a planted Keys.md and config.local.json — a clean result from " +
    "it would therefore prove nothing. Caught: " + JSON.stringify(caught),
  );
  assert.ok(tracked.includes("app/main.ts"), "the check should not flag ordinary source");
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 · The .gitignore rules that must not be relaxed
// ─────────────────────────────────────────────────────────────────────────────

test("D7 · the secret-shaped ignore rules are still present", () => {
  const gi = readFileSync(join(ROOT, ".gitignore"), "utf8");
  for (const rule of ["Keys.md", "**/secrets/**", "*.age", "*.pem", ".env"]) {
    assert.ok(gi.includes(rule), `.gitignore no longer excludes ${rule}`);
  }
});

test("I19/D36 · .gitignore does NOT exclude a builder's INPUT", () => {
  // The counter-rule, and the one that is easy to get backwards: over-ignoring
  // is also a defect. The upstream knowledge graph was a pure function of a
  // batch store that .gitignore excluded, so the graph was unreproducible off
  // one laptop while looking safely version-controlled.
  const gi = readFileSync(join(ROOT, ".gitignore"), "utf8");

  // Only paths that EXIST in this repo. `graph/batches` is a vault path, not a
  // repo path — asserting on it here would be checking the wrong tree.
  for (const inputPath of ["tests/fixtures", "vault-template", "automation/policies"]) {
    // `git check-ignore -q` exits 1 — and therefore THROWS — when a path is NOT
    // ignored, which is the passing case. Catching is the assertion.
    let ignored = false;
    try {
      execFileSync("git", ["check-ignore", "-q", inputPath], { cwd: ROOT, stdio: "ignore" });
      ignored = true;
    } catch {
      ignored = false;
    }

    assert.equal(
      ignored,
      false,
      `.gitignore EXCLUDES ${inputPath}, which is a builder's input. I19/D36: if an artifact is a ` +
      `pure function of an input, the INPUT is the thing you must not lose — committing only the ` +
      `output is a backup illusion, and it made the upstream graph unreproducible off one laptop.`,
    );
  }

  // The header carries the rule so the next person editing that file reads it.
  assert.match(gi, /NEVER add an ignore rule that covers a builder's \*input\* directory/i);
});
