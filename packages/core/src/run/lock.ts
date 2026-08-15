// SPDX-License-Identifier: Apache-2.0
/**
 * RANK-ORDERED RESOURCE LOCKS — the fix for D9.
 *
 * ── The defect ─────────────────────────────────────────────────────────────
 * Three scheduled jobs all wrote `cytoscape.json`, the embed index and
 * `kg.json`, with no lock between them. Task Scheduler's
 * `MultipleInstances = IgnoreNew` guards a task against ITSELF, never against
 * another task. The overlap only became guaranteed once the daily run got
 * slower, so the defect was latent for as long as jobs happened to finish
 * early — and corruption of a derived JSON looks like a rebuild bug, not a
 * concurrency bug.
 *
 * ── Why NAMED, RANK-ORDERED locks and not one global lock ──────────────────
 * A global lock would freeze the knowledge graph for the whole duration of
 * every long daily run. That graph has already been lost once. So locks are
 * per-resource and acquired in ASCENDING RANK, all-or-nothing; acquiring in
 * descending order THROWS, which makes circular wait impossible by
 * construction rather than by convention.
 *
 * ── A loser SKIPS AND EXITS 0 ──────────────────────────────────────────────
 * "Another run holds this resource" is a normal outcome, not an error. A red
 * task in the OS scheduler for a normal outcome trains people to ignore red
 * tasks, which is how a real failure goes unnoticed.
 *
 * ── D30 · deleting the lock file ───────────────────────────────────────────
 * `Remove-Item -LiteralPath` fails on 8.3 short-name paths EVEN UNDER
 * `-ErrorAction SilentlyContinue` — and a lock that cannot be deleted never
 * releases. Deletion goes through `node:fs.rmSync`, and the pwsh twin uses
 * `[IO.File]::Delete`.
 *
 * ── D31 · timestamps ───────────────────────────────────────────────────────
 * `ConvertFrom-Json` silently re-hydrates an ISO-8601 string into a `[datetime]`
 * and round-tripping renders it in the CURRENT CULTURE, shifting every age
 * computation by the UTC offset. Ages here are computed from an epoch number,
 * not from a re-parsed local string.
 *
 * ── Lock files are gitignored ──────────────────────────────────────────────
 * They are per-machine runtime state. Committed, they arrive on another host as
 * un-reclaimable foreign locks. `.gitignore` carries the rule and a comment
 * saying why.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, openSync, closeSync } from "node:fs";
import { join, dirname } from "node:path";
import { hostname } from "node:os";

/**
 * THE RANK ORDER. Every lockable resource, in the order it must be acquired.
 * Lower rank is acquired first. Adding a resource means choosing its rank here,
 * once, for everyone — which is the point.
 */
export const RESOURCE_RANK: Record<string, number> = {
  vault: 10,
  "raw-inbox": 20,
  extracts: 30,
  pages: 40,
  "embed-index": 50,
  "graph-a": 60,
  "graph-kg": 70,
  publish: 80,
};

export interface LockInfo {
  resource: string;
  host: string;
  pid: number;
  /** Epoch milliseconds — a NUMBER, deliberately (D31). */
  acquired_ms: number;
  run_id: string;
}

export interface LockHandle {
  resources: string[];
  release: () => void;
}

export type AcquireResult =
  | { ok: true; handle: LockHandle }
  | { ok: false; heldBy: LockInfo; message: string };

function lockPath(vaultRoot: string, resource: string): string {
  // `.sutra/locks/` is gitignored. Per-machine runtime state, never committed.
  return join(vaultRoot, ".sutra", "locks", `${resource}.lock.json`);
}

function readLock(path: string): LockInfo | null {
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as LockInfo;
    return typeof j?.resource === "string" ? j : null;
  } catch {
    return null;
  }
}

/**
 * Is the holder still alive?
 *
 * A dead SAME-HOST pid may be reclaimed. A FOREIGN-HOST lock is NEVER
 * pid-reclaimed — pid 4242 exists on almost every machine, and reclaiming a
 * foreign lock because the number happens to be live locally is a corruption
 * waiting to happen. A foreign lock ages out instead.
 */
function holderAlive(info: LockInfo, now: number, staleMs: number): boolean {
  if (info.host !== hostname()) {
    return now - info.acquired_ms < staleMs; // age-out only
  }
  try {
    process.kill(info.pid, 0); // signal 0 = existence check, no signal delivered
    return true;
  } catch (e) {
    // EPERM means the process exists and belongs to someone else — still alive.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Acquire one or more named resource locks, all-or-nothing.
 *
 * THROWS on descending-rank acquisition. That is not defensive programming, it
 * is the deadlock proof: if every acquisition is ascending, a cycle cannot
 * form. A caller that trips this has found a real ordering bug in their code,
 * and finding it at the throw is much cheaper than finding it at 03:00 when two
 * jobs are wedged.
 */
export function acquireLocks(
  vaultRoot: string,
  resources: readonly string[],
  opts: { runId?: string; staleHours?: number; now?: number } = {},
): AcquireResult {
  const now = opts.now ?? Date.now();
  const staleMs = (opts.staleHours ?? 6) * 3600_000;
  const runId = opts.runId ?? `${process.pid}`;

  const unknown = resources.filter((r) => !(r in RESOURCE_RANK));
  if (unknown.length) {
    throw new Error(
      `unknown lock resource(s): ${unknown.join(", ")}. Add them to RESOURCE_RANK with a ` +
      `deliberate rank — an unranked lock cannot participate in the deadlock proof.`,
    );
  }

  const ranks = resources.map((r) => RESOURCE_RANK[r]!);
  for (let i = 1; i < ranks.length; i++) {
    if (ranks[i]! < ranks[i - 1]!) {
      throw new Error(
        `lock resources must be acquired in ASCENDING rank order; got ` +
        `${resources[i - 1]}(${ranks[i - 1]}) before ${resources[i]}(${ranks[i]}). ` +
        `Ascending-only acquisition is what makes circular wait impossible by construction.`,
      );
    }
  }

  const acquired: string[] = [];
  const releaseAll = (): void => {
    for (const r of acquired) {
      try {
        rmSync(lockPath(vaultRoot, r), { force: true }); // D30: not Remove-Item
      } catch {
        /* best-effort */
      }
    }
    acquired.length = 0;
  };

  for (const resource of resources) {
    const path = lockPath(vaultRoot, resource);
    mkdirSync(dirname(path), { recursive: true });

    const existing = existsSync(path) ? readLock(path) : null;
    if (existing && holderAlive(existing, now, staleMs)) {
      releaseAll(); // all-or-nothing
      return {
        ok: false,
        heldBy: existing,
        message:
          `resource "${resource}" is held by ${existing.run_id} (pid ${existing.pid} on ${existing.host}, ` +
          `since ${new Date(existing.acquired_ms).toISOString()}). Skipping — this is a NORMAL outcome, ` +
          `not a failure; exit 0.`,
      };
    }

    const info: LockInfo = {
      resource,
      host: hostname(),
      pid: process.pid,
      acquired_ms: now,
      run_id: runId,
    };
    try {
      // `wx` = create-exclusive. Two processes racing here cannot both succeed;
      // the loser gets EEXIST and re-reads, rather than both believing they won.
      const fd = openSync(path, "wx");
      closeSync(fd);
      writeFileSync(path, JSON.stringify(info, null, 2) + "\n", "utf8");
      acquired.push(resource);
    } catch {
      const raced = readLock(path);
      if (raced && holderAlive(raced, now, staleMs)) {
        releaseAll();
        return { ok: false, heldBy: raced, message: `resource "${resource}" was taken during acquisition by ${raced.run_id}. Skipping; exit 0.` };
      }
      // A stale file we lost the race to create, but whose holder is dead: take it.
      writeFileSync(path, JSON.stringify(info, null, 2) + "\n", "utf8");
      acquired.push(resource);
    }
  }

  let released = false;
  return {
    ok: true,
    handle: {
      resources: [...acquired],
      release: () => {
        if (released) return; // idempotent: a nested caller must not double-release
        released = true;
        releaseAll();
      },
    },
  };
}

/**
 * Run `fn` holding `resources`. Releases on ANY exit path, including a throw.
 *
 * `onSkip` is called when the lock is unavailable — the caller decides what to
 * report, and the default is a skip, not an error.
 */
export function withLocks<T>(
  vaultRoot: string,
  resources: readonly string[],
  fn: () => T,
  opts: { runId?: string; onSkip?: (msg: string, heldBy: LockInfo) => void } = {},
): { ran: true; value: T } | { ran: false; heldBy: LockInfo } {
  const acquireOpts = opts.runId === undefined ? {} : { runId: opts.runId };
  const res = acquireLocks(vaultRoot, resources, acquireOpts);
  if (!res.ok) {
    opts.onSkip?.(res.message, res.heldBy);
    return { ran: false, heldBy: res.heldBy };
  }
  try {
    return { ran: true, value: fn() };
  } finally {
    res.handle.release();
  }
}
