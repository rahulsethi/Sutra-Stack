// SPDX-License-Identifier: Apache-2.0
/**
 * §9.1 · "CREATED ≠ WIRED" — the most repeated failure in the upstream project.
 *
 * A timer installed but never enabled. A script with no scheduler. A config
 * applier superseded but still present. Thirteen dashboard routes unreachable
 * from the dashboard's own navigation. Each looked like working machinery, and
 * each did nothing.
 *
 * Its twin, D28: **"run ≠ scheduled"** — the script that produced 71% of the
 * upstream corpus was never scheduled. It ran ONCE, BY HAND, with a truncation
 * bug in it.
 *
 * The rule: **after every build step, grep for the CALLER, not the file.**
 * That is what this test does, mechanically, on every commit — because "I
 * checked" does not survive the next contributor.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative, sep, dirname, basename } from "node:path";
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
const SKIP = new Set(["node_modules", ".git", "dist", "coverage", ".sutra", "docs"]);

function* files(dir: string, ext: RegExp): Generator<string> {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) yield* files(abs, ext);
    else if (ext.test(e.name)) yield abs;
  }
}

const rel = (abs: string): string => relative(ROOT, abs).split(sep).join("/");

/** Everything a caller could be written in. */
function allText(): string {
  const parts: string[] = [];
  for (const abs of files(ROOT, /\.(ts|mts|js|mjs|ps1|psm1|json|ya?ml|md|sh)$/)) {
    // A file cannot be its own caller.
    parts.push(`\n@@FILE:${rel(abs)}@@\n` + readFileSync(abs, "utf8"));
  }
  return parts.join("\n");
}

const CORPUS = allText();

/** Is `name` referenced anywhere OTHER than inside the file itself? */
function hasExternalCaller(scriptRel: string, name: string): boolean {
  const chunks = CORPUS.split(/\n@@FILE:([^@]+)@@\n/);
  // chunks: [pre, path1, body1, path2, body2, ...]
  for (let i = 1; i < chunks.length; i += 2) {
    const path = chunks[i]!;
    const body = chunks[i + 1] ?? "";
    if (path === scriptRel) continue;
    if (body.includes(name)) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Every pipeline script has a caller
// ─────────────────────────────────────────────────────────────────────────────

test("§9.1 · every automation script has a CALLER somewhere else in the tree", () => {
  const orphans: string[] = [];

  for (const abs of files(join(ROOT, "automation", "scripts"), /\.ps1$/)) {
    const r = rel(abs);
    if (/\.test\.ps1$/.test(r)) continue; // a test is run by the test runner

    const name = basename(abs);
    if (!hasExternalCaller(r, name)) orphans.push(r);
  }

  assert.deepEqual(
    orphans,
    [],
    "SCRIPT(S) WITH NO CALLER.\n\n" +
    "This is the single most repeated failure in the system Sutra was extracted from: machinery that\n" +
    "exists, looks correct, is referenced in the docs, and never runs. A timer installed but never\n" +
    "enabled; a script with no scheduler; a config applier superseded but still present.\n\n" +
    "Either wire it, or delete it. An unwired script is worse than no script, because it carries the\n" +
    "belief that the thing it does is being done.\n\n" +
    orphans.join("\n"),
  );
});

test("§9.1 · the orphan check actually fires — planted", () => {
  // A guardrail never seen to fail is not evidence.
  // The name is generated, not written literally: a literal would appear in
  // THIS file and the check would find itself, reporting a caller for a script
  // that does not exist. The first version of this control did exactly that.
  const absent = "no-such-script-" + Math.random().toString(36).slice(2) + ".ps1";
  assert.equal(
    hasExternalCaller("automation/scripts/" + absent, absent),
    false,
    "the caller check reports a caller for a script that does not exist — it would pass on anything",
  );
  // …and the positive control, so it cannot pass by finding nothing ever.
  assert.equal(
    hasExternalCaller("automation/scripts/ingest.ps1", "ingest.ps1"),
    true,
    "ingest.ps1 has a caller (daily.ps1 and the CLI) but the check cannot see it",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// D28 · run ≠ scheduled
// ─────────────────────────────────────────────────────────────────────────────

test("D28 · every CONTENT-PRODUCING script is reachable from the orchestrator", () => {
  // The script that produced 71% of the upstream corpus was never scheduled. It
  // ran once, by hand, with a truncation bug in it — and nothing in the system
  // could tell you that the corpus came from an unscheduled hand-run.
  const daily = readFileSync(join(ROOT, "automation/scripts/orchestrator/daily.ps1"), "utf8");
  const producers = ["ingest.ps1", "auto-compile.ps1", "graph-export.ps1", "refresh-index.ps1"];

  for (const p of producers) {
    assert.ok(
      daily.includes(p),
      `${p} produces durable content but is not in daily.ps1's stage list. ` +
      `A content producer must be SCHEDULED or explicitly marked interactive — "run once by hand" ` +
      `is how a truncation bug reached 424 pages.`,
    );
  }
});

test("D28 · the CLI exposes every pipeline verb, so nothing is hand-run-only", () => {
  const pipeline = readFileSync(join(ROOT, "packages/cli/src/commands/pipeline.ts"), "utf8");

  // An object key is quoted only when it has to be (a hyphen or a space), so
  // check BOTH forms. The first version of this test assumed quotes and failed
  // on `ingest:` — a check that is wrong about its own subject's syntax is a
  // check that gets deleted rather than fixed.
  for (const verb of ["ingest", "daily", "refresh-index", "hygiene", "graph export"]) {
    const bare = `${verb}: {`;
    const quoted = `"${verb}": {`;
    assert.ok(
      pipeline.includes(bare) || pipeline.includes(quoted),
      `the CLI does not expose \`sutra ${verb}\` — it is declared nowhere in the PIPELINE table`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// D29 · a surface must be reachable from its own navigation
// ─────────────────────────────────────────────────────────────────────────────

test("D29 · every dashboard route is reachable from the dashboard's own navigation", () => {
  // The upstream run manifest was unreachable BY CONSTRUCTION: `last-run` was
  // missing from a four-name allowlist, so the UI linked to something its own
  // API would never return. Thirteen more routes had no nav entry at all.
  const dash = join(ROOT, "packages/dashboard/src/index.ts");
  if (!existsSync(dash)) return; // shape (c) is optional
  const text = readFileSync(dash, "utf8");

  const routes = [...text.matchAll(/\{\s*path:\s*"([^"]+)",\s*navLabel:\s*"([^"]*)"/g)];
  assert.ok(routes.length > 0, "no routes found — the parser has drifted from the route table");
  for (const [, path, label] of routes) {
    assert.ok(label!.length > 0, `route ${path} has no nav label, so nothing links to it`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Every declared npm script exists
// ─────────────────────────────────────────────────────────────────────────────

test("§9.1 · every npm script's target file exists", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  const missing: string[] = [];

  for (const [name, cmd] of Object.entries(pkg.scripts)) {
    for (const m of cmd.matchAll(/\b(scripts\/[\w.-]+\.mjs)/g)) {
      if (!existsSync(join(ROOT, m[1]!))) missing.push(`${name} -> ${m[1]}`);
    }
  }
  assert.deepEqual(missing, [],
    "npm script(s) point at files that do not exist. A declared job with no realised target is I11.\n" +
    missing.join("\n"));
});

test("§9.1 · every pipeline verb the CLI ADVERTISES has a script that exists", () => {
  // The converse of the orphan check, and the gap it left: that one asks
  // "does every script have a caller?", this asks "does every caller have a
  // script?". A verb advertised in `sutra --help` that cannot run is the same
  // defect wearing the other face — and it was real: `sutra backup` was
  // declared in the PIPELINE table with no `backup.ps1` behind it.
  const pipeline = readFileSync(join(ROOT, "packages/cli/src/commands/pipeline.ts"), "utf8");
  const declared = [...pipeline.matchAll(/script:\s*"([^"]+)"/g)].map((m) => m[1]!);
  assert.ok(declared.length >= 5, "the PIPELINE table parser has drifted — found too few scripts");

  const missing = declared.filter((s) => !existsSync(join(ROOT, s)));
  assert.deepEqual(
    missing,
    [],
    "The CLI advertises pipeline verb(s) whose script does not exist:\n" +
    missing.join("\n") +
    "\n\nEither write the script or remove the verb. `runPipelineVerb` degrades honestly " +
    "(skipped-policy, 'not present in this install'), but a command in `sutra --help` that can " +
    "never do anything is still created-not-wired.",
  );
});
