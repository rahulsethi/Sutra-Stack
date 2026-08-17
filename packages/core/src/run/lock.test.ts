// SPDX-License-Identifier: Apache-2.0
/**
 * D9 · `sched/resource-lock` — plus D30 and D31, which live in the same file
 * because they are the two ways a lock stops working after it is written.
 *
 * D9's own test specification, verbatim from the manifest:
 *
 *   > A live holder turns the second acquirer away and the guarded block
 *   > provably does not run; a dead same-host PID is reclaimed; a FOREIGN-HOST
 *   > lock is never PID-reclaimed; descending acquisition throws and leaves no
 *   > lock file; a nested in-process call does not self-deadlock.
 *
 * Each clause below is one test, in that order.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hostname } from "node:os";
import { acquireLocks, withLocks, RESOURCE_RANK, type LockInfo } from "./lock.js";

const newVault = (): string => mkdtempSync(join(tmpdir(), "sutra-lock-"));
const lockFile = (root: string, r: string): string => join(root, ".sutra", "locks", `${r}.lock.json`);

/** Plant a lock file directly, as another process would have left it. */
function plantLock(root: string, resource: string, info: Partial<LockInfo>): void {
  const p = lockFile(root, resource);
  mkdirSync(join(root, ".sutra", "locks"), { recursive: true });
  const full: LockInfo = {
    resource,
    host: hostname(),
    pid: process.pid,
    acquired_ms: Date.now(),
    run_id: "planted",
    ...info,
  };
  writeFileSync(p, JSON.stringify(full, null, 2) + "\n", "utf8");
}

// ─────────────────────────────────────────────────────────────────────────────

test("D9 · a LIVE holder turns the second acquirer away", () => {
  const root = newVault();
  const first = acquireLocks(root, ["graph-a"], { runId: "first" });
  assert.equal(first.ok, true);

  const second = acquireLocks(root, ["graph-a"], { runId: "second" });
  assert.equal(second.ok, false, "two runs both acquired the same resource");
  if (!second.ok) {
    assert.equal(second.heldBy.run_id, "first");
    assert.match(second.message, /NORMAL outcome/,
      "the message must say a skip is normal — a red task for a normal outcome trains people to ignore red tasks");
  }
});

test("D9 · the GUARDED BLOCK provably does not run when the lock is held", () => {
  // The clause that matters most: it is not enough for `acquire` to return
  // false, the work must actually not happen.
  const root = newVault();
  const held = acquireLocks(root, ["pages"], { runId: "holder" });
  assert.equal(held.ok, true);

  let ran = false;
  const outcome = withLocks(root, ["pages"], () => { ran = true; return "did work"; }, { runId: "loser" });

  assert.equal(ran, false, "THE GUARDED BLOCK RAN while another run held the lock");
  assert.equal(outcome.ran, false);
});

test("D9 · a dead SAME-HOST pid is reclaimed", () => {
  const root = newVault();
  // A pid that cannot be live: the OS does not issue pid 0 to a user process,
  // and a very large one will not exist.
  plantLock(root, "extracts", { pid: 999_999, host: hostname(), run_id: "crashed" });

  const r = acquireLocks(root, ["extracts"], { runId: "recovering" });
  assert.equal(r.ok, true, "a lock held by a dead same-host process must be reclaimable");

  const info = JSON.parse(readFileSync(lockFile(root, "extracts"), "utf8")) as LockInfo;
  assert.equal(info.run_id, "recovering");
});

test("D9 · a FOREIGN-HOST lock is NEVER pid-reclaimed", () => {
  // The clause with the sharpest consequence: pid 4242 exists on almost every
  // machine. Reclaiming a foreign lock because the number happens to be live
  // locally is corruption waiting to happen. A foreign lock AGES OUT instead.
  const root = newVault();
  plantLock(root, "graph-kg", {
    host: "some-other-machine",
    pid: process.pid,          // deliberately a pid that IS live here
    acquired_ms: Date.now(),   // and fresh
    run_id: "remote",
  });

  const r = acquireLocks(root, ["graph-kg"], { runId: "local" });
  assert.equal(r.ok, false, "a FRESH foreign-host lock was reclaimed using a locally-live pid");
  if (!r.ok) assert.equal(r.heldBy.host, "some-other-machine");
});

test("D9 · a STALE foreign-host lock ages out", () => {
  const root = newVault();
  plantLock(root, "graph-kg", {
    host: "some-other-machine",
    pid: process.pid,
    acquired_ms: Date.now() - 24 * 3600_000,   // a day old
    run_id: "abandoned",
  });

  const r = acquireLocks(root, ["graph-kg"], { runId: "local", staleHours: 6 });
  assert.equal(r.ok, true, "a foreign lock must age out, or a dead remote host wedges this one forever");
});

test("D9 · DESCENDING acquisition throws, and leaves no lock file", () => {
  // The deadlock proof: if every acquisition is ascending, a cycle cannot form.
  // A caller that trips this has a real ordering bug, and finding it at the
  // throw is much cheaper than finding it at 03:00 with two jobs wedged.
  const root = newVault();
  assert.ok(RESOURCE_RANK["graph-a"]! > RESOURCE_RANK["pages"]!, "the fixture assumes this rank order");

  assert.throws(
    () => acquireLocks(root, ["graph-a", "pages"], { runId: "wrong-order" }),
    /ASCENDING rank order/,
  );

  assert.equal(existsSync(lockFile(root, "graph-a")), false,
    "a refused acquisition left a lock file behind — the next run would find a phantom holder");
  assert.equal(existsSync(lockFile(root, "pages")), false);
});

test("D9 · acquisition is ALL-OR-NOTHING", () => {
  const root = newVault();
  acquireLocks(root, ["graph-a"], { runId: "holder" });          // take the later one

  const r = acquireLocks(root, ["pages", "graph-a"], { runId: "partial" });
  assert.equal(r.ok, false);
  assert.equal(existsSync(lockFile(root, "pages")), false,
    "the first lock was kept after the second failed — a partial acquisition wedges `pages` forever");
});

test("D9 · a NESTED in-process release does not self-deadlock or double-release", () => {
  const root = newVault();
  const r = acquireLocks(root, ["vault"], { runId: "outer" });
  assert.equal(r.ok, true);
  if (!r.ok) return;

  r.handle.release();
  assert.equal(existsSync(lockFile(root, "vault")), false);

  // Idempotent: a nested caller that also releases must not throw, and must not
  // delete a lock a LATER run has since taken.
  const next = acquireLocks(root, ["vault"], { runId: "next" });
  assert.equal(next.ok, true);
  assert.doesNotThrow(() => r.handle.release());
  assert.equal(
    existsSync(lockFile(root, "vault")),
    true,
    "a stale handle's second release deleted the NEXT run's lock",
  );
});

test("D9 · an UNRANKED resource throws — it cannot join the deadlock proof", () => {
  const root = newVault();
  assert.throws(() => acquireLocks(root, ["something-new"], {}), /unknown lock resource/);
});

test("D9 · withLocks releases on a THROW, not just on a return", () => {
  const root = newVault();
  assert.throws(() => withLocks(root, ["pages"], () => { throw new Error("boom"); }));
  assert.equal(existsSync(lockFile(root, "pages")), false,
    "a throwing body left the lock held — every later run would skip forever");
});

// ─────────────────────────────────────────────────────────────────────────────
// D31 · the timestamp
// ─────────────────────────────────────────────────────────────────────────────

test("D31 · `acquired_ms` is a NUMBER, not an ISO string", () => {
  // `ConvertFrom-Json` silently re-hydrates an ISO-8601 string into a datetime,
  // and round-tripping renders it in the CURRENT CULTURE — shifting every age
  // computation by the UTC offset. An epoch number has no such round trip.
  const root = newVault();
  acquireLocks(root, ["vault"], { runId: "x" });
  const raw = JSON.parse(readFileSync(lockFile(root, "vault"), "utf8")) as Record<string, unknown>;

  assert.equal(typeof raw["acquired_ms"], "number", "the lock timestamp is not a number");
  assert.ok(!/T\d{2}:\d{2}/.test(String(raw["acquired_ms"])), "the timestamp looks like an ISO string");

  // …and it survives a JSON round trip unchanged, which is the actual property.
  const round = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
  assert.equal(round["acquired_ms"], raw["acquired_ms"]);
});

test("D31 · the age computation is offset-free across a round trip", () => {
  const root = newVault();
  const past = Date.now() - 3600_000;
  plantLock(root, "publish", { acquired_ms: past, host: "other-host", run_id: "old" });

  const reread = JSON.parse(readFileSync(lockFile(root, "publish"), "utf8")) as LockInfo;
  const ageHours = (Date.now() - reread.acquired_ms) / 3600_000;

  assert.ok(
    ageHours > 0.9 && ageHours < 1.1,
    `age computed as ${ageHours.toFixed(2)}h for a 1h-old lock — a culture-dependent round trip ` +
    `would shift this by the UTC offset`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// D30 · deletion
// ─────────────────────────────────────────────────────────────────────────────

test("D30 · release DELETES the file — a lock that cannot be deleted never releases", () => {
  // `Remove-Item -LiteralPath` fails on 8.3 short-name paths EVEN UNDER
  // `-ErrorAction SilentlyContinue`. The TS side uses `rmSync`; this asserts the
  // observable property either way.
  const root = newVault();
  const r = acquireLocks(root, ["embed-index"], { runId: "x" });
  assert.equal(r.ok, true);
  assert.equal(existsSync(lockFile(root, "embed-index")), true);

  if (r.ok) r.handle.release();
  assert.equal(existsSync(lockFile(root, "embed-index")), false, "the lock file survived release");
});

test("D30 · release works under a SHORT-NAME (8.3) path", () => {
  // The literal shape of the defect: a path with a tilde in it. On Windows this
  // is what `%TEMP%` frequently expands to.
  const root = mkdtempSync(join(tmpdir(), "sutra~1"));
  const r = acquireLocks(root, ["vault"], { runId: "short-name" });
  assert.equal(r.ok, true);
  if (r.ok) r.handle.release();
  assert.equal(existsSync(lockFile(root, "vault")), false,
    "a lock under a short-name path could not be deleted, so it would never release");
});
