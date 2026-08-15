// SPDX-License-Identifier: Apache-2.0
/**
 * Passphrase-gated override — lifted from `aatma/src/mcp/override.ts`.
 *
 * The concrete need this answers: a retrieval shows the public facts about a
 * person and withholds the private one. The user must be able to reveal it, on
 * any surface, by proving it is them.
 *
 * ── HOW IT PROVES "it's me" ────────────────────────────────────────────────
 * A passphrase, compared constant-time INSIDE this local process. The assistant
 * model never verifies anything and can never lift the gate itself — it merely
 * relays the passphrase the user typed. A wrong or absent passphrase raises
 * nothing. This is the same shape as invariant 2 (the ceiling is read from the
 * environment, not from a tool argument): the model is a courier, never an
 * authority.
 *
 * ── THE HARD FLOOR, WHICH THIS MODULE DOES NOT GET TO SOFTEN ───────────────
 * MCP output is always consumed by an LLM. So an override on the MCP path may
 * reveal PRIVATE (`review_required`) content but NEVER SECRET (`local_only`).
 * `raised()` below takes `allowSecret` and the MCP path passes `false`,
 * unconditionally and with no configuration that changes it.
 *
 * Secret is revealable only on a DIRECT-RENDER surface — a local CLI writing to
 * the user's own screen, where no model is in the loop — through
 * `authorizeSecretEgress`, which is per-item, single-use, and audited.
 *
 * ── WHAT WAS DROPPED IN THE EXTRACTION ─────────────────────────────────────
 * The upstream `dimaag_override_unlock` MCP tool wrote a short-TTL unlock flag
 * that raised the ceiling for SUBSEQUENT calls. It is deprecated by decision
 * and is NOT part of Sutra Core's 14-tool surface. The reason is worth stating:
 * a time-boxed ambient flag means a later request is answered at a ceiling
 * nobody re-authorised for it, which makes the audit line "who asked for this?"
 * unanswerable. The inline form below is per-request and carries its own proof.
 */

import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { type Tier, TIER_RANK } from "./tiers.js";

/**
 * `/override <pass> <query>` — also `!override` and `!reveal`, because a
 * leading slash is often intercepted by a chat client before it reaches us.
 * Group 1 = passphrase, group 2 = the real query (optional).
 */
const TRIGGER = /^\s*(?:\/override|!override|!reveal)\s+(\S+)(?:\s+([\s\S]*))?\s*$/i;

/** Gitignored, never committed, carried between the user's own trusted nodes. */
const OVERRIDE_KEY_REL = "state/secrets/override.key";
const OPLOG_REL = "logs/oplog.md";

export interface ParsedOverride {
  requested: boolean;
  passphrase: string;
  cleanQuery: string;
}

export function parseOverride(query: string): ParsedOverride {
  const m = TRIGGER.exec(query ?? "");
  if (!m) return { requested: false, passphrase: "", cleanQuery: query ?? "" };
  return { requested: true, passphrase: m[1] ?? "", cleanQuery: (m[2] ?? "").trim() };
}

/**
 * Constant-time compare. PURE — never reads the environment or the filesystem,
 * so it is trivially testable and cannot be surprised by ambient state.
 *
 * The length guard is not an optimisation: `timingSafeEqual` throws on
 * unequal-length buffers. Returning false leaks the length of the secret, which
 * is an accepted trade — the alternative is an exception on every wrong-length
 * guess, which is worse in every way.
 */
export function passphraseOk(supplied: string, secret: string): boolean {
  if (!secret || !supplied) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Resolve the override secret. The KEY FILE is authoritative where it exists,
 * because it is the thing that travels with the user across their own machines;
 * the environment variable is a fallback for a node that does not have it yet.
 *
 * Read fresh every time — no cache — so a key dropped or rotated while the
 * process runs is picked up. Never throws; an unresolvable secret means every
 * check fails closed.
 */
export function resolveOverrideSecret(root: string): string {
  const keyFile = join(root, OVERRIDE_KEY_REL);
  if (existsSync(keyFile)) {
    try {
      const v = readFileSync(keyFile, "utf8").trim();
      if (v.length > 0) return v;
    } catch {
      /* unreadable → fall through to the env fallback */
    }
  }
  const env = process.env["SUTRA_OVERRIDE_PASSPHRASE"];
  return env && env.length > 0 ? env : "";
}

/**
 * Raise `base` to the override ceiling, never lowering it.
 *
 * On the MCP (model) path `allowSecret` is ALWAYS false, so the ceiling is
 * `review_required` and `local_only` is unreachable. Only a direct-render
 * caller may pass true.
 */
function raised(base: Tier, allowSecret: boolean): Tier {
  const ceiling: Tier = allowSecret ? "local_only" : "review_required";
  return TIER_RANK[ceiling] >= TIER_RANK[base] ? ceiling : base;
}

export interface OverrideResult {
  /** Effective ceiling for THIS request. Never below `base`. */
  exposure: Tier;
  /** The query to actually run — trigger and passphrase stripped. */
  cleanQuery: string;
  /** An inline passphrase matched and raised the ceiling. */
  overrode: boolean;
  /** A trigger was present, matched or not. Recorded for audit either way. */
  attempted: boolean;
}

/**
 * Resolve the per-request ceiling from an inline `/override <pass>` trigger.
 *
 * Note what happens on a WRONG passphrase: the clean query still runs, at the
 * base ceiling. The passphrase text itself is never searched — a failed
 * override must not turn the user's secret into a search term that lands in a
 * query log.
 */
export function applyOverride(
  query: string,
  base: Tier,
  opts: { allowSecret?: boolean; secret?: string; root?: string } = {},
): OverrideResult {
  const p = parseOverride(query);
  if (!p.requested) {
    return { exposure: base, cleanQuery: query ?? "", overrode: false, attempted: false };
  }
  const secret =
    opts.secret ?? (opts.root !== undefined ? resolveOverrideSecret(opts.root) : "");
  if (!passphraseOk(p.passphrase, secret)) {
    return { exposure: base, cleanQuery: p.cleanQuery, overrode: false, attempted: true };
  }
  return {
    exposure: raised(base, Boolean(opts.allowSecret)),
    cleanQuery: p.cleanQuery,
    overrode: true,
    attempted: true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The narrow SECRET break-glass — per-item, single-use, audited
// ─────────────────────────────────────────────────────────────────────────────

const OPLOG_HEADER =
  "# Sutra op-log ledger\n\n" +
  "> Append-only, grep-parseable operation history. One line per op:\n" +
  "> `## [YYYY-MM-DD HH:mm] <op> | <detail>`.  Query:  `grep '^## \\[' logs/oplog.md | tail`.\n\n";

/** Append one op-log line. Best-effort — a ledger failure must never break the caller. */
function appendOpLog(root: string, op: string, detail: string, when: Date): void {
  try {
    const file = join(root, OPLOG_REL);
    mkdirSync(dirname(file), { recursive: true });
    if (!existsSync(file)) writeFileSync(file, OPLOG_HEADER, "utf8");
    const stamp = when.toISOString().slice(0, 16).replace("T", " ");
    appendFileSync(file, `## [${stamp}] ${op} | ${detail.replace(/[\r\n]+/g, " ")}\n`, "utf8");
  } catch {
    /* best-effort */
  }
}

/**
 * Authorise sending ONE specific secret item to the user's own screen.
 *
 * The properties that make this survivable, and none of which are optional:
 *
 *   - **Per-item.** It authorises exactly `itemId`, not a tier, not a scope.
 *   - **Single-use.** No flag is written, no TTL is set. The authorisation
 *     exists only as the return value of this call.
 *   - **Audited on failure too.** A denied attempt is the more interesting log
 *     line of the two, so both are written.
 *   - **Never on an agent path.** This is imported by the interactive CLI and
 *     by nothing else. No cron job, no capability runner, no MCP tool may
 *     reach it. `tests/defects/secret-floor.test.ts` asserts that import graph.
 *
 * The caller owns the explicit y/N confirmation. This function owns the proof
 * and the record.
 */
export function authorizeSecretEgress(
  root: string,
  passphrase: string,
  itemId: string,
  opts: { secret?: string; now?: number } = {},
): { ok: boolean; itemId: string } {
  const secret = opts.secret ?? resolveOverrideSecret(root);
  const ok = passphraseOk(passphrase, secret);
  const when = new Date(opts.now ?? Date.now());
  appendOpLog(
    root,
    "reveal",
    ok
      ? `itemId=${itemId} | secret reveal AUTHORIZED (break-glass, single-use, direct-render only)`
      : `itemId=${itemId} | secret reveal DENIED (passphrase not recognised)`,
    when,
  );
  return { ok, itemId };
}

/**
 * The per-item ceiling a successful break-glass grants. The interactive caller
 * applies it to EXACTLY the one authorised item, renders it, and discards it.
 * Nothing is persisted, and no model is in the loop.
 */
export function secretRevealCeiling(): Tier {
  return "local_only";
}
