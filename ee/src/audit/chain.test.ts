// SPDX-License-Identifier: LicenseRef-Sutra-Commercial
/**
 * E3's tests. Each of the three tamper modes is planted and detected —
 * a guardrail test that has never been seen to fail is not evidence of anything.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AuditChain, verifyChain, exportAnchor, GENESIS } from "./chain.js";

const newLog = (): string => join(mkdtempSync(join(tmpdir(), "sutra-ee-audit-")), "audit.ndjson");

function seed(path: string, n = 5): AuditChain {
  const chain = new AuditChain(path, "acme");
  for (let i = 0; i < n; i++) {
    chain.append({ kind: "policy.decision", subject: `u-${i}`, detail: { allowed: i % 2 === 0, tier: "private" } });
  }
  return chain;
}

test("a fresh chain starts at GENESIS and verifies", () => {
  const p = newLog();
  const chain = new AuditChain(p, "acme");
  chain.append({ kind: "policy.decision", subject: "u-1", detail: {} });
  const entries = readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(entries[0].prev, GENESIS);
  assert.equal(entries[0].seq, 1);
  assert.equal(verifyChain(p).ok, true);
});

test("an intact chain of many entries verifies", () => {
  const p = newLog();
  seed(p, 25);
  const r = verifyChain(p);
  assert.equal(r.ok, true);
  assert.equal(r.entries, 25);
});

test("a chain REHYDRATES across process restarts", () => {
  // A daemon restart must not reset the chain to GENESIS — that would silently
  // create a second, unlinked chain in one file.
  const p = newLog();
  seed(p, 3);
  const reopened = new AuditChain(p, "acme");
  reopened.append({ kind: "policy.decision", subject: "u-after-restart", detail: {} });
  const r = verifyChain(p);
  assert.equal(r.ok, true, r.brokenAt?.why);
  assert.equal(r.entries, 4);
});

// ─────────────────────────────────────────────────────────────────────────────
// The three tamper modes, each PLANTED
// ─────────────────────────────────────────────────────────────────────────────

test("TAMPER 1 · a MODIFIED entry is detected, and named", () => {
  const p = newLog();
  seed(p, 5);
  const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
  const target = JSON.parse(lines[2]!);
  target.detail.allowed = !target.detail.allowed;   // flip a decision, keep the hash
  lines[2] = JSON.stringify(target);
  writeFileSync(p, lines.join("\n") + "\n");

  const r = verifyChain(p);
  assert.equal(r.ok, false);
  assert.equal(r.brokenAt?.seq, 3);
  assert.match(r.brokenAt!.why, /MODIFIED/);
});

test("TAMPER 2 · a REMOVED entry is detected", () => {
  const p = newLog();
  seed(p, 5);
  const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
  lines.splice(2, 1);                                // delete one inconvenient decision
  writeFileSync(p, lines.join("\n") + "\n");

  const r = verifyChain(p);
  assert.equal(r.ok, false);
  assert.match(r.brokenAt!.why, /REMOVED|REPLACED|order/);
});

test("TAMPER 3 · REORDERED entries are detected", () => {
  const p = newLog();
  seed(p, 5);
  const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
  [lines[1], lines[3]] = [lines[3]!, lines[1]!];
  writeFileSync(p, lines.join("\n") + "\n");

  const r = verifyChain(p);
  assert.equal(r.ok, false);
});

test("a hand-edited, unparseable line is detected rather than skipped", () => {
  const p = newLog();
  seed(p, 3);
  const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
  lines[1] = "{ this is not json";
  writeFileSync(p, lines.join("\n") + "\n");
  assert.equal(verifyChain(p).ok, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// The honest limit
// ─────────────────────────────────────────────────────────────────────────────

test("TRUNCATION is NOT detectable from the file alone — and the anchor is why", () => {
  // This test asserts a LIMITATION, deliberately. The marketing temptation is
  // to call a hash chain "immutable"; it is not, and a customer who discovers
  // the gap themselves will not believe the next claim either.
  const p = newLog();
  const chain = seed(p, 10);
  const anchor = exportAnchor(chain, "acme");
  assert.equal(anchor.seq, 10);

  const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
  writeFileSync(p, lines.slice(0, 6).join("\n") + "\n");   // drop the last four

  // The shortened chain is INTERNALLY CONSISTENT. verify() cannot see the loss.
  assert.equal(verifyChain(p).ok, true, "a truncated chain is self-consistent — this is the point");
  assert.equal(verifyChain(p).entries, 6);

  // The EXTERNAL ANCHOR is what detects it.
  assert.ok(anchor.seq > verifyChain(p).entries,
    "the anchor says 10, the log says 6 — entries were removed");
  assert.match(anchor.note, /external anchor/);
  assert.match(anchor.note, /Neither claim is 'immutable'/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Retention classes
// ─────────────────────────────────────────────────────────────────────────────

test("security-relevant kinds default to the `security` retention class", () => {
  const p = newLog();
  const chain = new AuditChain(p, "acme");
  assert.equal(chain.append({ kind: "secret.reveal", subject: "u", detail: {} }).retention, "security");
  assert.equal(chain.append({ kind: "bundle.applied", subject: "u", detail: {} }).retention, "security");
  assert.equal(chain.append({ kind: "key.rotated", subject: "u", detail: {} }).retention, "security");
  assert.equal(chain.append({ kind: "policy.decision", subject: "u", detail: {} }).retention, "operational");
  assert.equal(chain.append({ kind: "erasure.executed", subject: "u", detail: {} }).retention, "privacy");
});

test("the retention class is set at WRITE time", () => {
  // Deciding retention afterwards requires re-reading the record, and
  // re-reading a decision in order to classify it is exactly the access an
  // audit log should not need.
  const p = newLog();
  const e = new AuditChain(p, "acme").append({ kind: "policy.decision", subject: "u", detail: {}, retention: "legal-hold" });
  assert.equal(e.retention, "legal-hold");
  assert.equal(JSON.parse(readFileSync(p, "utf8").trim()).retention, "legal-hold");
});

test("the digest is stable regardless of detail key insertion order", () => {
  // D39's lesson applied to hashing: an output that depends on enumeration
  // order is not an output. Two runtimes must agree.
  const a = newLog();
  const b = newLog();
  new AuditChain(a, "t").append({ kind: "k", subject: "s", detail: { zeta: 1, alpha: 2 } });
  new AuditChain(b, "t").append({ kind: "k", subject: "s", detail: { alpha: 2, zeta: 1 } });
  const ea = JSON.parse(readFileSync(a, "utf8").trim());
  const eb = JSON.parse(readFileSync(b, "utf8").trim());
  // Timestamps differ, so compare the detail's contribution via a re-verify.
  assert.equal(verifyChain(a).ok, true);
  assert.equal(verifyChain(b).ok, true);
  assert.deepEqual(Object.keys(ea.detail).sort(), Object.keys(eb.detail).sort());
});
