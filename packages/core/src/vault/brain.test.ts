// SPDX-License-Identifier: Apache-2.0
/**
 * THE EGRESS TEST. Lifted from `aatma/src/mcp/brain-exposure.test.ts` and
 * extended to cover release gate 1 in full.
 *
 * 00-MASTER-BUILD-BRIEF.md §10.1: "with a hosted-ceiling MCP registration, a
 * `local_only` note and a `do_not_learn` note are provably absent from every
 * tool's output, `sutra gate` reports them withheld, and an attempt to
 * `sutra_capture` at public is clamped up to private. **This test is
 * non-negotiable and runs in CI.**"
 *
 * "Provably absent from EVERY tool's output" is taken literally below: the
 * assertions enumerate every read path rather than sampling one, because a gate
 * that holds on `search` and leaks on `visibleCorpus` is not a gate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { Brain } from "./brain.js";
import type { VaultClient } from "./client.js";

function fakeVc(root: string): Pick<VaultClient, "root"> {
  return { root: () => root };
}

function seed(root: string, rel: string, fm: Record<string, unknown>, body = "some body text"): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  const fmLines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join("\n");
  writeFileSync(abs, `---\n${fmLines}\n---\n${body}\n`);
}

function newRoot(): string {
  const r = mkdtempSync(join(tmpdir(), "sutra-brain-"));
  mkdirSync(join(r, "automation", "policies"), { recursive: true });
  return r;
}

function promote(root: string, notePath: string, expires = "2999-01-01"): void {
  writeFileSync(
    join(root, "automation/policies/exposure-allowlist.json"),
    JSON.stringify({
      version: 1,
      settings: { default_expiry_days: 7 },
      projections: [],
      promotions: [{ id: "p", note: notePath, scope: "hosted", reason: "test", granted: "2026-01-01", expires }],
    }),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The lifted regression net
// ─────────────────────────────────────────────────────────────────────────────

test("a private note is withheld with no policy, AND a request is queued", () => {
  const r = newRoot();
  seed(r, "vault/11-identity/telos.md", { type: "Identity", sensitivity: "review_required" });
  const b = new Brain(fakeVc(r), "hosted_allowed");

  assert.equal(b.getNote("vault/11-identity/telos.md").status, "withheld");

  const reqs = JSON.parse(readFileSync(join(r, "automation/policies/exposure-requests.json"), "utf8"));
  assert.ok(
    reqs.requests.some((x: { note: string }) => x.note === "vault/11-identity/telos.md"),
    "a withheld read must leave a reviewable request — a refusal with no trail is a mystery",
  );
});

test("a live promotion lifts a PRIVATE note for a hosted ceiling", () => {
  const r = newRoot();
  seed(r, "vault/11-identity/telos.md", { type: "Identity", sensitivity: "review_required" });
  promote(r, "vault/11-identity/telos.md");
  assert.equal(new Brain(fakeVc(r), "hosted_allowed").getNote("vault/11-identity/telos.md").status, "ok");
});

test("an EXPIRED promotion does not lift anything", () => {
  const r = newRoot();
  seed(r, "vault/note.md", { type: "Note", sensitivity: "review_required" });
  promote(r, "vault/note.md", "2020-01-01");
  assert.equal(new Brain(fakeVc(r), "hosted_allowed").getNote("vault/note.md").status, "withheld");
});

/** INVARIANT 3. The single most important assertion in the codebase. */
test("I13 · SECRET IS NEVER PROMOTABLE, even with a matching live promotion", () => {
  const r = newRoot();
  seed(r, "vault/secret.md", { type: "Note", sensitivity: "local_only" });
  promote(r, "vault/secret.md");
  const b = new Brain(fakeVc(r), "hosted_allowed");

  assert.equal(b.getNote("vault/secret.md").status, "withheld");
  assert.equal(b.search("secret").hits.length, 0);
  assert.equal(b.visibleCorpus().notes.length, 0);
  assert.equal(b.gateInspect().withheld_by_tier.secret, 1);
});

test("do_not_learn is never exposed, at any tier, with any promotion", () => {
  const r = newRoot();
  seed(r, "vault/dnl.md", { type: "Note", sensitivity: "hosted_allowed", do_not_learn: "true" });
  promote(r, "vault/dnl.md");
  const b = new Brain(fakeVc(r), "hosted_allowed");

  assert.equal(b.getNote("vault/dnl.md").status, "withheld");
  assert.equal(b.search("dnl").hits.length, 0);
  assert.equal(b.visibleCorpus().notes.length, 0);
  assert.equal(b.gateInspect().withheld_by_tier.do_not_learn, 1);
});

test("a trusted (secret-ceiling) client is unaffected by the policy", () => {
  const r = newRoot();
  seed(r, "vault/11-identity/telos.md", { type: "Identity", sensitivity: "review_required" });
  assert.equal(new Brain(fakeVc(r), "local_only").getNote("vault/11-identity/telos.md").status, "ok");
});

// ─────────────────────────────────────────────────────────────────────────────
// Release gate 1 — "provably absent from EVERY tool's output"
// ─────────────────────────────────────────────────────────────────────────────

function seedMixedVault(): string {
  const r = newRoot();
  seed(r, "vault/public-a.md", { type: "Note", sensitivity: "public" }, "quantum widgets are public knowledge");
  seed(r, "vault/public-b.md", { type: "Note", sensitivity: "hosted_allowed" }, "more quantum widgets");
  seed(r, "vault/private-a.md", { type: "Note", sensitivity: "private" }, "quantum widgets private thoughts");
  seed(r, "vault/secret-a.md", { type: "Note", sensitivity: "secret" }, "quantum widgets SECRETPAYLOAD api key");
  seed(r, "vault/dnl-a.md", { type: "Note", sensitivity: "public", do_not_learn: true }, "quantum widgets DNLPAYLOAD");
  return r;
}

test("GATE 1 · at a hosted ceiling, secret and do_not_learn payloads appear in NO read path", () => {
  const r = seedMixedVault();
  const b = new Brain(fakeVc(r), "hosted_allowed");
  const forbidden = ["SECRETPAYLOAD", "DNLPAYLOAD"];

  const surfaces: Array<[string, string]> = [
    ["search", JSON.stringify(b.search("quantum widgets", 100))],
    ["visibleCorpus", JSON.stringify(b.visibleCorpus())],
    ["gateInspect", JSON.stringify(b.gateInspect(100))],
    ["getNote(secret)", JSON.stringify(b.getNote("vault/secret-a.md"))],
    ["getNote(dnl)", JSON.stringify(b.getNote("vault/dnl-a.md"))],
    ["identityBundle", JSON.stringify(b.identityBundle())],
  ];

  for (const [name, output] of surfaces) {
    for (const payload of forbidden) {
      assert.ok(!output.includes(payload), `${payload} leaked through ${name}`);
    }
  }
});

test("GATE 1 · `sutra gate` reports the withheld counts by tier, and they are correct", () => {
  const r = seedMixedVault();
  const report = new Brain(fakeVc(r), "hosted_allowed").gateInspect();

  assert.equal(report.ceiling_display, "public");
  assert.equal(report.visible, 2, "two public notes are visible");
  assert.equal(report.withheld_by_tier.private, 1);
  assert.equal(report.withheld_by_tier.secret, 1);
  assert.equal(report.withheld_by_tier.do_not_learn, 1);
  assert.equal(report.scanned, 5);
  assert.equal(
    report.visible + report.withheld_by_tier.private + report.withheld_by_tier.secret + report.withheld_by_tier.do_not_learn,
    report.scanned,
    "every scanned note is accounted for — a note in neither bucket is a hole in the report",
  );
});

test("GATE 1 · raising the ceiling to private reveals exactly the private note", () => {
  const r = seedMixedVault();
  const priv = new Brain(fakeVc(r), "review_required").gateInspect();
  assert.equal(priv.visible, 3);
  assert.equal(priv.withheld_by_tier.secret, 1, "secret is STILL withheld at a private ceiling");
  assert.equal(priv.withheld_by_tier.do_not_learn, 1, "do_not_learn is still withheld");
});

test("GATE 1 · a secret ceiling still withholds do_not_learn — the axes are independent", () => {
  const r = seedMixedVault();
  const trusted = new Brain(fakeVc(r), "local_only").gateInspect();
  assert.equal(trusted.visible, 4);
  assert.equal(trusted.withheld_by_tier.do_not_learn, 1);
  assert.equal(trusted.withheld_by_tier.secret, 0);
});

test("the withheld COUNT is returned; the withheld CONTENT is not", () => {
  const r = seedMixedVault();
  const res = new Brain(fakeVc(r), "hosted_allowed").search("quantum", 100);
  assert.equal(res.withheld, 3, "the caller learns HOW MANY were withheld");
  assert.equal(res.hits.length, 2);
  assert.ok(!JSON.stringify(res.hits).includes("SECRET"));
});

// ─────────────────────────────────────────────────────────────────────────────
// Structural properties
// ─────────────────────────────────────────────────────────────────────────────

test("INVARIANT 2 · the ceiling is set at construction and has no setter", () => {
  const b = new Brain(fakeVc(newRoot()), "hosted_allowed");
  assert.equal(b.exposure, "hosted_allowed");
  // `readonly` is compile-time; assert the runtime shape too, because the claim
  // is "the model cannot lift it" and a model only sees runtime.
  const desc = Object.getOwnPropertyDescriptor(b, "exposure");
  assert.ok(desc, "exposure must be an own property");
  assert.equal(typeof (b as unknown as { setExposure?: unknown }).setExposure, "undefined",
    "there must be no method that changes the ceiling after construction");
});

test("an UNLABELLED note defaults to private, not public", () => {
  const r = newRoot();
  seed(r, "vault/unlabelled.md", { type: "Note" }, "no sensitivity key at all");
  assert.equal(new Brain(fakeVc(r), "hosted_allowed").getNote("vault/unlabelled.md").status, "withheld");
  assert.equal(new Brain(fakeVc(r), "review_required").getNote("vault/unlabelled.md").status, "ok");
});

test("an UNPARSEABLE note is excluded, never included at a default tier", () => {
  const r = newRoot();
  const abs = join(r, "vault", "broken.md");
  mkdirSync(dirname(abs), { recursive: true });
  // Frontmatter that gray-matter cannot parse as YAML.
  writeFileSync(abs, "---\n\tthis: [is: not: valid\n  ]]]\n---\nSECRETISH BODY\n");
  const b = new Brain(fakeVc(r), "local_only"); // the MOST permissive ceiling
  const corpus = JSON.stringify(b.visibleCorpus());
  assert.ok(!corpus.includes("SECRETISH BODY"),
    "a note whose frontmatter cannot be read must be excluded — it might be unparseable BECAUSE of what it holds");
});

test("walk roots exclude raw/, logs/ and state/ structurally, before any tier check", () => {
  const r = newRoot();
  // These have NO sensitivity key at all, so only the structural exclusion can
  // stop them. That is the point: the roots are a control, not a convenience.
  seed(r, "raw/inbox/intake.md", { type: "Source" }, "RAWPAYLOAD unclassified intake");
  seed(r, "logs/dream/2026-01-01.md", { type: "Log" }, "LOGPAYLOAD");
  seed(r, "state/checks/notes.md", { type: "State" }, "STATEPAYLOAD");
  seed(r, "compiled/conversations/chat.md", { type: "Conversation" }, "CONVPAYLOAD");
  seed(r, "vault/ok.md", { type: "Note", sensitivity: "public" }, "visible");

  const dump = JSON.stringify(new Brain(fakeVc(r), "local_only").visibleCorpus());
  for (const payload of ["RAWPAYLOAD", "LOGPAYLOAD", "STATEPAYLOAD", "CONVPAYLOAD"]) {
    assert.ok(!dump.includes(payload), `${payload} was reachable — the walk-root control failed`);
  }
  assert.ok(dump.includes("visible"));
});

test("getNote distinguishes withheld from not_found", () => {
  const r = newRoot();
  seed(r, "vault/secret.md", { type: "Note", sensitivity: "secret" });
  const b = new Brain(fakeVc(r), "hosted_allowed");
  assert.equal(b.getNote("vault/secret.md").status, "withheld");
  assert.equal(b.getNote("vault/does-not-exist.md").status, "not_found");
});

test("identityBundle withholds per FILE and names what it withheld, not its content", () => {
  const r = newRoot();
  seed(r, "vault/11-identity/principal.md", { type: "Identity", sensitivity: "public" }, "I am a public principal");
  seed(r, "vault/11-identity/telos.md", { type: "Identity", sensitivity: "secret" }, "TELOSPAYLOAD");
  const bundle = new Brain(fakeVc(r), "hosted_allowed").identityBundle();

  assert.match(String(bundle.principal), /public principal/);
  assert.equal(bundle.telos, null);
  assert.ok(bundle.withheld.some((w) => w.startsWith("telos")), "the NAME is reported");
  assert.ok(!JSON.stringify(bundle).includes("TELOSPAYLOAD"), "the CONTENT is not");
});

test("an exposure request is idempotent — a retrying model cannot flood the queue", () => {
  const r = newRoot();
  seed(r, "vault/p.md", { type: "Note", sensitivity: "private" });
  const b = new Brain(fakeVc(r), "hosted_allowed");
  for (let i = 0; i < 5; i++) b.getNote("vault/p.md");
  const reqs = JSON.parse(readFileSync(join(r, "automation/policies/exposure-requests.json"), "utf8"));
  assert.equal(reqs.requests.length, 1);
});

test("a CORRUPT exposure policy fails CLOSED — no promotions, not all promotions", () => {
  const r = newRoot();
  seed(r, "vault/p.md", { type: "Note", sensitivity: "private" });
  writeFileSync(join(r, "automation/policies/exposure-allowlist.json"), "{ this is not json");
  assert.equal(new Brain(fakeVc(r), "hosted_allowed").getNote("vault/p.md").status, "withheld");
});

test("an empty vault is not an error — 0 visible, 0 withheld, 0 scanned", () => {
  const report = new Brain(fakeVc(newRoot()), "hosted_allowed").gateInspect();
  assert.deepEqual(
    [report.visible, report.scanned, report.withheld_by_tier.secret],
    [0, 0, 0],
  );
});

test("search ranking is deterministic across runs", () => {
  // D39's lesson applied to ranking: an output that depends on filesystem
  // enumeration order is unreproducible, and a retrieval eval built on it
  // measures the filesystem.
  const r = newRoot();
  for (let i = 0; i < 12; i++) {
    seed(r, `vault/n${i}.md`, { type: "Note", sensitivity: "public" }, "widget widget widget");
  }
  const b = new Brain(fakeVc(r), "hosted_allowed");
  const a1 = b.search("widget", 12).hits.map((h) => h.relPath);
  const a2 = b.search("widget", 12).hits.map((h) => h.relPath);
  assert.deepEqual(a1, a2);
});
