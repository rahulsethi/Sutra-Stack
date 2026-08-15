// SPDX-License-Identifier: Apache-2.0
/**
 * THE ONLY AGENT WRITE PATH — lifted from `aatma/src/mcp/capture.ts`.
 *
 * ── INVARIANT 6 · Writes are narrow, floored, additive, audited ────────────
 * A model can put exactly one kind of thing into a vault: a CAPTURE, in the
 * inbox, floored to private, as a brand-new file, behind an opt-in env var that
 * fails closed. Four independent properties, each of which alone would make the
 * write path safe to expose, and all four of which are kept:
 *
 *   • **capture-not-durable** — writes ONLY under `vault/00-inbox`. Never
 *     `compiled/pages` (durable), never `raw/manifests`, never `raw/` at all.
 *     The note enters the SAME funnel a phone capture uses, and flows through
 *     the normal ingest → review → compile pipeline.
 *
 *   • **sensitivity floor** — floored at `review_required`. A hosted-exposed
 *     caller can never mint public content. A STRICTER request is preserved:
 *     asking for `secret` gets `secret`. The clamp is one-directional.
 *
 *   • **additive, never overwriting** — a fresh random filename is minted and
 *     re-minted until it does not collide. There is no code path here that
 *     opens an existing file for writing.
 *
 *   • **propose-don't-act** — the note lands queued for review. It is not
 *     auto-promoted to a durable page, and not auto-promoted to a higher tier.
 *
 * The trusted-surface gate (`SUTRA_MCP_ALLOW_WRITE`, fail-closed) lives in the
 * MCP server, not here — so this function is pure filesystem behaviour and can
 * be tested without an environment.
 *
 * ── Why a model may write at all ───────────────────────────────────────────
 * Because the alternative is worse. A substrate an assistant can read but never
 * add to means every insight from a conversation is lost unless the user
 * retypes it — and a governance model that makes the safe path inconvenient is
 * a governance model people route around.
 */

import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { type Tier, TIER_RANK, TIER_DISPLAY, coerceTier } from "../gate/tiers.js";

/** The capture funnel destination. The same one every other capture surface uses. */
export const CAPTURE_DIR = "vault/00-inbox";

/**
 * The floor for agent write-back. A capture may never be more permissive than
 * `review_required`. Combined with capture-not-durable, this is what makes the
 * tool safe to expose to a hosted caller: it cannot produce public durable
 * content, so there is no path from "the model said so" to "the corpus says so".
 */
export const CAPTURE_FLOOR: Tier = "review_required";

/**
 * Clamp a caller-supplied sensitivity to the floor.
 *
 *   missing / unknown          → private (the default AND the floor)
 *   public / hosted_allowed    → RAISED to private (never public)
 *   private / review_required  → unchanged
 *   secret / local_only        → unchanged (never downscoped)
 */
export function floorSensitivity(input: unknown): Tier {
  const t = coerceTier(input);
  return TIER_RANK[t] < TIER_RANK[CAPTURE_FLOOR] ? CAPTURE_FLOOR : t;
}

export interface CaptureInput {
  text: string;
  title?: string;
  sensitivity?: unknown;
  tags?: unknown;
  /** Which surface asked. Recorded on the note so provenance survives. */
  source?: string;
}

export interface CaptureResult {
  relPath: string;
  absPath: string;
  tier: Tier;
  /** The floored tier's display spelling — never "public". */
  display: string;
  /** True iff the requested tier was clamped up. Reported to the caller. */
  clamped: boolean;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((x) => String(x).trim().replace(/^#/, ""))
    .filter((x) => x.length > 0)
    // Keep frontmatter-safe: no commas or brackets, which would break the
    // inline-array form and silently corrupt the note's own metadata.
    .map((x) => x.replace(/[^\w/-]+/g, "-"))
    .slice(0, 24);
}

/**
 * Write a capture note and return its path and resolved tier.
 *
 * Pure filesystem write. The trust gate and the audit line are the caller's
 * responsibility — deliberately, so that this can be exercised in a test
 * without an environment and without a log.
 *
 * Throws only on empty text. The floor is ALWAYS applied; there is no options
 * bag that disables it.
 */
export function writeCapture(vaultRoot: string, input: CaptureInput): CaptureResult {
  const bodyText = String(input.text ?? "").trim();
  if (!bodyText) throw new Error("sutra_capture: text must not be empty.");

  const requested = coerceTier(input.sensitivity);
  const tier = floorSensitivity(input.sensitivity);
  const clamped = TIER_RANK[requested] < TIER_RANK[tier];
  const display = TIER_DISPLAY[tier];
  const tags = normalizeTags(input.tags);

  const d = new Date();
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const compact =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;

  const dirAbs = join(vaultRoot, "vault", "00-inbox");
  mkdirSync(dirAbs, { recursive: true });

  // Mint a fresh, unique filename. This loop is the "additive, never
  // overwriting" property: there is no branch here that reuses a path.
  let name = `agent-${compact}-${randomBytes(3).toString("hex")}.md`;
  while (existsSync(join(dirAbs, name))) {
    name = `agent-${compact}-${randomBytes(3).toString("hex")}.md`;
  }
  const absPath = join(dirAbs, name);

  const titleText =
    input.title != null && String(input.title).trim().length > 0
      ? String(input.title).trim()
      : `Agent capture — ${date} ${hm}`;

  const lines: string[] = [
    "---",
    "type: Source",
    "kind: agent_capture",
    "status: active",
    `source_date: ${date}`,
    `ingested_at: ${d.toISOString()}`,
    `captured_by: ${(input.source ?? "sutra_capture").replace(/[\r\n:]/g, " ")}`,
    `sensitivity: ${display}`,
    "related_to: []",
  ];
  if (tags.length > 0) lines.push(`tags: [${tags.join(", ")}]`);
  lines.push(
    "---",
    "",
    `# ${titleText}`,
    "",
    bodyText,
    "",
    "## Notes",
    "- Captured via `sutra_capture` (agent write-back); queued for review, not yet a durable page.",
    `- Sensitivity is floored to \`${display}\`${clamped ? " (the requested tier was more permissive and was clamped up)" : ""}.`,
    "- Promote to a durable page only after human review.",
  );

  writeFileSync(absPath, lines.join("\n") + "\n", "utf8");
  return { relPath: `${CAPTURE_DIR}/${name}`, absPath, tier, display, clamped };
}

/**
 * The opt-in write gate, fail-closed.
 *
 * Kept next to the write it guards rather than in the server, so that the
 * decision and its reason are readable in one place. ANY value other than an
 * explicit `1`/`true` refuses — including the empty string, which is what an
 * unset-but-declared environment variable looks like in most shells and is a
 * classic way for a guard to silently open.
 */
export function writeAllowed(env: NodeJS.ProcessEnv = process.env): { allowed: boolean; reason: string } {
  const raw = env["SUTRA_MCP_ALLOW_WRITE"];
  if (raw === undefined || raw === "") {
    return {
      allowed: false,
      reason:
        "agent write-back is OFF. Set SUTRA_MCP_ALLOW_WRITE=1 on the server registration to enable " +
        "`sutra_capture`. It is off by default because a write path should be a decision, not an inheritance.",
    };
  }
  const s = raw.trim().toLowerCase();
  if (s === "1" || s === "true") return { allowed: true, reason: "ok" };
  return {
    allowed: false,
    reason: `agent write-back is OFF: SUTRA_MCP_ALLOW_WRITE="${raw}" is not an explicit opt-in (use 1 or true).`,
  };
}
