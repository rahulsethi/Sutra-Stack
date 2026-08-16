// SPDX-License-Identifier: LicenseRef-Sutra-Commercial
/**
 * E3 · TAMPER-EVIDENT AUDIT.
 *
 * Core already writes an audit trail — `packages/core/src/audit/log.ts`, NDJSON,
 * append-only, best-effort. That is the right design for a single user: it is
 * legible, greppable, and it never fails the run it exists to observe.
 *
 * It is not sufficient for an enterprise, for one specific reason: an
 * append-only file is only append-only BY CONVENTION. Anyone who can write it
 * can rewrite it, and nothing about the file afterwards shows that they did.
 *
 * ── TAMPER-EVIDENT, NOT TAMPER-PROOF ──────────────────────────────────────
 * The distinction is worth stating plainly, because the marketing temptation is
 * to blur it and `research/14`'s claims list exists to stop exactly that.
 *
 * This is a hash chain: every entry commits to the previous entry's digest, so
 * ALTERING OR REMOVING ANY ENTRY BREAKS EVERY LINK AFTER IT. What that buys is
 * DETECTION — `verify()` will say which entry and when.
 *
 * What it does NOT buy: it cannot stop someone with write access from
 * truncating the log and re-chaining from that point. Detecting THAT requires an
 * anchor outside the file — a periodic digest exported to a SIEM, or signed by
 * a KMS key the log's writer cannot use. `exportAnchor()` produces that digest;
 * shipping it somewhere the log's writer cannot reach is a deployment decision,
 * and the honest claim in a customer conversation is "tamper-evident, with an
 * external anchor" rather than "immutable".
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { hostname } from "node:os";

/** The genesis link. A fixed, well-known value, so a chain of length 1 verifies. */
export const GENESIS = "0".repeat(64);

export interface AuditEntry {
  /** Monotonic within a chain. Gaps are detectable. */
  seq: number;
  ts: string;
  host: string;
  tenant: string;
  /** `policy.decision`, `secret.reveal`, `bundle.applied`, `erasure.executed`, … */
  kind: string;
  subject: string;
  /** The decision payload. NEVER content — tiers, paths, ids and reasons only. */
  detail: Record<string, unknown>;
  /**
   * E3 · retention class. Set at WRITE time, because deciding how long to keep a
   * record after the fact requires re-reading it, and re-reading a decision to
   * classify it is exactly the access an audit log should not need.
   */
  retention: RetentionClass;
  /** Digest of the previous entry. `GENESIS` for the first. */
  prev: string;
  /** Digest of THIS entry, over every field above. */
  hash: string;
}

export type RetentionClass =
  /** Routine access decisions. Shortest useful window. */
  | "operational"
  /** Anything touching the secret floor, a break-glass, or a policy change. */
  | "security"
  /** Subject-access, erasure, and consent records. */
  | "privacy"
  /** Under legal hold. NEVER pruned, regardless of age. */
  | "legal-hold";

/** Canonical serialisation. Key order is FIXED — a hash over an object whose
 * key order varies is a hash that fails at random on a different runtime. */
function canonical(e: Omit<AuditEntry, "hash">): string {
  return JSON.stringify([
    e.seq, e.ts, e.host, e.tenant, e.kind, e.subject,
    // Sorting the detail keys is what makes the digest reproducible across
    // Node versions and across the JS/PowerShell boundary. D39's lesson applied
    // to hashing: an output that depends on enumeration order is not an output.
    JSON.stringify(e.detail, Object.keys(e.detail).sort()),
    e.retention, e.prev,
  ]);
}

function digest(e: Omit<AuditEntry, "hash">): string {
  return createHash("sha256").update(canonical(e)).digest("hex");
}

/**
 * The chain writer.
 *
 * Note what this does NOT do: swallow its errors. Core's audit log is
 * best-effort because observability must never fail the run. An ENTERPRISE
 * audit log is the opposite — if the record of an access decision cannot be
 * written, THE ACCESS MUST NOT HAPPEN. `append` throws, and callers are
 * expected to fail the request rather than proceed unlogged.
 */
export class AuditChain {
  private lastHash: string = GENESIS;
  private lastSeq = 0;

  constructor(private readonly path: string, private readonly tenant: string) {
    this.rehydrate();
  }

  private rehydrate(): void {
    if (!existsSync(this.path)) return;
    const lines = readFileSync(this.path, "utf8").split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) return;
    const last = JSON.parse(lines[lines.length - 1]!) as AuditEntry;
    this.lastHash = last.hash;
    this.lastSeq = last.seq;
  }

  append(input: {
    kind: string;
    subject: string;
    detail: Record<string, unknown>;
    retention?: RetentionClass;
  }): AuditEntry {
    const partial: Omit<AuditEntry, "hash"> = {
      seq: this.lastSeq + 1,
      ts: new Date().toISOString(),
      host: hostname(),
      tenant: this.tenant,
      kind: input.kind,
      subject: input.subject,
      detail: input.detail,
      retention: input.retention ?? classify(input.kind),
      prev: this.lastHash,
    };
    const entry: AuditEntry = { ...partial, hash: digest(partial) };

    // THROWS on failure. An access whose record cannot be written must not
    // proceed — that is the whole difference between this and Core's log.
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(entry) + "\n", "utf8");

    this.lastHash = entry.hash;
    this.lastSeq = entry.seq;
    return entry;
  }

  /** The current chain head — what `exportAnchor` ships to an external system. */
  head(): { seq: number; hash: string } {
    return { seq: this.lastSeq, hash: this.lastHash };
  }
}

/**
 * Default retention by event kind.
 *
 * Anything touching the floor, a break-glass, or a policy change is `security`
 * and outlives routine access records — because the question those answer is
 * asked months later, by someone reconstructing an incident, and an operational
 * window that expired is a question that cannot be answered.
 */
function classify(kind: string): RetentionClass {
  if (/^(secret\.|reveal|breakglass|bundle\.|policy\.change|key\.)/.test(kind)) return "security";
  if (/^(erasure|subject-access|consent)/.test(kind)) return "privacy";
  return "operational";
}

export interface VerifyResult {
  ok: boolean;
  entries: number;
  /** The first entry whose chain is broken, if any. */
  brokenAt?: { seq: number; ts: string; expected: string; actual: string; why: string };
}

/**
 * Verify the chain end to end.
 *
 * Three separate failures, distinguished because they mean different things to
 * whoever is reading the report:
 *
 *   - a MODIFIED entry   → its own hash no longer matches its content
 *   - a REMOVED entry    → the next entry's `prev` does not match
 *   - a REORDERED entry  → `seq` is not monotonic
 */
export function verifyChain(path: string): VerifyResult {
  if (!existsSync(path)) return { ok: true, entries: 0 };

  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
  let prev = GENESIS;
  let expectedSeq = 1;

  for (const line of lines) {
    let e: AuditEntry;
    try {
      e = JSON.parse(line) as AuditEntry;
    } catch {
      return {
        ok: false, entries: expectedSeq - 1,
        brokenAt: { seq: expectedSeq, ts: "?", expected: "valid JSON", actual: "unparseable", why: "an entry is not valid JSON — the log has been edited by hand or truncated mid-write" },
      };
    }

    const { hash, ...rest } = e;
    const recomputed = digest(rest);

    // Constant-time, because `verify` may be exposed on an admin endpoint and a
    // timing side channel on a hash comparison is a free oracle.
    const a = Buffer.from(recomputed, "hex");
    const b = Buffer.from(hash ?? "", "hex");
    const hashOk = a.length === b.length && timingSafeEqual(a, b);

    if (!hashOk) {
      return {
        ok: false, entries: expectedSeq - 1,
        brokenAt: { seq: e.seq, ts: e.ts, expected: recomputed, actual: hash, why: "this entry's content was MODIFIED after it was written" },
      };
    }
    if (e.prev !== prev) {
      return {
        ok: false, entries: expectedSeq - 1,
        brokenAt: { seq: e.seq, ts: e.ts, expected: prev, actual: e.prev, why: "the previous entry was REMOVED or REPLACED — this entry's `prev` does not match the chain" },
      };
    }
    if (e.seq !== expectedSeq) {
      return {
        ok: false, entries: expectedSeq - 1,
        brokenAt: { seq: e.seq, ts: e.ts, expected: String(expectedSeq), actual: String(e.seq), why: "entries are out of order — the log was REORDERED" },
      };
    }

    prev = e.hash;
    expectedSeq++;
  }

  return { ok: true, entries: lines.length };
}

/**
 * The EXTERNAL ANCHOR — the thing that makes truncation detectable.
 *
 * A hash chain detects edits WITHIN a file. It cannot, alone, detect someone
 * deleting the last N entries and continuing from there: the shortened chain is
 * internally consistent.
 *
 * The remedy is to periodically ship `{ seq, hash }` somewhere the log's writer
 * cannot reach — a SIEM, an append-only object store, a signed receipt. If the
 * anchor says seq 40,102 and the log says 39,000, entries were removed, and the
 * anchor is what tells you.
 *
 * Shipping it is a DEPLOYMENT decision, not a code one, and the honest claim to
 * a customer is "tamper-evident, with an external anchor" — never "immutable".
 */
export function exportAnchor(chain: AuditChain, tenant: string): {
  tenant: string;
  seq: number;
  hash: string;
  at: string;
  note: string;
} {
  const head = chain.head();
  return {
    tenant,
    seq: head.seq,
    hash: head.hash,
    at: new Date().toISOString(),
    note:
      "Ship this to a system the log's writer CANNOT write. A hash chain detects edits within a " +
      "file; only an external anchor detects truncation, because a shortened chain is internally " +
      "consistent. Without one, the claim is 'tamper-evident'; with one, it is 'tamper-evident and " +
      "non-truncatable'. Neither claim is 'immutable'.",
  };
}
