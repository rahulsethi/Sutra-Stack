// SPDX-License-Identifier: Apache-2.0
/**
 * `gate/key-shapes` (D5) · `gate/path-floor` (D4) · `gate/rescan-on-pattern-change` (D14/I15)
 *
 * Three of the four named absence tests for the classifier. The fourth,
 * the OCR floor (I16), is at the bottom.
 *
 * Every one of these guards a defect that SHIPPED. D5 in particular is the
 * cautionary tale for this whole file: the upstream pattern *looked* right, and
 * the tests written from the same mental model as the pattern passed. So these
 * tests assert against fixtures declared in the data file, not against strings
 * retyped here from the same assumption.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  loadPatternSet,
  clearPatternCache,
  classify,
  selfTestPatterns,
  rescanRequired,
  normalisePathForFloor,
  matchesFloorPath,
  toJsRegExp,
  PATTERN_SET_REL,
} from "./patterns.js";

/** Walk up from dist/ to the repo root, where automation/policies/ lives. */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    try {
      readFileSync(join(dir, PATTERN_SET_REL));
      return dir;
    } catch { dir = dirname(dir); }
  }
  throw new Error("could not locate the repo root from the test file");
}

const ROOT = repoRoot();
const patterns = loadPatternSet(ROOT);

// ─────────────────────────────────────────────────────────────────────────────
// D5 · gate/key-shapes
// "13 planted shapes must classify secret; 8 benign strings must not."
// ─────────────────────────────────────────────────────────────────────────────

test("D5 · gate/key-shapes — the set carries at least 13 definite key shapes", () => {
  const definite = patterns.rules.filter((r) => r.band === "definite");
  assert.ok(
    definite.length >= 13,
    `expected ≥13 definite shapes, found ${definite.length}. The upstream set had ONE working ` +
    `rule and no coverage for nvapi-, gsk_, AIza, github_pat_, hf_, Telegram or AGE-SECRET-KEY-1.`,
  );
});

test("D5 · gate/key-shapes — EVERY rule matches its own declared fixture", () => {
  // D4's rule, applied to D5's list: assert positive coverage on every guard.
  // A rule that matches nothing looks exactly like a rule protecting a clean corpus.
  const result = selfTestPatterns(patterns);
  const cold = result.coverage.filter((c) => !c.matchesOwnFixture);
  assert.deepEqual(
    cold.map((c) => c.ruleId),
    [],
    `these rules do not match their own fixture — they are dead code:\n` +
    cold.map((c) => "  " + c.ruleId).join("\n"),
  );
});

test("D5 · gate/key-shapes — the exact shapes that were structurally unmatchable", () => {
  // The literal regression. `sk-[A-Za-z0-9]{20,}` cannot match either of the
  // first two, because the hyphen ends the character run after three chars.
  const planted = [
    "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
    "sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345",
    "nvapi-abcdefghijklmnopqrstuvwxyz0123456789",
    "gsk_abcdefghijklmnopqrstuvwxyz0123456789",
    "AIzaSyAbcdefghijklmnopqrstuvwxyz0123456",
    "sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789",
    "github_pat_11ABCDEFG0abcdefghijklmnop",
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "hf_abcdefghijklmnopqrstuvwxyz0123456789",
    "xoxb-1234567890-0987654321-abcdefghij",
    "1234567890:AAFabcdefghijklmnopqrstuvwxyz0123456",
    "AKIAIOSFODNN7EXAMPLE",
    "-----BEGIN RSA PRIVATE KEY-----",
  ];
  for (const secret of planted) {
    const r = classify({ text: `token: ${secret}\n` }, patterns);
    assert.equal(r.tier, "local_only", `"${secret.slice(0, 18)}…" must classify secret`);
    assert.equal(r.blocking, true, `"${secret.slice(0, 18)}…" must be blocking (definite)`);
  }
});

test("D5 · gate/key-shapes — benign strings are NOT flagged by any definite rule", () => {
  const result = selfTestPatterns(patterns);
  assert.deepEqual(
    result.falsePositives,
    [],
    `definite rules matched benign strings:\n` +
    result.falsePositives.map((f) => `  ${f.ruleId} matched "${f.benign}"`).join("\n"),
  );
});

test("D5 · `sk-learning-and-development-notes` is not a key — the real false positive", () => {
  // A real string from the source corpus. The legacy rule requires 32+ chars with
  // NO hyphen, which is exactly what keeps this out.
  const r = classify({ text: "See sk-learning-and-development-notes for the L&D plan.\n" }, patterns);
  assert.equal(r.blocking, false, "must not block a commit");
  assert.equal(r.tier, "review_required", "must not be floored to secret");
});

test("D5 · a finding never logs the finding — matches are redacted to a shape", () => {
  const secret = "sk-proj-SUPERSECRETVALUE0123456789abcdef";
  const r = classify({ text: `key=${secret}` }, patterns);
  assert.ok(r.hits.length > 0);
  for (const hit of r.hits) {
    assert.ok(!hit.redacted.includes("SUPERSECRETVALUE"),
      "the redacted form leaked the secret it found");
    assert.match(hit.redacted, /chars\)$/, "should report a shape and a length");
  }
  assert.ok(!JSON.stringify(r.reasons).includes("SUPERSECRETVALUE"),
    "a reason string leaked the secret");
});

test("D5 · every configurable provider has a key shape (the derivation rule)", () => {
  // The general rule D5 produced: if a provider is configurable, its key shape
  // is in the scanner. Anything in the router must be covered here.
  const routerPath = join(ROOT, "automation/policies/provider-router.json");
  let router: { providers?: Array<{ id?: string }> };
  try { router = JSON.parse(readFileSync(routerPath, "utf8")); } catch { return; }
  const covered = new Set(patterns.rules.map((r) => r.provider).filter(Boolean));
  const keyless = new Set(["ollama", "local", "deterministic", "harness", "none"]);
  for (const p of router.providers ?? []) {
    if (!p.id || keyless.has(p.id)) continue;
    assert.ok(covered.has(p.id),
      `provider "${p.id}" is configurable but has no key shape in the pattern set (D5)`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// D4 · gate/path-floor
// "8 paths that must floor and 4 ordinary paths that must not."
// ─────────────────────────────────────────────────────────────────────────────

test("D4 · normalisePathForFloor strips the PARA number prefix that killed the band", () => {
  // The upstream bug in one line: '11-identity/accounts/x.md'.startsWith('identity/accounts') === false
  assert.equal(normalisePathForFloor("11-identity/accounts/x.md"), "identity/accounts/x.md");
  assert.equal(normalisePathForFloor("vault/11-identity/03-accounts/x.md"), "vault/identity/accounts/x.md");
  assert.equal(normalisePathForFloor("Identity/Accounts/X.MD"), "identity/accounts/x.md");
  assert.equal(normalisePathForFloor("11-identity\\accounts\\x.md"), "identity/accounts/x.md");
});

test("D4 · gate/path-floor — 8 paths that MUST floor to secret", () => {
  const mustFloor = [
    "vault/11-identity/accounts/bank.md",
    "vault/identity/credentials/aws.md",
    "vault/05-finance/2026-tax.md",
    "vault/07-health/bloodwork.md",
    "vault/medical/notes.md",
    "vault/09-legal/personal/will.md",
    "keys/deploy.md",
    "vault/state/secrets/store.md",
  ];
  for (const p of mustFloor) {
    const r = classify({ text: "nothing sensitive-looking here at all", relPath: p }, patterns);
    assert.equal(r.tier, "local_only", `${p} must floor to secret on its PATH ALONE`);
    assert.equal(r.blocking, true, `${p} must be blocking`);
  }
});

test("D4 · gate/path-floor — 4 ordinary paths that must NOT floor", () => {
  const mustNotFloor = [
    "vault/03-areas/guitar-practice.md",
    "vault/02-projects/sutra/isa.md",
    "vault/04-resources/reaper-shortcuts.md",
    "compiled/pages/src-2026-000001.md",
  ];
  for (const p of mustNotFloor) {
    const r = classify({ text: "ordinary content", relPath: p }, patterns);
    assert.equal(r.tier, "review_required", `${p} must not be floored`);
    assert.equal(r.blocking, false);
  }
});

test("D4 · floor matching is on SEGMENT boundaries, not substrings", () => {
  // `identity/accounts-public` must not match the `identity/accounts` rule, and
  // `my-finance-notes.md` must not match `finance`. A substring matcher would
  // over-floor here, which trains people to distrust the classifier.
  assert.equal(matchesFloorPath("vault/identity/accounts-public/x.md", patterns.floorPaths), null);
  assert.equal(matchesFloorPath("vault/03-areas/my-finance-notes.md", patterns.floorPaths), null);
  assert.equal(matchesFloorPath("vault/keystore/x.md", patterns.floorPaths), null);
  // and the positive control, so this test cannot pass by matching nothing:
  assert.equal(matchesFloorPath("vault/11-identity/accounts/x.md", patterns.floorPaths), "identity/accounts");
});

// ─────────────────────────────────────────────────────────────────────────────
// D24 / I17 · hook/banding
// ─────────────────────────────────────────────────────────────────────────────

test("D24 · hook/banding — every rule declares a band", () => {
  for (const r of patterns.rules) {
    assert.ok(r.band === "definite" || r.band === "heuristic",
      `rule ${r.id} has band "${r.band}" — must be definite or heuristic`);
  }
});

test("D24 · hook/banding — NO heuristic rule can produce a blocking result", () => {
  const heuristics = patterns.rules.filter((r) => r.band === "heuristic");
  assert.ok(heuristics.length > 0, "the set must actually contain heuristics, or this proves nothing");
  for (const rule of heuristics) {
    const r = classify({ text: rule.fixture }, patterns);
    assert.equal(r.blocking, false,
      `heuristic rule ${rule.id} produced a BLOCKING result. A fuzzy rule blocking a commit is ` +
      `how a hook earns a --no-verify habit (128 occurrences across 91 files upstream).`);
  }
});

test("D24 · hook/banding — a heuristic still FLOORS the tier (safe when wrong)", () => {
  // The regression fixture named in the defect: an identifier-shaped literal
  // password must floor. An attempt to tighten this rule was written and then
  // reverted, because the tightened version traded a harmless false positive
  // for a harmful false negative.
  const r = classify({ text: "password = dbutler_prod_9x2Kq\n" }, patterns);
  assert.equal(r.tier, "local_only", "an identifier-shaped literal password must still floor");
  assert.equal(r.blocking, false, "…and must still not block");
  assert.ok(r.reasons.some((x) => /heuristic/.test(x)), "the reason must say it was heuristic");
});

// ─────────────────────────────────────────────────────────────────────────────
// I16 · OCR floor  (the second case of gate/rescan-on-pattern-change)
// ─────────────────────────────────────────────────────────────────────────────

test("I16 · an OCR-engine extract lands at the OCR floor even when its text is benign", () => {
  const benign = "Quarterly planning notes. Nothing sensitive here.";
  const typed = classify({ text: benign, extractEngine: "trafilatura" }, patterns);
  assert.equal(typed.tier, "review_required", "typed text is not floored");

  for (const engine of patterns.ocrEngines) {
    const ocr = classify({ text: benign, extractEngine: engine }, patterns);
    assert.equal(ocr.tier, "local_only",
      `an extract from "${engine}" must floor to secret — every worst credential case upstream ` +
      `arrived as an image of text, where no human ever reads the result`);
    assert.ok(ocr.reasons.some((r) => /I16/.test(r)));
  }
});

test("I16 · engine matching is case-insensitive and whitespace-tolerant", () => {
  const r = classify({ text: "x", extractEngine: "  Tesseract " }, patterns);
  assert.equal(r.tier, "local_only");
});

// ─────────────────────────────────────────────────────────────────────────────
// I14 · raise-only, through the classifier
// ─────────────────────────────────────────────────────────────────────────────

test("I14 · the classifier never LOWERS an existing tier", () => {
  // A secret note whose content and path are both entirely innocuous must stay
  // secret. Classification floors first, then only ever raises.
  const r = classify(
    { text: "the weather is nice", relPath: "vault/03-areas/weather.md", currentTier: "secret" },
    patterns,
  );
  assert.equal(r.tier, "local_only", "an already-secret note must not be downscoped by a clean scan");
});

test("I14 · a public note with a planted key is RAISED to secret", () => {
  const r = classify(
    { text: "key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345", currentTier: "public" },
    patterns,
  );
  assert.equal(r.tier, "local_only");
  assert.equal(r.blocking, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// D14 / I15 · gate/rescan-on-pattern-change
// ─────────────────────────────────────────────────────────────────────────────

test("I15 · the pattern set is content-hashed and the hash is stamped on every decision", () => {
  assert.match(patterns.hash, /^[a-f0-9]{64}$/);
  const r = classify({ text: "x" }, patterns);
  assert.equal(r.patternHash, patterns.hash,
    "every classification records WHICH pattern set decided it, or a re-scan cannot be targeted");
});

test("I15 · gate/rescan-on-pattern-change — a changed set blocks until a re-scan", () => {
  assert.equal(rescanRequired(patterns, patterns.hash).required, false,
    "a corpus scanned under the active set is fine");

  const stale = rescanRequired(patterns, "0".repeat(64));
  assert.equal(stale.required, true, "a stale stamp must block");
  assert.match(stale.reason, /changed since the last full scan/);
  assert.match(stale.reason, /nothing retroactively/,
    "the reason must state WHY, or the next person will just re-stamp it");

  const never = rescanRequired(patterns, null);
  assert.equal(never.required, true, "a corpus never scanned must block");
});

test("I15 · the full loop — a FUTURE key shape is invisible until the set changes", () => {
  // The defect end to end. Ingest a note containing a shape the current set does
  // not know; assert it passes; add the pattern; assert the gate now demands a
  // re-scan of the corpus that was already classified.
  const dir = mkdtempSync(join(tmpdir(), "sutra-rescan-"));
  mkdirSync(join(dir, "automation/policies"), { recursive: true });
  const setPath = join(dir, PATTERN_SET_REL);

  const v1 = { version: 1, rules: [{ id: "known", band: "definite", pattern: "kn0wn-[a-z]{10}", provider: null, description: "a known shape", fixture: "kn0wn-abcdefghij" }], floor_paths: [], ocr_engines: [], ocr_floor_tier: "local_only", benign: [] };
  writeFileSync(setPath, JSON.stringify(v1));
  clearPatternCache();
  const before = loadPatternSet(dir);

  const futureShape = "futr-key-abcdefghijklmnop";
  const missed = classify({ text: `token: ${futureShape}` }, before);
  assert.equal(missed.tier, "review_required",
    "the future shape is invisible to the current set — this is the premise, not the bug");

  const stampedAtScanTime = before.hash;

  const v2 = { ...v1, version: 2, rules: [...v1.rules, { id: "future", band: "definite", pattern: "futr-key-[a-z]{16}", provider: null, description: "the newly-learned shape", fixture: futureShape }] };
  writeFileSync(setPath, JSON.stringify(v2));
  clearPatternCache();
  const after = loadPatternSet(dir);

  // THE DEFECT: with no re-scan trigger, the improved list changes nothing.
  const gate = rescanRequired(after, stampedAtScanTime);
  assert.equal(gate.required, true,
    "improving the list MUST invalidate the previous scan — otherwise thirteen credential-bearing " +
    "sources sit at hosted tier while the patterns that would catch them are being written");

  // …and after the re-scan, the note is re-tiered upward.
  const rescanned = classify({ text: `token: ${futureShape}`, currentTier: "public" }, after);
  assert.equal(rescanned.tier, "local_only");
  assert.equal(rescanRequired(after, after.hash).required, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// D6 · the scanner fails CLOSED
// ─────────────────────────────────────────────────────────────────────────────

test("D6 · a missing pattern set THROWS rather than classifying with no rules", () => {
  const empty = mkdtempSync(join(tmpdir(), "sutra-nopatterns-"));
  clearPatternCache();
  assert.throws(() => loadPatternSet(empty), /Refusing to classify|not found/,
    "a scanner with an empty list reports every file clean — the most dangerous failure here");
  clearPatternCache();
});

test("D6 · an unparseable pattern set THROWS", () => {
  const dir = mkdtempSync(join(tmpdir(), "sutra-badpatterns-"));
  mkdirSync(join(dir, "automation/policies"), { recursive: true });
  writeFileSync(join(dir, PATTERN_SET_REL), "{ not json");
  clearPatternCache();
  assert.throws(() => loadPatternSet(dir), /unparseable/);
  clearPatternCache();
});

test("toJsRegExp translates the inline flags PowerShell and Python share", () => {
  assert.equal(toJsRegExp("(?i)abc").flags.includes("i"), true);
  assert.equal(toJsRegExp("(?i)abc").source, "abc");
  assert.equal(toJsRegExp("abc").flags.includes("i"), false);
});
