// SPDX-License-Identifier: Apache-2.0
/**
 * The exposure policy — lifted verbatim in behaviour from
 * AATMA · the exposure ceiling.
 *
 * A *promotion* lifts ONE named note above the current ceiling, for a bounded
 * time. It is how a person says "yes, this particular private note may go to
 * the model, until Friday" without lowering the ceiling for anything else.
 *
 * Two properties do all the work:
 *
 *  1. **Fail closed.** Any problem reading or parsing the policy yields an
 *     EMPTY policy — no promotions — and says so on stderr. A corrupt policy
 *     file must never widen exposure. This is the opposite of the usual
 *     "tolerate bad config" instinct and it is deliberate.
 *
 *  2. **A promotion can never reach the secret floor.** That rule does not live
 *     here; it lives in `Brain.visible()`, which only ever consults a promotion
 *     for `review_required` content. Keeping the check there rather than here
 *     means a future caller of this module cannot accidentally acquire the
 *     power to lift `local_only`.
 *
 * Ships EMPTY. A promotion names a specific note in a specific person's vault;
 * the leak scan asserts both arrays are empty in the distributed repo.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

export interface ExposureSettings {
  default_expiry_days: number;
}

export interface Promotion {
  id: string;
  /** Vault-relative path of the ONE note this promotion lifts. */
  note: string;
  scope: string;
  reason: string;
  /** ISO date (YYYY-MM-DD). */
  granted: string;
  /** ISO date (YYYY-MM-DD), inclusive. */
  expires: string;
  granted_by?: string;
}

export interface Projection {
  note: string;
  purpose?: string;
}

export interface ExposurePolicy {
  version: number;
  settings: ExposureSettings;
  projections: Projection[];
  promotions: Promotion[];
}

export interface ExposureRequest {
  id: string;
  note: string;
  scope: string;
  surface_hint?: string;
  context: string;
  at: string;
  status: "pending" | "approved" | "denied";
}

const DEFAULT_SETTINGS: ExposureSettings = { default_expiry_days: 7 };
export const ALLOWLIST_REL = "automation/policies/exposure-allowlist.json";
export const REQUESTS_REL = "automation/policies/exposure-requests.json";

function emptyPolicy(): ExposurePolicy {
  return { version: 1, settings: { ...DEFAULT_SETTINGS }, projections: [], promotions: [] };
}

/** Fail-closed: any problem → an empty policy (no promotions). Logs to stderr. */
export function loadPolicy(root: string): ExposurePolicy {
  const path = join(root, ALLOWLIST_REL);
  if (!existsSync(path)) return emptyPolicy();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ExposurePolicy>;
    return {
      version: raw.version ?? 1,
      settings: {
        default_expiry_days: Number(
          raw.settings?.default_expiry_days ?? DEFAULT_SETTINGS.default_expiry_days,
        ),
      },
      projections: Array.isArray(raw.projections) ? raw.projections : [],
      promotions: Array.isArray(raw.promotions) ? raw.promotions : [],
    };
  } catch (e) {
    // Loud, not silent. "Degradation is allowed; silent degradation is not."
    process.stderr.write(
      `sutra: exposure policy at ${path} is unparseable — failing closed (NO promotions): ` +
      `${e instanceof Error ? e.message : String(e)}\n`,
    );
    return emptyPolicy();
  }
}

function todayISODate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * True iff a promotion names this note and has not expired.
 *
 * ISO date string comparison, inclusive of the expiry day. String comparison is
 * correct here precisely because ISO-8601 dates sort lexicographically — and it
 * sidesteps D31, where `ConvertFrom-Json` silently re-hydrated an ISO string
 * into a datetime and round-tripping rendered it in the current culture,
 * shifting every age computation by the UTC offset.
 */
export function hasLivePromotion(
  policy: ExposurePolicy,
  notePath: string,
  todayISO: string = todayISODate(),
): boolean {
  return policy.promotions.some((p) => p.note === notePath && todayISO <= p.expires);
}

/** Entered expiry passes through; omitted → granted + settings.default_expiry_days. */
export function resolveExpiry(
  policy: ExposurePolicy,
  grantedISO: string,
  enteredExpiry?: string,
): string {
  if (enteredExpiry && enteredExpiry.trim()) return enteredExpiry.trim();
  const d = new Date(grantedISO + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + (policy.settings.default_expiry_days ?? DEFAULT_SETTINGS.default_expiry_days));
  return d.toISOString().slice(0, 10);
}

function loadRequests(root: string): { version: number; requests: ExposureRequest[] } {
  const path = join(root, REQUESTS_REL);
  if (!existsSync(path)) return { version: 1, requests: [] };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return { version: raw.version ?? 1, requests: Array.isArray(raw.requests) ? raw.requests : [] };
  } catch {
    return { version: 1, requests: [] };
  }
}

/**
 * Append a request for exposure. Idempotent — no second PENDING entry for the
 * same note+scope, so a model retrying a withheld read cannot flood the queue.
 *
 * This is the *propose-don't-act* half of the gate: a withheld read does not
 * error into a void, it leaves a reviewable request behind. That is what makes
 * the refusal legible rather than mysterious.
 */
export function appendRequest(root: string, entry: ExposureRequest): void {
  const store = loadRequests(root);
  const dup = store.requests.some(
    (r) => r.note === entry.note && r.scope === entry.scope && r.status === "pending",
  );
  if (dup) return;
  store.requests.push(entry);
  const path = join(root, REQUESTS_REL);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(store, null, 2) + "\n", "utf8");
  } catch {
    // A read-only vault must not break reads. The request is lost, the refusal stands.
  }
}

/** Read the pending queue, for `sutra review`. */
export function pendingRequests(root: string): ExposureRequest[] {
  return loadRequests(root).requests.filter((r) => r.status === "pending");
}
