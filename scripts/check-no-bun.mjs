#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * M0 verify: `grep -r 'Bun\.' packages/core packages/mcp` returns nothing.
 *
 * The governance core uses only node:fs|path|crypto|readline|child_process plus
 * gray-matter, so it runs unchanged on Node, Bun or Deno. That portability is a
 * product property (shape (a) must work with zero accounts and zero network on
 * any of the three), and it is exactly the kind of property that erodes one
 * convenient `Bun.file()` at a time. So it is asserted, not assumed.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const GUARDED = ["packages/core", "packages/mcp", "packages/cli"];
const SKIP = new Set(["node_modules", "dist", ".git", "coverage"]);

/** Runtime-bound globals that would pin these packages to one JS runtime. */
const FORBIDDEN = [
  { re: /\bBun\./g, why: "Bun-only global — pins the package to the Bun runtime" },
  { re: /\bDeno\./g, why: "Deno-only global" },
  { re: /\bfrom ["']bun(:|["'])/g, why: "Bun-only module import" },
  { re: /\bfrom ["']bun:test["']/g, why: "Bun test runner — use node:test" },
];

const problems = [];

function* walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) yield* walk(abs);
    else if (e.isFile() && /\.(ts|mts|cts|js|mjs|cjs)$/.test(e.name)) yield abs;
  }
}

let scanned = 0;
for (const guarded of GUARDED) {
  for (const abs of walk(join(ROOT, guarded))) {
    scanned++;
    const rel = relative(ROOT, abs).split(sep).join("/");
    if (rel.endsWith("check-no-bun.mjs")) continue;
    const text = readFileSync(abs, "utf8");
    for (const { re, why } of FORBIDDEN) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        const line = text.slice(0, m.index).split("\n").length;
        problems.push(`${rel}:${line}  ${m[0].trim()} — ${why}`);
      }
    }
  }
}

// The declared engine must not exclude Node either.
for (const pkg of GUARDED) {
  const p = join(ROOT, pkg, "package.json");
  try {
    statSync(p);
    const json = JSON.parse(readFileSync(p, "utf8"));
    if (json.engines?.bun && !json.engines?.node) {
      problems.push(`${pkg}/package.json: declares engines.bun but not engines.node`);
    }
  } catch { /* package not present yet */ }
}

if (problems.length) {
  console.error("no-bun: FAIL — runtime-bound code in the portable packages\n");
  for (const p of problems) console.error("  ✗ " + p);
  process.exit(1);
}

console.log(`no-bun: OK — ${scanned} files across ${GUARDED.join(", ")} are runtime-agnostic.`);
