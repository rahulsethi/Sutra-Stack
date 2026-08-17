// SPDX-License-Identifier: Apache-2.0
/**
 * D38 · `tier/named-third-party` — THE DEFECT WHERE EVERY GATE WORKED.
 *
 * A sweep of the upstream corpus found **27 files at hosted-egress tier naming
 * real customers**, with substantive delivery detail. Nothing was misconfigured.
 * Nothing failed. Every gate did exactly what it was told.
 *
 * The defect is in the question the gates were asking:
 *
 *   **tier encodes "may this leave the machine", not "whose information is
 *   this" — and those two questions have different answers.**
 *
 * Personal-sensitivity heuristics never fire on a client name, because a client
 * name is not sensitive *to the author* at all. So third-party identifiability
 * is a SEPARATE, ORTHOGONAL axis (I21).
 *
 * ── AND THE REMEDY IS NOT RE-TIERING ───────────────────────────────────────
 * Re-tiering silently degrades whatever lane was built on the material, turning
 * a governance fix into a functional regression. The default remedy is to
 * GENERALISE IN PLACE. Hence: warn, do not block; alias on the way out; never
 * mutate at rest. Three of the tests below exist only to hold that line.
 *
 * ── THE FIXTURES ARE FICTIONAL, DELIBERATELY ───────────────────────────────
 * The upstream alias map named a national oil company and two pharmaceutical
 * firms. It is `local_only` by nature and the shipped map is asserted EMPTY by
 * the leak scan. Every name below is invented for this test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALIAS_MAP_REL,
  loadRedactionMap,
  redactText,
  maskSensitiveNumbers,
  findNamedThirdParties,
  MASK_FIXTURES,
  MASK_PATTERN_NAMES,
  type RedactionEntry,
} from "./redact.js";

function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string };
      if (pkg.name === "sutra") return dir;
    } catch { /* keep walking */ }
    dir = dirname(dir);
  }
  return "";
}

/** An alias map of invented names, in the shape the real one takes. */
const MAP: RedactionEntry[] = [
  { alias: "a national energy company", match: ["Northwind Petroleum", "Northwind", "NWP"] },
  { alias: "a European pharmaceutical company", match: ["Zenthara Pharma AG", "Zenthara"] },
  { alias: "a Nordic manufacturer", match: ["Kvalheim Industries", "Kvalheim"] },
];

// ─────────────────────────────────────────────────────────────────────────────
// D38 · the axis tier does not have
// ─────────────────────────────────────────────────────────────────────────────

test("D38 · A PUBLIC-TIER NOTE NAMING A CLIENT IS FLAGGED — the 27 files", () => {
  // The exact upstream shape: a note correctly tiered for hosted egress, with no
  // key, no PII, no health data, naming a customer alongside delivery detail.
  // Every sensitivity heuristic passes it. This is the only check that does not.
  const note =
    "Migration status for Northwind Petroleum: cutover slipped two weeks after the " +
    "reconciliation defect in their settlement feed. Zenthara Pharma AG is unaffected.";

  const found = findNamedThirdParties(note, MAP);
  assert.equal(found.length, 2, "a note naming two customers at hosted tier was not flagged");
  assert.deepEqual(
    found.map((f) => f.alias).sort(),
    ["a European pharmaceutical company", "a national energy company"],
  );
});

test("D38 · THE REMEDY IS `generalise in place`, EXPLICITLY NOT RE-TIERING", () => {
  // The most important assertion in this file. Auto-re-tiering would look like
  // the responsible fix and would silently break whatever lane was built on the
  // material — a governance fix becoming a functional regression.
  const found = findNamedThirdParties("Work for Kvalheim Industries continues.", MAP);
  assert.equal(found.length, 1);
  assert.match(found[0]!.remedy, /generalise in place/);
  assert.match(found[0]!.remedy, /Do NOT re-tier/);
  assert.match(found[0]!.remedy, /degrades whatever lane was built/,
    "the remedy must say WHY re-tiering is wrong, or the next person will do it anyway");
});

test("D38 · the check is WARN-ONLY — it reports and does not mutate", () => {
  // I21 ships as a warning by design. A blocking check on an orthogonal axis
  // with a generalise-in-place remedy would stop work it cannot correctly fix.
  const note = "Northwind Petroleum signed.";
  const before = note;
  findNamedThirdParties(note, MAP);
  assert.equal(note, before, "the check mutated its input");

  // …and it returns findings rather than throwing, so a caller can report all of
  // them at once.
  assert.doesNotThrow(() => findNamedThirdParties(note, MAP));
});

test("D38 · AN UNCONFIGURED DEPLOYMENT IS SILENT — no false positives on day one", () => {
  // A check that cries wolf on a fresh install is ignored by the end of the
  // first week, and then it is not a check.
  assert.deepEqual(findNamedThirdParties("Northwind Petroleum signed.", []), []);
  assert.deepEqual(findNamedThirdParties("anything at all", [{ alias: "x", match: [] }]), []);
});

test("D38 · a name that is not in the map does not fire", () => {
  assert.deepEqual(findNamedThirdParties("Met with the platform team about latency.", MAP), []);
});

test("D38 · each distinct name is reported ONCE, however often it appears", () => {
  const note = "Northwind. Northwind again. And NORTHWIND once more. Northwind Petroleum too.";
  const found = findNamedThirdParties(note, MAP);
  // "Northwind" and "Northwind Petroleum" are two distinct matched spellings of
  // one alias; repeats of each collapse.
  assert.ok(found.length <= 2, `${found.length} findings for one company — the report would be noise`);
  assert.ok(found.every((f) => f.alias === "a national energy company"));
});

// ─────────────────────────────────────────────────────────────────────────────
// The aliasing itself
// ─────────────────────────────────────────────────────────────────────────────

test("D38 · LONGEST MATCH WINS — a half-redacted name is still identifying", () => {
  // "Northwind Petroleum" must not become "a national energy company Petroleum".
  const { text } = redactText("Northwind Petroleum confirmed the date.", MAP);
  assert.equal(text, "a national energy company confirmed the date.");
  assert.ok(!/Petroleum/.test(text), "the longer name was half-redacted and remains identifying");
});

test("D38 · UNICODE WORD BOUNDARIES — an accented name does not leak through", () => {
  // JavaScript's `\b` is ASCII-only, so a standalone accented name would pass
  // straight to a hosted surface while the PowerShell twin (.NET `\b`) caught
  // it. That divergence is exactly what E1 is about: one rule, N bindings, and
  // every divergence fails open in at least one of them.
  const map: RedactionEntry[] = [{ alias: "a Swiss food company", match: ["Nestlaré", "Société Ténérale"] }];

  assert.equal(redactText("Nestlaré confirmed.", map).text, "a Swiss food company confirmed.");
  assert.equal(redactText("Société Ténérale replied.", map).text, "a Swiss food company replied.");

  // …and the boundary still HOLDS: a longer word merely containing the name is
  // not a match.
  assert.match(redactText("Nestlaréan dialect", map).text, /Nestlaréan/,
    "the boundary matched inside a longer word");
});

test("D38 · matching is case-insensitive, and the ALIAS is not", () => {
  const { text, count } = redactText("NORTHWIND and northwind and Northwind.", MAP);
  assert.equal(count, 3);
  assert.equal(text, "a national energy company and a national energy company and a national energy company.");
});

test("D38 · `count` is the audit number — zero is a normal answer", () => {
  assert.equal(redactText("nothing to alias here", MAP).count, 0);
  assert.equal(redactText("Kvalheim and Zenthara", MAP).count, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// Number masking — the other half of egress redaction
// ─────────────────────────────────────────────────────────────────────────────

test("masking keeps the LAST FOUR digit positions and the shape", () => {
  assert.equal(maskSensitiveNumbers("1234 5678 9012"), "XXXX XXXX 9012");
  assert.equal(maskSensitiveNumbers("account no: 123456789012"), "account no: XXXXXXXX9012");
});

test("masking · EVERY pattern has a fixture it VISIBLY CHANGES", () => {
  // "A rule that fires zero times looks exactly like a rule protecting a clean
  // corpus." A mask pattern has a second, quieter way to be dead: it MATCHES,
  // and then returns its input unchanged.
  //
  // `pan-india` was exactly that. A PAN is `AAAAA9999A` — exactly four digits —
  // and the mask keeps the last four digits, so it kept all of them. The rule
  // was live-looking and inert, and it was found by this test on its first run.
  const inert: string[] = [];
  for (const { name, input } of MASK_FIXTURES) {
    if (maskSensitiveNumbers(input) === input) inert.push(`${name} — "${input}" came back unchanged`);
  }
  assert.deepEqual(
    inert,
    [],
    "MASK PATTERN(S) THAT MATCH AND MASK NOTHING:\n" + inert.join("\n") +
    "\n\nA pattern that returns its input is a dead rule wearing a live rule's clothes.",
  );

  // …and every pattern is covered, so a new one cannot be added without a fixture.
  const covered = new Set(MASK_FIXTURES.map((f) => f.name));
  const uncovered = MASK_PATTERN_NAMES.filter((n) => !covered.has(n));
  assert.deepEqual(uncovered, [], `mask pattern(s) with no fixture: ${uncovered.join(", ")}`);
});

test("masking · a PAN is masked on ALPHANUMERIC positions, keeping the tail", () => {
  // The fix for the dead rule above. A PAN has too few digits for the digit
  // rule to bite, so it counts letters and digits alike.
  const pan = maskSensitiveNumbers("PAN ABCDE1234F on file");
  assert.equal(pan, "PAN XXXXXX234F on file");
  assert.match(pan, /on file$/, "surrounding prose was masked");
  assert.match(pan, /^PAN /, "the label was masked");
});

test("masking · NO MORE THAN FOUR DIGITS SURVIVE, on every fixture", () => {
  // The property the whole module exists for, asserted as a property rather
  // than as a set of expected strings — because the way it broke was not a
  // failed match. It was a SHORTER pattern winning the overlap and masking only
  // part of a longer number, leaving output that still looks masked.
  //
  // `4539 5678 9012 3456` came back `XXXX XXXX 9012 3456`: eight digits
  // published instead of four, on a card.
  for (const { name, input } of MASK_FIXTURES) {
    const before = (input.match(/\d/g) ?? []).length;
    const after = (maskSensitiveNumbers(input).match(/\d/g) ?? []).length;
    if (before <= 4) continue;
    assert.ok(
      after <= 4,
      `${name}: ${after} digits survived masking of "${input}" — at most 4 may. A shorter pattern ` +
      `is winning the overlap and half-masking a longer number.`,
    );
  }
});

test("masking · a CARD is masked to its last four, not its last eight", () => {
  // The regression, pinned to the literal string. Digits chosen so a partial
  // mask is visible — an all-1s test card hides this defect completely.
  assert.equal(maskSensitiveNumbers("4539 5678 9012 3456"), "XXXX XXXX XXXX 3456");
  assert.equal(maskSensitiveNumbers("4539567890123456"), "XXXXXXXXXXXX3456");
  assert.equal(maskSensitiveNumbers("card 5412-7512-3412-3456 exp"), "card XXXX-XXXX-XXXX-3456 exp");
});

test("masking · the LONGER shape wins the overlap, and the shorter still fires", () => {
  // Ordering is load-bearing: `credit-card` (16 digits) precedes `aadhaar` (12),
  // and the catch-all runs last so it cannot pre-empt anything specific. The
  // second assertion is the one that keeps the fix honest — reordering must not
  // starve the shorter pattern.
  const order = MASK_PATTERN_NAMES;
  assert.ok(order.indexOf("credit-card") < order.indexOf("aadhaar"),
    "credit-card no longer precedes aadhaar — a card will be half-masked again");
  assert.equal(order[order.length - 1], "unlabelled-long-digits",
    "the catch-all is no longer last — it will now pre-empt the specific shapes above it");

  assert.equal(maskSensitiveNumbers("uid 4539 5678 9012"), "uid XXXX XXXX 9012",
    "a 12-digit id was starved by the 16-digit pattern running first");
});

test("masking · a LABELLED account keeps its label — the `alnum` unit is per-pattern", () => {
  // Why `unit` is not global: `bank-account-long` matches its own `account no:`
  // prefix, and counting letters there would mask the label into `XXXXXXX`.
  const out = maskSensitiveNumbers("account no: 123456789012");
  assert.match(out, /^account no: /, "the label was masked along with the number");
  assert.equal(out, "account no: XXXXXXXX9012");
});

test("masking · four digits or fewer are left alone", () => {
  // Masking a year or a small quantity would corrupt ordinary prose and get
  // redaction switched off.
  assert.equal(maskSensitiveNumbers("in 2026 we shipped 42 units"), "in 2026 we shipped 42 units");
});

test("masking · never throws, on any input", () => {
  for (const s of ["", " ", "𝔘𝔫𝔦𝔠𝔬𝔡𝔢 1234567890123", "a".repeat(10_000)]) {
    assert.doesNotThrow(() => maskSensitiveNumbers(s));
  }
});

test("aliasing runs BEFORE masking — an alias may contain digits", () => {
  const map: RedactionEntry[] = [{ alias: "supplier 100000000001", match: ["Kvalheim"] }];
  const { text } = redactText("Kvalheim invoiced us.", map);
  assert.match(text, /supplier XXXXXXXX0001/, "the alias's own digits escaped masking");
});

// ─────────────────────────────────────────────────────────────────────────────
// The map ships empty
// ─────────────────────────────────────────────────────────────────────────────

test("D38 · THE SHIPPED ALIAS MAP IS EMPTY — it is a list of real names", () => {
  // The map is `local_only` by nature: it is, literally, a list of the customers
  // whose names must not be sent. Shipping it populated would publish exactly
  // what it exists to protect. The leak scan asserts this too; asserting it here
  // as well is deliberate — this is the file a contributor is editing when they
  // are most tempted to add one.
  const root = findRepoRoot();
  if (!root) {
    console.log("    (skipped — repo root not found; this asks about the shipped tree)");
    return;
  }
  const p = join(root, ALIAS_MAP_REL);
  if (!existsSync(p)) return;   // absent is also empty

  const entries = loadRedactionMap(root);
  assert.deepEqual(entries, [], `${ALIAS_MAP_REL} SHIPS POPULATED — it names real third parties`);
});

test("a missing or malformed map means NO ALIASING, never an exception", () => {
  // Note the asymmetry with `loadPatternSet`, which THROWS on a missing file.
  // There, an empty rule set silently declares everything safe. Here, an empty
  // map declares nothing aliased — merely unhelpful — and the tier gate is still
  // doing the actual protecting. Throwing at egress time would push callers
  // toward skipping redaction entirely.
  assert.deepEqual(loadRedactionMap(join("/nonexistent", String(Math.random()))), []);
  assert.doesNotThrow(() => redactText("text", "/nonexistent/map.json"));
  assert.equal(redactText("account 123456789012", "/nonexistent/map.json").text, "account XXXXXXXX9012",
    "masking must still run when aliasing is unconfigured");
});
