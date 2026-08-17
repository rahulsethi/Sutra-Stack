// SPDX-License-Identifier: Apache-2.0
/**
 * I13 · THE SECRET FLOOR — and the import graph that keeps it absolute.
 *
 * Invariant 3: `local_only` content never reaches any LLM, hosted or
 * local-via-a-harness. Not under an override, not under a flag, not for
 * convenience, not for an administrator.
 *
 * The per-module tests already assert the floor holds where they can see it.
 * This file asserts the two things NO SINGLE MODULE CAN:
 *
 *   1. THE IMPORT GRAPH. `authorizeSecretEgress` is the only function in the
 *      product that can authorise rendering secret content. The guarantee is
 *      only as strong as the LIST OF ITS CALLERS — and no module can check its
 *      own caller list. If a cron job, a capability runner or an MCP tool ever
 *      imports it, the floor has a hole that every unit test still passes.
 *
 *   2. NO CONFIGURATION REACHES IT. There must be no environment variable, flag
 *      or config key anywhere that routes secret content to a hosted provider.
 *      Each individual module can be correct while the composition is not.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep, dirname } from "node:path";
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

function* sources(dir: string): Generator<string> {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) yield* sources(abs);
    else if (/\.(ts|mts|js|mjs|ps1)$/.test(e.name)) yield abs;
  }
}

const rel = (abs: string): string => relative(ROOT, abs).split(sep).join("/");

// ─────────────────────────────────────────────────────────────────────────────
// 1 · The import graph
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The ONLY files permitted to reach the secret break-glass.
 *
 * Every entry is a DIRECT-RENDER surface — a local terminal, with no model in
 * the loop — plus the module that defines it and the tests that exercise it.
 * Adding to this list is a governance decision, not a refactor.
 */
const BREAK_GLASS_CALLERS = new Set([
  "packages/core/src/gate/override.ts",        // defines it
  "packages/core/src/gate/index.ts",           // re-exports it
  "packages/core/src/index.ts",                // re-exports it
  "packages/cli/src/commands/write.ts",        // `sutra reveal` — the interactive CLI
  "tests/defects/secret-floor.test.ts",        // this file
]);

test("I13 · authorizeSecretEgress is reachable ONLY from a direct-render surface", () => {
  const callers: string[] = [];
  for (const abs of sources(ROOT)) {
    const r = rel(abs);
    if (BREAK_GLASS_CALLERS.has(r)) continue;
    const text = readFileSync(abs, "utf8");
    if (/\bauthorizeSecretEgress\b/.test(text)) callers.push(r);
  }

  assert.deepEqual(
    callers,
    [],
    "THE SECRET BREAK-GLASS IS REACHABLE FROM SOMEWHERE NEW.\n\n" +
    "`authorizeSecretEgress` is the only function that can authorise rendering secret content. The\n" +
    "guarantee 'secret never reaches a model' is exactly as strong as the list of its callers, and no\n" +
    "module can check its own caller list — every unit test still passes with a hole here.\n\n" +
    "It may be called ONLY from an interactive, direct-render surface: a local terminal, no model in\n" +
    "the loop. Never from a cron job, a capability runner, a daemon route or an MCP tool.\n\n" +
    "New caller(s): " + callers.join(", "),
  );
});

test("I13 · the MCP package cannot reach the break-glass or the reveal ceiling", () => {
  // Stated separately from the general check because this is the one that
  // matters most: the MCP surface is BY DEFINITION consumed by a model.
  for (const abs of sources(join(ROOT, "packages", "mcp"))) {
    const text = readFileSync(abs, "utf8");
    assert.ok(!/\bauthorizeSecretEgress\b/.test(text),
      `${rel(abs)} reaches the secret break-glass. MCP output is ALWAYS consumed by an LLM.`);
    assert.ok(!/\bsecretRevealCeiling\b/.test(text),
      `${rel(abs)} imports the reveal ceiling. The MCP path passes allowSecret: false, unconditionally.`);
  }
});

test("I13 · the planted-caller check actually fires", () => {
  // The rule: a guardrail test never seen to fail is not evidence. Run the same
  // detection over a synthetic file and confirm it trips.
  const planted = "import { authorizeSecretEgress } from '@sutra/aatma-core';\nawait cron.run(() => authorizeSecretEgress(root, pass, id));\n";
  assert.ok(/\bauthorizeSecretEgress\b/.test(planted),
    "the detection pattern does not match a plain import — a clean result would prove nothing");
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 · No configuration reaches the floor
// ─────────────────────────────────────────────────────────────────────────────

test("I13 · `local_only` is pinned to a local provider — not configurable", () => {
  const cfg = readFileSync(join(ROOT, "packages/core/src/config.ts"), "utf8");

  assert.match(cfg, /PINNED_LOCAL_ONLY/,
    "config.ts must pin the local_only provider mode rather than reading it from a file");

  // The pinned value must be `local`, and the config file must NOT be able to
  // override it. Assert the loader does not read a `local_only` key at all.
  assert.ok(
    !/raw\.provider\?\.\s*local_only/.test(cfg),
    "config.ts READS `provider.local_only` from the config file. That makes the secret floor a " +
    "SETTING rather than an invariant — anyone who can edit a JSON file could route secret content " +
    "to a hosted provider.",
  );
  assert.match(cfg, /local_only:\s*PINNED_LOCAL_ONLY/,
    "the loaded config must use the pinned constant for local_only");
});

test("I13 · no environment variable routes secret content to a hosted provider", () => {
  // A tier ceiling can be RAISED by configuration — that is `SUTRA_MCP_EXPOSURE`
  // and it is legitimate. What must not exist is a switch that makes a HOSTED
  // destination accept `local_only`.
  const suspicious = [
    /ALLOW_SECRET/i,
    /SECRET_HOSTED/i,
    /HOSTED_SECRET/i,
    /DISABLE_(?:GATE|FLOOR)/i,
    /BYPASS_(?:GATE|FLOOR|TIER)/i,
    /UNSAFE_(?:ALLOW|EXPOSE)/i,
  ];
  const offenders: string[] = [];
  for (const abs of sources(ROOT)) {
    const r = rel(abs);

    // A TEST cannot introduce a runtime configuration switch — it can only
    // assert about one, and a test that FORBIDS a name has to name it.
    // `mcp/server.test.ts` lists `allow_secret` precisely in order to assert no
    // tool accepts it, and flagging that would be the guard objecting to its
    // own enforcement.
    //
    // This is a narrow exclusion by KIND, not a list of individual files: a
    // per-file exclusion list is the thing that grows until a scanner means
    // nothing.
    if (/\.test\.(ts|mts|js|mjs|ps1)$/.test(r)) continue;

    const text = readFileSync(abs, "utf8");
    for (const re of suspicious) {
      const m = re.exec(text);
      if (m) offenders.push(`${r}: ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, [],
    "A CONFIGURATION SWITCH THAT COULD LIFT THE FLOOR EXISTS.\n" +
    "The secret floor is absolute in every instance. Everything else is configurable; this is not.\n" +
    offenders.join("\n"));
});

test("I13 · the four enforcement points all still exist", () => {
  // Defence in depth only works if all four are present. Each has failed
  // independently in the upstream system's history, and the other three held —
  // so the count is the property, not any one of them.
  const points: Array<[string, RegExp, string]> = [
    ["1 · classify at ingest", /export function classify\b/, "packages/core/src/gate/patterns.ts"],
    ["2 · Brain.visible()", /private visible\s*\(/, "packages/core/src/vault/brain.ts"],
    ["3 · sensitivityGuard()", /export function sensitivityGuard\b/, "packages/core/src/gate/guard.ts"],
    ["4 · MCP ceiling at startup", /const exposure = ceilingFromEnv\(\)/, "packages/mcp/src/server.ts"],
  ];
  for (const [name, re, file] of points) {
    const text = readFileSync(join(ROOT, file), "utf8");
    assert.match(text, re, `enforcement point "${name}" is missing from ${file}`);
  }
});
