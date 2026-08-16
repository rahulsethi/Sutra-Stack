// SPDX-License-Identifier: Apache-2.0
/**
 * D1 · `synth/no-input-clip` — THE MOST DAMAGING DEFECT THE AUDIT FOUND.
 *
 * `backfill-synthesis.ps1:35` truncated every source to 6,000 characters before
 * sending it to the model. That script — unscheduled, in the parent repo, run
 * ONCE BY HAND — produced 424 of the 595 pages in the corpus. 160 had sources
 * larger than the clip; the median page saw 38% of its material, p25 saw 19%,
 * the worst 1.2%.
 *
 * ── WHY IT WAS INVISIBLE ───────────────────────────────────────────────────
 * It does not produce SHORT pages. It produces confident, fluent,
 * correctly-formatted 400-word pages that are wrong in specifics — and page
 * length was FLAT at ~406–470 words across TWO ORDERS OF MAGNITUDE of source
 * size, so nothing in the corpus looked anomalous. The freshness rubric scored
 * 164 of them "healthy".
 *
 * Documented damage: a twelve-week plan described throughout as "an eight-week
 * period"; a page fabricated wholesale from a corrupt OCR extract.
 *
 * ── THE TEST ───────────────────────────────────────────────────────────────
 * Two halves, and both matter:
 *
 *   1. BEHAVIOURAL — synthesise from a 50,000-char fixture and assert the synth
 *      function received the whole body, and that `source_chars_seen` equals
 *      `source_chars_total` on the artifact.
 *
 *   2. STRUCTURAL — grep the tree for a slice applied to a source body. The
 *      behavioural half only covers the paths a test happens to exercise; the
 *      defect arrived on a path nobody was testing, in a script nobody had
 *      scheduled. A grep covers the paths nobody thought about.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, sep, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { VaultClient, Brain, ask, type SynthesizeFn } from "@sutra/core";

/**
 * Find the repo root by walking up for the root manifest.
 *
 * NOT a fixed `../..`: these tests run from `tests/dist/defects/` after
 * compilation but from `tests/defects/` in an editor, and a hard-coded depth is
 * silently wrong in one of the two. A test that resolves the wrong root does not
 * fail loudly — it greps an empty tree and PASSES, which is the worst outcome
 * available to a test whose whole job is to grep a tree.
 */
function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string };
      if (pkg.name === "sutra") return dir;
    } catch { /* keep walking */ }
    dir = dirname(dir);
  }
  throw new Error("could not locate the repo root — this test would otherwise grep nothing and pass");
}

const ROOT = findRepoRoot();

// ─────────────────────────────────────────────────────────────────────────────
// 1 · BEHAVIOURAL — the whole body reaches synthesis
// ─────────────────────────────────────────────────────────────────────────────

function vaultWithLargeNote(chars: number): { root: string; body: string } {
  const root = mkdtempSync(join(tmpdir(), "sutra-clip-"));
  mkdirSync(join(root, "vault"), { recursive: true });
  mkdirSync(join(root, "automation", "policies"), { recursive: true });

  // Distinctive sentinels at the START, MIDDLE and END. A prefix clip keeps the
  // first and loses the other two, which is precisely the failure signature.
  const filler = "The governance substrate keeps notes as plain markdown. ";
  const repeats = Math.ceil(chars / filler.length);
  let body = filler.repeat(repeats).slice(0, chars);
  body = "SENTINEL_START " + body.slice(15);
  const mid = Math.floor(body.length / 2);
  body = body.slice(0, mid) + "SENTINEL_MIDDLE " + body.slice(mid + 16);
  body = body.slice(0, body.length - 14) + "SENTINEL_END";

  writeFileSync(
    join(root, "vault", "large.md"),
    `---\ntype: Note\nsensitivity: public\n---\n\n# A large source\n\n${body}\n`,
  );
  return { root, body };
}

test("D1 · the WHOLE body reaches synthesis — 50,000 chars, nothing clipped", () => {
  const { root } = vaultWithLargeNote(50_000);
  const brain = new Brain(new VaultClient(root), "hosted_allowed");

  let received = "";
  const synthesize: SynthesizeFn = (input) => {
    received = input.sources.map((s) => s.body).join("\n");
    return { answer: "synthesised", mode: "local" };
  };

  const r = ask(root, ROOT, brain, "governance substrate", { synthesize, k: 3 });

  assert.ok(received.includes("SENTINEL_START"), "the synth function did not receive the start");
  assert.ok(received.includes("SENTINEL_MIDDLE"),
    "THE SOURCE WAS CLIPPED — the synth function received a prefix. This is D1, and it produces " +
    "confident, fluent pages that are wrong in specifics.");
  assert.ok(received.includes("SENTINEL_END"), "the synth function did not receive the end");
  assert.ok(received.length >= 49_000, `only ${received.length} chars reached synthesis`);

  // The artifact must SAY it saw everything.
  assert.equal(r.source_chars_seen, r.source_chars_total,
    "seen != total — truncation must be a FACT ON THE ARTIFACT, not an inference");
});

test("D1 · a source over the context window DROPS WHOLE SOURCES, never truncates one", () => {
  // The rule: chunk-and-merge, or refuse. NEVER silently prefix. Dropping
  // source #6 entirely is honest and visible; showing the model 38% of source #1
  // is neither.
  const root = mkdtempSync(join(tmpdir(), "sutra-window-"));
  mkdirSync(join(root, "vault"), { recursive: true });
  mkdirSync(join(root, "automation", "policies"), { recursive: true });
  for (let i = 0; i < 5; i++) {
    const body = `WHOLE_${i} ` + "governance widgets and substrate notes. ".repeat(200);
    writeFileSync(
      join(root, "vault", `n${i}.md`),
      `---\ntype: Note\nsensitivity: public\n---\n\n# Note ${i}\n\n${body}\n`,
    );
  }

  const brain = new Brain(new VaultClient(root), "hosted_allowed");
  let received: string[] = [];
  const synthesize: SynthesizeFn = (input) => {
    received = input.sources.map((s) => s.body);
    return { answer: "ok", mode: "local" };
  };

  const r = ask(root, ROOT, brain, "governance widgets", {
    synthesize,
    k: 5,
    contextWindowChars: 12_000, // deliberately too small for all five
  });

  assert.ok(received.length < 5, "the window should have forced some sources out");
  assert.ok(received.length > 0, "it should not have dropped everything");

  // EVERY source that DID go is COMPLETE.
  for (const body of received) {
    assert.ok(/WHOLE_\d/.test(body), "a source arrived without its start marker — it was truncated");
    assert.ok(body.length > 5_000, `a source arrived at only ${body.length} chars — it was truncated`);
  }

  // …and the caller is TOLD sources were dropped.
  assert.ok(
    r.degraded.some((d) => /dropped .* source/.test(d)),
    "dropping sources must be reported. Degradation is allowed; silent degradation is not.",
  );
  assert.ok(
    r.degraded.some((d) => /NOTHING was truncated/.test(d)),
    "the note must say what it did INSTEAD of truncating, or the next person will 'optimise' it back",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 · STRUCTURAL — grep the tree for the shape of the defect
// ─────────────────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", ".sutra", "docs"]);

function* walk(dir: string): Generator<string> {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) yield* walk(abs);
    else if (/\.(ts|mts|js|mjs|ps1|py)$/.test(e.name)) yield abs;
  }
}

/**
 * Scan a tree for clip-shaped code. Factored out so the SAME scanner can be run
 * against the real repo (expecting clean) and against a planted fixture
 * (expecting a hit) — which is what makes a clean result mean something.
 */
function scanForClips(root: string, patterns: Array<{ re: RegExp; what: string }>): string[] {
  const offenders: string[] = [];
  const thisFile = fileURLToPath(import.meta.url);

  for (const abs of walk(root)) {
    if (abs === thisFile) continue;
    const rel = relative(root, abs).split(sep).join("/");

    // The two files allowed to slice a body, each for a stated reason, both
    // verified by the behavioural half above. `ask.ts`'s `excerpt()` is a
    // RELEVANCE SELECTION for a human, labelled where it skips; `brain.ts`'s is
    // a 200-char search preview that never reaches synthesis.
    if (rel.endsWith("retrieval/ask.ts")) continue;
    if (rel.endsWith("vault/brain.ts")) continue;
    // `Get-IndexSummary` truncates a one-line INDEX ENTRY that links to the full
    // note, with a visible ellipsis, and nothing is synthesised from it. The
    // function documents all three properties and says it becomes D1 if any of
    // them stops holding.
    if (rel.endsWith("publish/build-llms-txt.ps1")) continue;
    if (rel.includes("tests/defects/")) continue;

    let text: string;
    try { text = readFileSync(abs, "utf8"); } catch { continue; }

    for (const { re, what } of patterns) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const line = text.slice(0, m.index).split("\n").length;
        offenders.push(`${rel}:${line} — ${what}: ${m[0].trim()}`);
      }
    }
  }
  return offenders;
}

test("D1 · no source body is truncated to a fixed budget anywhere in the tree", () => {
  // ── The discriminator that makes this test sharp rather than noisy ────────
  //
  // A CLIP truncates to a FIXED BUDGET. A line-number computation slices to a
  // MATCH INDEX. Both are `slice(0, x)`, and only the first is D1.
  //
  //   slice(0, 6000)            ← a clip. The defect.
  //   slice(0, maxChars)        ← a clip. The defect wearing a variable name.
  //   slice(0, m.index)         ← a line number. Not a clip.
  //   slice(0, text.indexOf(x)) ← a structural split. Not a clip.
  //
  // The first version of this test flagged all four and found six legitimate
  // line-number computations. A test that cries wolf on every `slice(0,` is one
  // that gets an exclusion list bolted on until it means nothing — which is D24
  // and D6's shared lesson, arriving here.
  const NUMERIC_BUDGET = "(?:\\d{3,}|\\w*(?:[Mm]ax|[Ll]imit|[Bb]udget|CLIP|[Cc]hars|[Ss]ize|[Ww]indow)\\w*)";
  const patterns: Array<{ re: RegExp; what: string }> = [
    {
      re: new RegExp(`\\b(?:extract|source|body|content|text|note|page)\\w*\\.(?:slice|substring)\\s*\\(\\s*0\\s*,\\s*${NUMERIC_BUDGET}\\s*\\)`, "gi"),
      what: "a source body truncated to a FIXED BUDGET",
    },
    {
      re: new RegExp(`\\bSubstring\\s*\\(\\s*0\\s*,\\s*${NUMERIC_BUDGET}\\s*\\)`, "g"),
      what: "a PowerShell Substring(0, <fixed budget>)",
    },
    { re: /-Head\s+\d{3,}/g, what: "a PowerShell -Head with a large fixed N" },
    { re: /\.slice\s*\(\s*0\s*,\s*6000\s*\)/g, what: "THE LITERAL 6,000-character clip" },
    { re: /\[\s*:\s*6000\s*\]/g, what: "a Python 6,000-character slice" },
    { re: /\bSubstring\s*\(\s*0\s*,\s*6000\s*\)/g, what: "THE LITERAL 6,000-character clip" },
  ];

  const offenders = scanForClips(ROOT, patterns);

  // ── THE RULE THIS WHOLE DIRECTORY EXISTS FOR ─────────────────────────────
  // A guardrail test that has never been seen to fail is not evidence of
  // anything. So before trusting a clean result, PLANT the defect and confirm
  // the scanner catches it. Otherwise a passing run is equally consistent with
  // "the tree is clean" and "the pattern matches nothing at all" — and the
  // upstream path-floor band spent its entire life in the second state.
  const planted = mkdtempSync(join(tmpdir(), "sutra-planted-clip-"));
  mkdirSync(join(planted, "src"), { recursive: true });
  writeFileSync(
    join(planted, "src", "backfill-synthesis.ts"),
    "// A faithful reproduction of the defect.\n" +
    "export function synthesise(extract: string) {\n" +
    "  const body = extract.slice(0, 6000);\n" +
    "  return callModel(body);\n" +
    "}\n",
  );
  const caught = scanForClips(planted, patterns);
  assert.ok(
    caught.length > 0,
    "THE SCANNER DID NOT CATCH A PLANTED 6,000-CHARACTER CLIP. A clean result from it therefore " +
    "proves nothing — it is equally consistent with a clean tree and with a pattern that matches " +
    "nothing at all.",
  );
  assert.match(
    caught[0]!,
    /backfill-synthesis\.ts:3/,
    `the planted clip was caught, but at the wrong location: ${caught[0]}`,
  );
  assert.match(
    caught[0]!,
    /FIXED BUDGET|6,000/,
    `the planted clip was caught but not described as a clip: ${caught[0]}`,
  );

  assert.deepEqual(
    offenders,
    [],
    "A SLICE OF A SOURCE BODY EXISTS IN THE TREE.\n\n" +
    "This is D1, the single most damaging defect the upstream audit found. One line truncated every\n" +
    "source to 6,000 characters and produced 424 pages that were fluent, correctly formatted, and\n" +
    "WRONG IN SPECIFICS — invisible to every metric the system had, because page length was flat\n" +
    "across two orders of magnitude of source size.\n\n" +
    "If a source exceeds the window: chunk-and-merge, or refuse. Never prefix.\n\n" +
    offenders.join("\n"),
  );
});

test("D1 · the two permitted slices are both DOCUMENTED as not-the-clip", () => {
  // The exclusions above are only safe if the excluded code says why. An
  // undocumented exclusion is how a real clip gets added next to a legitimate
  // one and inherits its permission.
  const permitted = [
    "packages/core/src/retrieval/ask.ts",
    "packages/core/src/vault/brain.ts",
    "automation/scripts/publish/build-llms-txt.ps1",
  ];
  for (const rel of permitted) {
    const text = readFileSync(join(ROOT, rel), "utf8");
    assert.ok(
      /D1|NOT the D1 clip|not the .* clip|snippet/i.test(text),
      `${rel} slices a body but does not explain why it is not D1`,
    );
  }
});
