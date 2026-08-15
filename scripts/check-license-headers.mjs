#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * LICENSING.md §4 rule 2: every file declares its licence, and `ee/` identifiers
 * never appear outside `ee/`.
 *
 * Two failure modes this catches, both cheap now and expensive later:
 *   1. A Core file with no SPDX header — ambiguous licence after copy-paste.
 *   2. A commercial identifier outside ee/ — the single most common open-core
 *      mistake, where a user has to guess which licence governs the file.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CORE_ID = "Apache-2.0";
const EE_ID = "LicenseRef-Sutra-Commercial";

/** Extensions that carry a comment syntax we can put an SPDX line in. */
const CHECKED = new Set([
  ".ts", ".mts", ".cts", ".js", ".mjs", ".cjs",
  ".ps1", ".psm1", ".psd1", ".py", ".sh", ".yaml", ".yml", ".md", ".css", ".html",
]);

const SKIP_DIRS = new Set([
  "node_modules", "dist", ".git", "coverage", "assets", "graphify-out", ".sutra",
]);

/**
 * Files exempt from the header requirement, with the reason. Every exemption is
 * named — a silent exemption list is how a boundary check stops meaning anything.
 */
const EXEMPT = new Map([
  ["LICENSE", "verbatim Apache-2.0 text; must not be modified"],
  ["NOTICE", "Apache-2.0 §4(d) attribution file"],
  ["ee/LICENSE", "verbatim commercial EULA"],
  ["THIRD-PARTY-NOTICES.md", "generated"],
  ["CHANGELOG.md", "generated from tags"],
]);

const problems = [];
const seen = { core: 0, ee: 0, exempt: 0, unchecked: 0 };

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".githooks" && entry.name !== ".github") continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(abs);
    else if (entry.isFile()) yield abs;
  }
}

for (const abs of walk(ROOT)) {
  const rel = relative(ROOT, abs).split(sep).join("/");
  if (EXEMPT.has(rel)) { seen.exempt++; continue; }
  if (!CHECKED.has(extname(abs))) { seen.unchecked++; continue; }
  if (statSync(abs).size === 0) continue;

  const inEe = rel === "ee" || rel.startsWith("ee/");
  // Read only the head: an SPDX line belongs in the first few lines, and a
  // whole-file read would let an identifier buried in prose satisfy the check.
  const head = readFileSync(abs, "utf8").split(/\r?\n/).slice(0, 12).join("\n");
  const hasCore = head.includes(`SPDX-License-Identifier: ${CORE_ID}`);
  const hasEe = head.includes(`SPDX-License-Identifier: ${EE_ID}`);

  if (inEe) {
    seen.ee++;
    if (!hasEe) problems.push(`${rel}: ee/ file must declare "SPDX-License-Identifier: ${EE_ID}"`);
    if (hasCore) problems.push(`${rel}: ee/ file declares the OPEN identifier — it is not Apache-2.0`);
  } else {
    seen.core++;
    if (!hasCore) problems.push(`${rel}: Core file must declare "SPDX-License-Identifier: ${CORE_ID}"`);
    if (hasEe) problems.push(`${rel}: commercial identifier OUTSIDE ee/ — the boundary is broken here`);
  }
}

// A whole-tree grep for the commercial identifier, independent of the extension
// filter above. A .json or .toml can't carry a comment, but it can carry the
// string — and if it does outside ee/, that is exactly the ambiguity §3 warns of.
for (const abs of walk(ROOT)) {
  const rel = relative(ROOT, abs).split(sep).join("/");
  if (rel === "ee/LICENSE" || rel === "NOTICE" || rel === "CONTRIBUTING.md") continue;
  if (rel === "scripts/check-license-headers.mjs") continue;
  if (rel.startsWith("ee/") || rel.startsWith("Master_documentation/")) continue;
  if (statSync(abs).size > 2_000_000) continue;
  let text;
  try { text = readFileSync(abs, "utf8"); } catch { continue; }
  if (text.includes(EE_ID)) {
    problems.push(`${rel}: contains "${EE_ID}" outside ee/`);
  }
}

if (problems.length) {
  console.error("license-headers: FAIL\n");
  for (const p of problems) console.error("  ✗ " + p);
  console.error(`\n${problems.length} problem(s). Add the SPDX line, or add a NAMED exemption in scripts/check-license-headers.mjs.`);
  process.exit(1);
}

console.log(
  `license-headers: OK — ${seen.core} Core (${CORE_ID}), ${seen.ee} ee/ (${EE_ID}), ` +
  `${seen.exempt} exempt, ${seen.unchecked} not header-bearing.`,
);
