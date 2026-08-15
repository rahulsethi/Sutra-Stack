// SPDX-License-Identifier: Apache-2.0
/**
 * The write path's regression net. Release gate 1's third clause: "an attempt
 * to `sutra_capture` at public is clamped up to private."
 *
 * Invariant 6 has four independent properties, and each gets its own test here
 * rather than one composite "capture works" test — because the failure mode
 * that matters is ONE of the four regressing while the others still pass.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeCapture, floorSensitivity, writeAllowed, CAPTURE_FLOOR, CAPTURE_DIR } from "./capture.js";

const newRoot = (): string => mkdtempSync(join(tmpdir(), "sutra-capture-"));

// ── Property 1 · the sensitivity floor ──────────────────────────────────────

test("GATE 1 · a capture requested at PUBLIC is clamped UP to private", () => {
  for (const requested of ["public", "hosted_allowed"]) {
    assert.equal(floorSensitivity(requested), "review_required", `requested ${requested}`);
  }
});

test("a STRICTER request is preserved — the clamp is one-directional", () => {
  assert.equal(floorSensitivity("secret"), "local_only");
  assert.equal(floorSensitivity("local_only"), "local_only");
  assert.equal(floorSensitivity("private"), "review_required");
});

test("missing / unknown / junk sensitivity floors to private", () => {
  for (const v of [undefined, null, "", "garbage", 42, {}, []]) {
    assert.equal(floorSensitivity(v), CAPTURE_FLOOR, `input ${JSON.stringify(v)}`);
  }
});

test("the written note's frontmatter carries the FLOORED tier, never the requested one", () => {
  const root = newRoot();
  const res = writeCapture(root, { text: "hello", sensitivity: "public" });
  assert.equal(res.tier, "review_required");
  assert.equal(res.display, "private");
  assert.equal(res.clamped, true, "the caller is TOLD it was clamped — a silent clamp is a silent surprise");

  const written = readFileSync(res.absPath, "utf8");
  assert.match(written, /^sensitivity: private$/m);
  assert.ok(!/^sensitivity: public$/m.test(written));
});

test("a hosted-exposed caller can NEVER mint public content, over many attempts", () => {
  const root = newRoot();
  for (const attempt of ["public", "hosted_allowed", "PUBLIC", " public ", "hosted"]) {
    const res = writeCapture(root, { text: `attempt ${attempt}`, sensitivity: attempt });
    assert.notEqual(res.display, "public", `"${attempt}" produced public content`);
  }
});

// ── Property 2 · capture-not-durable ────────────────────────────────────────

test("a capture lands ONLY in the inbox — never in a durable or raw tree", () => {
  const root = newRoot();
  const res = writeCapture(root, { text: "hello" });

  assert.ok(res.relPath.startsWith(CAPTURE_DIR + "/"), `wrote to ${res.relPath}`);
  assert.equal(existsSync(join(root, "compiled")), false, "nothing under compiled/");
  assert.equal(existsSync(join(root, "raw")), false, "nothing under raw/");
  assert.equal(existsSync(join(root, "state")), false, "nothing under state/");
});

test("the note is queued for review, not promoted to a durable page", () => {
  const root = newRoot();
  const body = readFileSync(writeCapture(root, { text: "hello" }).absPath, "utf8");
  assert.match(body, /^type: Source$/m, "a Source, not a durable page type");
  assert.match(body, /queued for review, not yet a durable page/);
});

// ── Property 3 · additive, never overwriting ────────────────────────────────

test("two captures in the same second produce two DIFFERENT files", () => {
  const root = newRoot();
  const a = writeCapture(root, { text: "first" });
  const b = writeCapture(root, { text: "second" });
  assert.notEqual(a.absPath, b.absPath);
  assert.equal(readdirSync(join(root, "vault", "00-inbox")).length, 2);
});

test("100 rapid captures produce 100 files — no collision silently overwrites one", () => {
  const root = newRoot();
  for (let i = 0; i < 100; i++) writeCapture(root, { text: `capture ${i}` });
  assert.equal(readdirSync(join(root, "vault", "00-inbox")).length, 100);
});

test("an existing note is never opened for writing", () => {
  const root = newRoot();
  const dir = join(root, "vault", "00-inbox");
  mkdirSync(dir, { recursive: true });
  const victim = join(dir, "existing-important-note.md");
  writeFileSync(victim, "PRECIOUS USER CONTENT\n");

  for (let i = 0; i < 20; i++) writeCapture(root, { text: `capture ${i}`, title: "existing-important-note" });
  assert.equal(readFileSync(victim, "utf8"), "PRECIOUS USER CONTENT\n",
    "a title colliding with an existing filename must not overwrite it");
});

// ── Property 4 · the opt-in gate, fail-closed ───────────────────────────────

test("write-back is OFF by default", () => {
  const r = writeAllowed({});
  assert.equal(r.allowed, false);
  assert.match(r.reason, /SUTRA_MCP_ALLOW_WRITE/);
});

test("an EMPTY env var does not open the gate — the classic silent-open", () => {
  // An unset-but-declared variable is `""` in most shells. A truthiness check
  // would refuse this correctly, but a `!== undefined` check would not — and
  // that is the bug this asserts against.
  assert.equal(writeAllowed({ SUTRA_MCP_ALLOW_WRITE: "" }).allowed, false);
});

test("only an EXPLICIT opt-in opens the gate", () => {
  assert.equal(writeAllowed({ SUTRA_MCP_ALLOW_WRITE: "1" }).allowed, true);
  assert.equal(writeAllowed({ SUTRA_MCP_ALLOW_WRITE: "true" }).allowed, true);
  assert.equal(writeAllowed({ SUTRA_MCP_ALLOW_WRITE: "TRUE" }).allowed, true);

  for (const v of ["0", "false", "yes", "on", "y", "please", "-1"]) {
    assert.equal(writeAllowed({ SUTRA_MCP_ALLOW_WRITE: v }).allowed, false, `"${v}" must not open the gate`);
  }
});

// ── Shape of the written note ───────────────────────────────────────────────

test("empty text throws rather than writing an empty note", () => {
  const root = newRoot();
  assert.throws(() => writeCapture(root, { text: "" }), /must not be empty/);
  assert.throws(() => writeCapture(root, { text: "   \n  " }), /must not be empty/);
});

test("tags are normalised so they cannot corrupt the note's own frontmatter", () => {
  const root = newRoot();
  const res = writeCapture(root, {
    text: "hello",
    tags: ["#one", "two, three", "four]bracket[", "  ", "a/b"],
  });
  const line = readFileSync(res.absPath, "utf8").split("\n").find((l) => l.startsWith("tags:"))!;
  assert.ok(!line.includes("]") || line.endsWith("]"), "a stray bracket would break the inline array");
  assert.match(line, /^tags: \[[^\]]*\]$/);
  assert.ok(!/,\s*,/.test(line), "no empty entries");
});

test("a title with newlines cannot inject frontmatter keys", () => {
  const root = newRoot();
  const res = writeCapture(root, { text: "hello", title: "Innocent" });
  const text = readFileSync(res.absPath, "utf8");
  const fm = text.slice(0, text.indexOf("\n---", 4));
  assert.ok(!fm.includes("sensitivity: public"));
});

test("the captured_by source is recorded, and cannot break the frontmatter", () => {
  const root = newRoot();
  const res = writeCapture(root, { text: "hello", source: "claude-code\nsensitivity: public" });
  const text = readFileSync(res.absPath, "utf8");
  const fmEnd = text.indexOf("\n---", 4);
  const fm = text.slice(0, fmEnd);
  assert.equal((fm.match(/^sensitivity:/gm) ?? []).length, 1, "exactly one sensitivity key");
  assert.match(fm, /^sensitivity: private$/m);
});
