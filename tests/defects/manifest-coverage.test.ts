// SPDX-License-Identifier: Apache-2.0
/**
 * THE MANIFEST'S OWN COVERAGE CHECK.
 *
 * `INHERITED-DEFECTS.md` ends every entry in a NAMED TEST. This file parses that
 * document's index table and asserts each name exists somewhere in the test
 * tree — so "how many defects are covered?" is a number the repository computes
 * rather than one anybody claims.
 *
 * ROADMAP Gate 1, item 6:
 *
 *   > Every defect in INHERITED-DEFECTS.md has a named, passing absence test in
 *   > CI — **or an explicit, dated decision to accept it.**
 *
 * `ACCEPTED` below is that escape hatch, and it is deliberately uncomfortable to
 * use: each entry needs a reason and a date, and the test prints the list on
 * every run so it cannot quietly become the place defects go to be forgotten.
 *
 * ── WHY THIS FILE EXISTS AT ALL ────────────────────────────────────────────
 * Because the alternative is a human counting. During this build the
 * implementation ledger said "17 of 39" — a number I had counted by hand, and
 * which was wrong in both directions once anything checked it. A coverage claim
 * that nothing verifies is exactly the class of thing this whole repository is
 * built to distrust.
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
 * Defects accepted WITHOUT an absence test, each with a reason and a date.
 *
 * Every entry here describes a defect whose SURFACE DOES NOT EXIST in Sutra.
 * You cannot write a meaningful absence test for a bug in a component you did
 * not build — but you can, and this file does, assert that the surface is still
 * absent. If one is ever added, the guard below fails and the test must be
 * written before the feature ships.
 *
 * That is the difference between "accepted" and "forgotten".
 */
const ACCEPTED: Record<string, {
  reason: string;
  date: string;
  surfaceGuard?: string;
  /**
   * A line the guard MUST match, and one it must NOT.
   *
   * Same rule as every detection rule in this repo: a surface guard that matches
   * nothing is indistinguishable from a surface that is absent. Narrowing a
   * guard — which is the right response to a false positive — is exactly when it
   * can silently become inert, so the fixture is required alongside it.
   */
  guardFixture?: { matches: string; doesNotMatch: string };
}> = {
  "D32": {
    reason:
      "a message-poller replaying commands after a restart. Sutra ships no bot, no poller and no " +
      "long-running message consumer — the harness owns chat entirely (§11: not a bot framework).",
    date: "2026-08-16",
    surfaceGuard: "poller|getUpdates|long_?poll",
    guardFixture: {
      matches: "const updates = await bot.getUpdates({ offset, timeout: 30 });",
      // A CODE line, not prose. The first attempt here read "Sutra ships no
      // poller…" and the guard duly fired on it — the third time in one session
      // that a scanner flagged the sentence explaining its own rule. The scan
      // below now strips comments; the fixture is code so it tests the scan's
      // subject rather than its commentary.
      doesNotMatch: "const dispatcher = createDispatcher(brain, ceilingFromEnv());",
    },
  },
  "D33": {
    reason:
      "an emoji scan matching nothing under a mis-declared multibyte locale, turning a 15-alert day " +
      "into a clean one. Sutra has no emoji-based alerting; `sutra doctor` and the run record are " +
      "structured data, not scraped text.",
    date: "2026-08-16",
    surfaceGuard: "emoji|LC_ALL",
    guardFixture: {
      matches: "if (line.includes(emoji.warning)) alerts.push(line);",
      doesNotMatch: "const structured = JSON.parse(readFileSync(runRecord));",
    },
  },
  "D34": {
    reason:
      "a report exceeding a messaging platform's length limit and being truncated — and a bad day is " +
      "always a longer message than a good one. Sutra sends no messages. `sutra doctor` writes to a " +
      "terminal, which does not truncate.",
    date: "2026-08-16",
    // NARROWED 2026-08-17. This was `sendMessage|telegram|slack.*post`, and the
    // bare `telegram` matched `patterns.ts`'s doc comment listing the Telegram
    // TOKEN SHAPE the scanner detects — which is the opposite of shipping a
    // Telegram bot. A surface guard that fires on the code protecting you from
    // the surface is a guard someone deletes rather than narrows (D6/D24).
    //
    // What D34 actually needs watched is an OUTBOUND CHAT SEND.
    guardFixture: {
      matches: "await fetch('https://hooks.slack.com/services/T000/B000/x', { method: 'POST' });",
      // The exact false positive that forced the narrowing: a DETECTION RULE for
      // a Telegram token is not an outbound Telegram send.
      doesNotMatch: "no rule at all for nvapi-, gsk_, AIza, github_pat_, hf_, Telegram or AGE-SECRET-KEY-1",
    },
    surfaceGuard: "sendMessage|api\\.telegram\\.org|chat\\.postMessage|hooks\\.slack\\.com|webhook.*(?:slack|discord|teams)",
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Parse the manifest
// ─────────────────────────────────────────────────────────────────────────────

interface Defect {
  id: string;
  name: string;
  testId: string;
}

function parseManifest(): Defect[] {
  const md = readFileSync(join(ROOT, "INHERITED-DEFECTS.md"), "utf8");
  const out: Defect[] = [];

  // The index table: | **D1** | name | class | status | `test/id` |
  for (const m of md.matchAll(/^\|\s*\*\*(D\d+)\*\*\s*\|\s*([^|]+?)\s*\|[^|]*\|[^|]*\|\s*`([^`]+)`\s*\|/gm)) {
    out.push({ id: m[1]!, name: m[2]!.trim(), testId: m[3]!.trim() });
  }

  // The smaller-traps table: | **D26** | trap | test-description |
  for (const m of md.matchAll(/^\|\s*\*\*(D\d+)\*\*\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/gm)) {
    if (out.some((d) => d.id === m[1])) continue;
    out.push({ id: m[1]!, name: m[2]!.trim(), testId: "" });
  }

  return out;
}

/** Every line of every test in the tree, as one searchable blob. */
function testCorpus(): string {
  const parts: string[] = [];
  const SKIP = new Set(["node_modules", ".git", "dist", "coverage", ".sutra"]);

  const walk = (dir: string): void => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (/\.test\.(ts|mts|js|mjs|ps1)$/.test(e.name)) parts.push(readFileSync(abs, "utf8"));
    }
  };

  for (const r of ["packages", "tests", "automation", "ee"]) {
    const abs = join(ROOT, r);
    if (existsSync(abs)) walk(abs);
  }
  return parts.join("\n");
}

const DEFECTS = parseManifest();
const CORPUS = testCorpus();

// ─────────────────────────────────────────────────────────────────────────────

test("the manifest parses — 39 defects with their named tests", () => {
  assert.ok(
    DEFECTS.length >= 39,
    `parsed only ${DEFECTS.length} defects from INHERITED-DEFECTS.md. The table format has drifted ` +
    `and this whole file is now checking almost nothing.`,
  );
  assert.ok(DEFECTS.some((d) => d.id === "D1" && d.testId === "synth/no-input-clip"));
  assert.ok(DEFECTS.some((d) => d.id === "D39"));
});

test("the test corpus is real — this file is not scanning an empty string", () => {
  assert.ok(CORPUS.length > 50_000, `the corpus is only ${CORPUS.length} chars — the walk is wrong`);
  assert.ok(CORPUS.includes("synth/no-input-clip"), "a known-covered test id is missing from the corpus");
});

test("EVERY defect has a named absence test, or a dated acceptance", () => {
  const uncovered: string[] = [];

  for (const d of DEFECTS) {
    if (ACCEPTED[d.id]) continue;

    // A defect is covered when its NAMED TEST ID appears in the test tree, or —
    // for the smaller traps, which carry a description rather than an id — when
    // its number is cited by a test.
    const byTestId = d.testId !== "" && CORPUS.includes(d.testId);
    const byNumber = new RegExp(`\\b${d.id}\\b`).test(CORPUS);

    if (!byTestId && !byNumber) {
      uncovered.push(`${d.id} · ${d.name}${d.testId ? ` → \`${d.testId}\`` : ""}`);
    }
  }

  assert.deepEqual(
    uncovered,
    [],
    `${uncovered.length} DEFECT(S) HAVE NO ABSENCE TEST:\n\n` + uncovered.join("\n") +
    "\n\nA defect is 'not inherited' only when its named test exists, FAILS AGAINST A PLANTED " +
    "INSTANCE, and passes against the product. Write the test, or add a dated entry to ACCEPTED " +
    "with a reason.",
  );
});

test("every ACCEPTED entry has a reason and a date, and is reported", () => {
  // Printed on every run so the list cannot quietly become the place defects go
  // to be forgotten.
  for (const [id, a] of Object.entries(ACCEPTED)) {
    assert.ok(a.reason.length > 60, `${id}'s acceptance reason is too thin to review`);
    assert.match(a.date, /^\d{4}-\d{2}-\d{2}$/, `${id} has no acceptance date`);
    console.log(`    ACCEPTED ${id} (${a.date}): ${a.reason.slice(0, 90)}…`);
  }
});

/**
 * Comments out, code in.
 *
 * Every one of these guards describes a component Sutra deliberately does NOT
 * have — and the place that fact is written down is a comment, right next to the
 * code that would otherwise grow it. A guard that fires on its own rationale is
 * a guard the next contributor deletes instead of narrowing (D6/D24), and then
 * the accepted defect really is forgotten.
 */
function stripComments(text: string): string {
  return text
    .replace(/<#[\s\S]*?#>/g, " ")        // PowerShell block
    .replace(/\/\*[\s\S]*?\*\//g, " ")     // C-style block
    .replace(/^\s*(?:#(?!!)|\/\/|\*).*$/gm, " ");  // line comments + JSDoc bodies
}

test("every SURFACE GUARD has a fixture it matches, and one it does not", () => {
  // The guards below are the only thing standing between "accepted" and
  // "forgotten", and they are regexes — so they are subject to this repo's
  // oldest rule: a rule that fires zero times looks exactly like a rule
  // protecting a clean corpus.
  //
  // This is not hypothetical. D34's guard was `sendMessage|telegram|slack.*post`
  // and the bare `telegram` matched a doc comment about the Telegram TOKEN SHAPE
  // the scanner detects. Narrowing it was correct — and narrowing is precisely
  // the moment a guard can become inert without anyone noticing.
  for (const [id, a] of Object.entries(ACCEPTED)) {
    if (!a.surfaceGuard) continue;
    assert.ok(a.guardFixture, `${id} has a surfaceGuard with no fixture — it could match nothing`);
    const re = new RegExp(a.surfaceGuard, "i");
    assert.ok(re.test(a.guardFixture!.matches),
      `${id}'s guard /${a.surfaceGuard}/i does not match its own fixture — IT IS A DEAD RULE:\n  ${a.guardFixture!.matches}`);
    assert.equal(re.test(a.guardFixture!.doesNotMatch), false,
      `${id}'s guard over-matches; it fired on:\n  ${a.guardFixture!.doesNotMatch}`);
  }
});

test("an ACCEPTED defect's SURFACE is still absent — if it returns, so must the test", () => {
  // The difference between "accepted" and "forgotten". Each accepted defect was
  // accepted BECAUSE Sutra has no such component. Adding one silently would
  // reintroduce the defect with nothing watching.
  const SKIP = new Set(["node_modules", ".git", "dist", "coverage", ".sutra", "docs"]);
  const sources: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (/\.(ts|mts|js|mjs|ps1)$/.test(e.name) && !/\.test\./.test(e.name)) {
        sources.push(stripComments(readFileSync(abs, "utf8")));
      }
    }
  };
  for (const r of ["packages", "automation", "ee"]) {
    const abs = join(ROOT, r);
    if (existsSync(abs)) walk(abs);
  }
  const src = sources.join("\n");

  const returned: string[] = [];
  for (const [id, a] of Object.entries(ACCEPTED)) {
    if (!a.surfaceGuard) continue;
    if (new RegExp(a.surfaceGuard, "i").test(src)) returned.push(`${id} — matched /${a.surfaceGuard}/i`);
  }

  assert.deepEqual(
    returned,
    [],
    "A DEFECT WAS ACCEPTED BECAUSE ITS SURFACE DID NOT EXIST, AND THE SURFACE NOW EXISTS:\n" +
    returned.join("\n") +
    "\n\nThe acceptance is void. Write the absence test before that feature ships.",
  );
});
