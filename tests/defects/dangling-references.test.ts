// SPDX-License-Identifier: Apache-2.0
/**
 * §9.1, THE OTHER FACE — a reference to something that does not exist.
 *
 * `created-not-wired.test.ts` asks *"does everything that exists have a
 * caller?"*. This asks the converse: **"does everything that is REFERENCED
 * exist?"** — and the converse is where this build actually leaked.
 *
 * Three real instances, all found after the fact:
 *
 *   - `packages/core/src/persona/` was created at M0 and never filled. The
 *     brief's extraction manifest says LIFT; the directory sat empty for the
 *     whole build, and nothing noticed because **git does not track empty
 *     directories** — so it was invisible in every clone and every diff.
 *   - `scanner_exempt_paths` named `tests/fixtures/planted-secrets.md`, which
 *     did not exist. An exemption for a non-existent file is dead config, and
 *     dead config in a *scanner* is the kind that gets copied forward.
 *   - `leak-scan.mjs`'s own warning told the reader to add a case to
 *     `tests/leak/ignore-supersession.test.ts` — a file nobody had written.
 *
 * None of these broke anything. That is precisely why they need a test: a
 * dangling reference is a promise the code makes and does not keep, and it is
 * discovered by the person who followed it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
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
  throw new Error("could not locate the repo root — this test would otherwise check nothing and pass");
}

const ROOT = findRepoRoot();

/**
 * Is the commercial subtree present?
 *
 * IT MAY NOT BE, and that is a supported configuration — `rm -rf ee/` leaves a
 * complete Apache-2.0 product, and `check-core-alone` proves it on every commit
 * by deleting the subtree and running THIS SUITE.
 *
 * So no test here may assume `ee/` exists. The first version of this file did,
 * and the M0 gate caught it immediately: a test that fails in the open-source
 * build is a test that makes the open-source build look broken.
 */
const HAS_EE = existsSync(join(ROOT, "ee"));

// ─────────────────────────────────────────────────────────────────────────────
// 1 · Every source directory the build compiles has something in it
// ─────────────────────────────────────────────────────────────────────────────

test("§9.1 · no EMPTY source directory — a scaffolded dir nobody filled", () => {
  // The failure this catches is specific and was real: git does not track empty
  // directories, so a scaffolded-and-forgotten one is invisible in a clone, in
  // a diff, and in a file count. It shows up only when someone goes looking for
  // the thing the repo map promised is there.
  const roots = ["packages/core/src", "packages/mcp/src", "packages/cli/src", "ee/src"];
  const empty: string[] = [];

  const walk = (abs: string, rel: string): void => {
    let entries;
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    const dirs = entries.filter((e) => e.isDirectory());
    const files = entries.filter((e) => e.isFile());
    if (dirs.length === 0 && files.length === 0) { empty.push(rel); return; }
    for (const d of dirs) walk(join(abs, d.name), `${rel}/${d.name}`);
  };

  for (const r of roots) {
    const abs = join(ROOT, r);
    if (existsSync(abs)) walk(abs, r);
  }

  assert.deepEqual(
    empty,
    [],
    "EMPTY SOURCE DIRECTORY/IES:\n" + empty.join("\n") +
    "\n\nEither fill it or delete it. Git does not track empty directories, so this is invisible in a " +
    "clone — `packages/core/src/persona/` sat empty for an entire build for exactly that reason, " +
    "while the repo map claimed it held the persona layer.",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 · Every path named in a governance file exists
// ─────────────────────────────────────────────────────────────────────────────

test("§9.1 · every scanner_exempt_path actually exists", () => {
  // A scanner exemption for a file that does not exist is dead config. Worse
  // than merely useless: an exemption list is exactly the thing a reader trusts
  // without checking, and one stale entry makes the whole list look maintained.
  const patterns = JSON.parse(
    readFileSync(join(ROOT, "automation/policies/secret-patterns.json"), "utf8"),
  ) as { scanner_exempt_paths?: string[] };

  const declared = patterns.scanner_exempt_paths ?? [];
  assert.ok(declared.length > 0, "the exempt list is empty — the parser has drifted");

  const missing = declared.filter((p) => !existsSync(join(ROOT, p)));
  assert.deepEqual(
    missing,
    [],
    "scanner_exempt_paths names file(s) that do not exist:\n" + missing.join("\n") +
    "\n\nRemove them, or write them. A stale entry makes the whole list look maintained.",
  );
});

test("§9.1 · every file a remedy message tells you to edit exists", () => {
  // A guard whose message says "add a case to X" and X does not exist teaches
  // the reader that the guard's advice is not to be followed.
  const sources = [
    "scripts/leak-scan.mjs",
    "scripts/check-license-headers.mjs",
    "scripts/check-diagrams.mjs",
    "scripts/check-core-alone.mjs",
  ];
  const missing: string[] = [];

  for (const rel of sources) {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) continue;
    const text = readFileSync(abs, "utf8");
    // CODE paths only. `automation/policies/exposure-*.json` and
    // `automation/config/redaction-aliases.json` are VAULT-relative — they live
    // in the user's vault, not in this repo, and the scanners already guard them
    // with `existsSync`. Flagging those would make this check wrong about its
    // own subject, which is how a check gets deleted rather than fixed.
    for (const m of text.matchAll(/\b((?:tests|scripts|packages|ee)\/[\w./-]+\.(?:ts|mjs|js|json|ps1|md))\b/g)) {
      const p = m[1]!;
      if (p.includes("*")) continue;
      if (!HAS_EE && p.startsWith("ee/")) continue;   // the Apache-only build
      if (!existsSync(join(ROOT, p)) && !missing.includes(`${rel} → ${p}`)) {
        missing.push(`${rel} → ${p}`);
      }
    }
  }

  assert.deepEqual(
    missing,
    [],
    "A guard names a file that does not exist:\n" + missing.join("\n") +
    "\n\nA message that says 'add a case to X' when X is absent teaches the reader that the guard's " +
    "advice need not be followed.",
  );
});

test("§9.1 · every file a SOURCE COMMENT cites exists", () => {
  // Added after this class bit twice in one module. `redact.ts` claimed to be
  // the "TypeScript twin of `automation/scripts/lib/Redact.ps1`" with "the
  // parity test as the contract", and separately cited
  // `Get-SensitiveNumberPatterns` in `Classify.ps1`. NONE of the three existed.
  //
  // A citation to a file that is not there is worse than no citation: it
  // asserts a check nobody runs, in the register a reader trusts most. The
  // earlier version of this test scanned only `scripts/`, which is exactly why
  // both survived a whole build.
  const roots = ["packages/core/src", "packages/mcp/src", "packages/cli/src", "automation/scripts", "ee/src"];
  const missing: string[] = [];

  const walk = (abs: string): void => {
    let entries;
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(abs, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(ts|mts|ps1)$/.test(e.name)) continue;

      const text = readFileSync(p, "utf8");
      for (const m of text.matchAll(
        /`((?:packages|automation|scripts|tests|ee|vault-template|plugins)\/[\w./-]+\.(?:ts|mts|js|mjs|json|ps1|py|md))`/g,
      )) {
        const cited = m[1]!;
        if (cited.includes("*")) continue;
        if (!HAS_EE && cited.startsWith("ee/")) continue;
        // VAULT-RELATIVE, or ASSERTED ABSENT. `redaction-aliases.json` is a list
        // of real client names and `exposure-allowlist.json` names specific
        // notes; both live in the USER's vault, and the leak scan's job is to
        // assert they are not in THIS repo. Flagging them here would make the
        // check wrong about its own subject, which is how a check gets deleted
        // rather than fixed.
        if (/^automation\/(config|policies\/exposure-)/.test(cited)) continue;
        // A `.js` citation from TypeScript is an ESM import specifier for a
        // `.ts` source — resolve it the way NodeNext does.
        const candidates = [cited, cited.replace(/\.js$/, ".ts")];
        if (candidates.some((c) => existsSync(join(ROOT, c)))) continue;
        const entry = `${p.slice(ROOT.length + 1).replace(/\\/g, "/")} → ${cited}`;
        if (!missing.includes(entry)) missing.push(entry);
      }
    }
  };

  for (const r of roots) {
    const abs = join(ROOT, r);
    if (existsSync(abs)) walk(abs);
  }

  assert.deepEqual(
    missing,
    [],
    "A SOURCE COMMENT CITES A FILE THAT DOES NOT EXIST:\n" + missing.join("\n") +
    "\n\nEither write it or stop citing it. A cited-but-absent twin implies a parity check that " +
    "nobody is running, which is the most expensive kind of comment to be wrong.",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 · The repo map in CLAUDE.md matches the tree
// ─────────────────────────────────────────────────────────────────────────────

test("§9.1 · every directory CLAUDE.md's repo map claims exists, exists", () => {
  // The repo map is the first thing an agent reads. A map that names a
  // directory the tree does not have sends every future contributor looking for
  // something that is not there.
  const text = readFileSync(join(ROOT, "CLAUDE.md"), "utf8");
  const start = text.indexOf("## 4 · Repository map");
  assert.ok(start > 0, "the repo map section has been renamed — this test is now checking nothing");

  const block = text.slice(start, text.indexOf("### Where the important things live", start));
  const missing: string[] = [];

  for (const m of block.matchAll(/^([a-z][\w./-]*\/)\s{2,}/gm)) {
    const p = m[1]!;
    // `ee/` is legitimately absent in the Apache-only build. The map documents
    // it because it exists in the full distribution.
    if (!HAS_EE && p.startsWith("ee/")) continue;
    const abs = join(ROOT, p);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) missing.push(p);
  }

  assert.deepEqual(
    missing,
    [],
    "CLAUDE.md's repo map names director(ies) that do not exist:\n" + missing.join("\n"),
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 4 · M8's verify — every doc links to something that exists
// ─────────────────────────────────────────────────────────────────────────────

test("M8 · every relative link in a shipped doc resolves", () => {
  // "Every doc links to something that exists" is M8's verify, and it is the
  // kind of thing that is true on the day it is written and false a week later.
  //
  // Links are resolved relative to the FILE, not the repo root. `ee/README.md`
  // linking `../CONTRIBUTING.md` is correct; resolving that from the root would
  // report a false miss, and a link checker that cries wolf gets switched off.
  const docs = [
    "README.md", "CONTRIBUTING.md", "CLAUDE.md", "AGENTS.md", "llms.txt",
    "INHERITED-DEFECTS.md", "ee/README.md",
    "Master_documentation/00-START-HERE.md",
    "Master_documentation/SECURITY.md",
  ];
  const broken: string[] = [];

  for (const doc of docs) {
    if (!HAS_EE && doc.startsWith("ee/")) continue;   // the Apache-only build
    const abs = join(ROOT, doc);
    if (!existsSync(abs)) { broken.push(`${doc} — the doc itself is missing`); continue; }
    const text = readFileSync(abs, "utf8");

    for (const m of text.matchAll(/\]\(([^)]+)\)/g)) {
      const target = m[1]!;
      if (/^(https?:|mailto:|#)/.test(target)) continue;      // external or anchor
      const clean = target.split("#")[0]!;                     // drop any anchor
      if (clean === "") continue;
      // A link INTO `ee/` is correct in the full distribution and dangling in
      // the Apache-only build. The docs describe both, so the link stays and
      // this check skips it when the subtree is absent.
      if (!HAS_EE && clean.replace(/^\.\//, "").startsWith("ee/")) continue;
      const resolved = join(dirname(abs), clean);
      if (!existsSync(resolved)) broken.push(`${doc} → ${target}`);
    }
  }

  assert.deepEqual(
    broken,
    [],
    "BROKEN RELATIVE LINK(S) in shipped docs:\n" + broken.join("\n") +
    "\n\nM8's verify is 'every doc links to something that exists'. A link that goes nowhere is a " +
    "promise the doc makes and does not keep, discovered by the person who followed it.",
  );
});

test("M8 · the link check actually fires — planted", () => {
  // A guardrail never seen to fail is not evidence.
  const doc = join(ROOT, "README.md");
  const fake = "does-not-exist-" + Math.random().toString(36).slice(2) + ".md";
  assert.equal(existsSync(join(dirname(doc), fake)), false,
    "the resolver reports a file that cannot exist — it would pass on anything");
  // …and the positive control: a link the README really does make.
  assert.equal(existsSync(join(dirname(doc), "CONTRIBUTING.md")), true);
});
