// SPDX-License-Identifier: Apache-2.0
/**
 * The audit trail — ported from `aatma/src/observability.ts`, plus rotation.
 *
 * ── INVARIANT 7 · Reversible-auto with an audit trail ──────────────────────
 * Automated maintenance may act WITHOUT ASKING — precisely BECAUSE every action
 * is git-tracked, reversible (removal is a move to quarantine, never a hard
 * delete), and appended here. Only genuinely critical findings interrupt the
 * user, and then as a receipt rather than a blocking gate.
 *
 * That trade is the whole reason the system can be autonomous without being
 * frightening. Take away the audit trail and every automated action would need
 * a confirmation, which in practice means nothing gets automated.
 *
 * ── D27 · rotation, and what must NEVER be deleted ─────────────────────────
 * Upstream had 343 MB of unpruned snapshots and 7.5 MB of provider logs. The
 * fix is rotation with a HARD FLOOR — and provider logs are ROTATED, NEVER
 * DELETED, because they are the ground truth for provider health (I3). A
 * retention job that deletes the evidence of an outage is worse than no
 * retention job.
 *
 * ── Observability must never fail the run ──────────────────────────────────
 * Every write here is best-effort and swallows its own errors.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, readdirSync, rmSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { hostname } from "node:os";

export interface AuditEvent {
  /** ISO timestamp. Set here, never by the caller. */
  t: string;
  host: string;
  /** `gate.withheld`, `capture.write`, `reveal.authorized`, `hygiene.quarantine`, … */
  kind: string;
  message?: string;
  /** For a gate decision: what was refused and why. NEVER the content. */
  decision?: { source: string; destination: string; allowed: boolean; reason: string };
  [k: string]: unknown;
}

const MAX_BYTES = 8 * 1024 * 1024;
const KEEP_ROTATIONS = 5;

/**
 * Rotate a log that has grown past `MAX_BYTES`.
 *
 * `.1` is the most recent rotation. Rotations beyond `KEEP_ROTATIONS` are
 * dropped — EXCEPT for a provider log, where `keepForever` is passed and
 * nothing is ever removed. See the header: those files are the only record of
 * whether a key has ever once succeeded.
 */
function rotateIfNeeded(file: string, opts: { keepForever?: boolean } = {}): void {
  try {
    if (!existsSync(file) || statSync(file).size < MAX_BYTES) return;
    const dir = dirname(file);
    const base = basename(file);

    const existing = readdirSync(dir)
      .filter((f) => f.startsWith(base + "."))
      .map((f) => ({ f, n: Number(f.slice(base.length + 1)) }))
      .filter((x) => Number.isFinite(x.n))
      .sort((a, b) => b.n - a.n);

    for (const { f, n } of existing) {
      if (!opts.keepForever && n >= KEEP_ROTATIONS) {
        rmSync(join(dir, f), { force: true });
        continue;
      }
      renameSync(join(dir, f), join(dir, `${base}.${n + 1}`));
    }
    renameSync(file, `${file}.1`);
  } catch {
    /* rotation failure must not stop logging */
  }
}

function appendNdjson(file: string, obj: Record<string, unknown>, keepForever = false): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    rotateIfNeeded(file, { keepForever });
    appendFileSync(file, JSON.stringify(obj) + "\n", "utf8");
  } catch {
    /* observability failure never fails the run */
  }
}

/** Append one audit event. */
export function auditLog(
  vaultRoot: string,
  ev: Omit<AuditEvent, "t" | "host"> & { t?: string; host?: string },
): void {
  appendNdjson(join(vaultRoot, "logs", "sutra", "events.ndjson"), {
    t: new Date().toISOString(),
    host: hostname(),
    ...ev,
  });
}

/**
 * A gate refusal.
 *
 * Written to its OWN stream, deliberately. "How often is the gate actually
 * refusing something?" is the question that tells you whether the tiering is
 * working or whether everything has drifted to public — and it must not be
 * something you have to grep a general event log to answer.
 *
 * The note's PATH is recorded. Its CONTENT never is.
 */
export function auditGateBlock(
  vaultRoot: string,
  payload: { note?: string; source: string; destination: string; reason: string; surface?: string },
): void {
  appendNdjson(join(vaultRoot, "logs", "sutra", "sensitivity.ndjson"), {
    t: new Date().toISOString(),
    host: hostname(),
    ...payload,
  });
}

/**
 * A provider dispatch outcome.
 *
 * ── D19 · client-side faults get their OWN status ──────────────────────────
 * `(Get-Item env:X -EA SilentlyContinue).Value` throws under StrictMode when
 * `X` is unset. `NVIDIA_API_BASE` was normally unset, so every nvidia dispatch
 * died BEFORE ANY NETWORK I/O — 2,109 times, all recorded as provider errors.
 * The error text read like a response-parsing problem and was logged in the
 * provider's own error stream, so any success rate computed from those logs
 * blamed the provider.
 *
 * So `parse_error`, `unconfigured`, `excluded_policy` and `no_provider` are
 * FIRST-CLASS statuses, EXCLUDED from the provider success-rate denominator and
 * reported separately. `providerHealth()` below enforces that exclusion.
 */
export type ProviderStatus =
  | "ok"
  | "auth_fail"
  | "rate_limited"
  | "other_error"
  /** Client-side. NOT the provider's fault; excluded from its denominator. */
  | "parse_error"
  | "unconfigured"
  | "excluded_policy"
  | "no_provider";

const CLIENT_SIDE: ReadonlySet<ProviderStatus> = new Set<ProviderStatus>([
  "parse_error", "unconfigured", "excluded_policy", "no_provider",
]);

export function auditProvider(
  vaultRoot: string,
  payload: {
    provider: string;
    task: string;
    status: ProviderStatus;
    model?: string;
    latency_ms?: number;
    error?: string;
  },
): void {
  appendNdjson(
    join(vaultRoot, "logs", "sutra", "provider.ndjson"),
    { t: new Date().toISOString(), host: hostname(), ...payload },
    true, // keepForever — this is the I3 ground truth
  );
}

export interface ProviderHealth {
  provider: string;
  task: string;
  ok: number;
  failed: number;
  /** Client-side faults, reported but NOT counted against the provider. */
  client_side: number;
  /** Success rate over provider-attributable calls only. `null` if there were none. */
  success_rate: number | null;
  /**
   * I3 · "a provider that has NEVER succeeded is a dead key, not a rate limit."
   * Survives a rolling-window reset, which is why it is tracked separately.
   */
  lifetime_ok: number;
  lifetime_total: number;
  never_succeeded: boolean;
}

/** Roll the provider log up per `provider × task`. */
export function providerHealth(vaultRoot: string, opts: { window?: number } = {}): ProviderHealth[] {
  const file = join(vaultRoot, "logs", "sutra", "provider.ndjson");
  if (!existsSync(file)) return [];
  let lines: string[];
  try {
    lines = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
  const windowed = opts.window ? lines.slice(-opts.window) : lines;

  const acc = new Map<string, ProviderHealth>();
  for (const line of windowed) {
    let ev: { provider?: string; task?: string; status?: ProviderStatus };
    try { ev = JSON.parse(line); } catch { continue; }
    if (!ev.provider) continue;
    const key = `${ev.provider}::${ev.task ?? "*"}`;
    if (!acc.has(key)) {
      acc.set(key, {
        provider: ev.provider, task: ev.task ?? "*",
        ok: 0, failed: 0, client_side: 0, success_rate: null,
        lifetime_ok: 0, lifetime_total: 0, never_succeeded: true,
      });
    }
    const h = acc.get(key)!;
    const status = ev.status ?? "other_error";
    if (CLIENT_SIDE.has(status)) { h.client_side++; continue; }
    h.lifetime_total++;
    if (status === "ok") { h.ok++; h.lifetime_ok++; h.never_succeeded = false; }
    else h.failed++;
  }

  for (const h of acc.values()) {
    const denom = h.ok + h.failed;
    h.success_rate = denom === 0 ? null : h.ok / denom;
  }
  return [...acc.values()];
}

/** I3 alerts. A never-succeeded provider is LOUD; a low rate is a warning. */
export function providerAlerts(health: readonly ProviderHealth[]): Array<{ severity: "warn" | "loud"; message: string }> {
  const out: Array<{ severity: "warn" | "loud"; message: string }> = [];
  for (const h of health) {
    if (h.lifetime_total >= 5 && h.never_succeeded) {
      out.push({
        severity: "loud",
        message:
          `provider "${h.provider}" (${h.task}) has NEVER succeeded in ${h.lifetime_total} attempts. ` +
          `That is a dead key, not a rate limit — rotation looks like resilience while every attempt ` +
          `burns on the same dead upstream.`,
      });
    } else if (h.success_rate !== null && h.success_rate < 0.8 && h.ok + h.failed >= 20) {
      out.push({
        severity: "warn",
        message: `provider "${h.provider}" (${h.task}) success rate ${Math.round(h.success_rate * 100)}% over ${h.ok + h.failed} calls (threshold 80%).`,
      });
    }
    if (h.client_side > 0) {
      out.push({
        severity: "warn",
        message:
          `${h.client_side} client-side fault(s) for "${h.provider}" (${h.task}) — unconfigured, ` +
          `excluded by policy, or a parse error. NOT counted against the provider (D19).`,
      });
    }
  }
  return out;
}

/** Read the tail of the event log. */
export function tailEvents(vaultRoot: string, n = 20): AuditEvent[] {
  const file = join(vaultRoot, "logs", "sutra", "events.ndjson");
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-n)
      .map((l): AuditEvent => {
        try { return JSON.parse(l) as AuditEvent; }
        catch { return { t: "", host: "", kind: "parse-error", message: l }; }
      });
  } catch {
    return [];
  }
}
