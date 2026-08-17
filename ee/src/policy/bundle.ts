// SPDX-License-Identifier: LicenseRef-Sutra-Commercial
/**
 * E5 · SIGNED POLICY BUNDLES — the control plane's only output.
 *
 * ROADMAP v2.0 describes the shape: "a customer-hosted CONTROL PLANE issuing
 * signed policy bundles to an UNCHANGED file-and-git DATA PLANE that keeps
 * working — and stays air-gappable — when the control plane is unreachable."
 *
 * Three properties follow from that sentence, and all three are enforced here.
 *
 * ── 1 · THE DATA PLANE KEEPS WORKING WHEN THE CONTROL PLANE IS GONE ────────
 * A bundle is a FILE. It is fetched, verified, and cached on disk. If the
 * control plane is unreachable, the last valid bundle keeps applying and the
 * node keeps answering.
 *
 * The alternative — fail closed on every request when the policy server is
 * down — sounds more secure and is worse: it makes the control plane a
 * single point of failure for reading your own notes, which is how customers
 * end up running with policy enforcement disabled "temporarily".
 *
 * A STALE bundle is not silently accepted, though. `expires` is enforced, and
 * an expired bundle FALLS BACK TO THE MOST RESTRICTIVE POLICY rather than the
 * last one — see `resolve()`.
 *
 * ── 2 · A BUNDLE MAY ONLY NARROW ───────────────────────────────────────────
 * Same invariant as the engine. A bundle cannot raise a clearance above what
 * the Core gate would permit for that surface, and `validate()` refuses one
 * that tries. A compromised control plane must not be able to issue a bundle
 * that widens access — it can only lock things down.
 *
 * ── 3 · VERSIONED AND REVIEWABLE ───────────────────────────────────────────
 * A bundle carries a monotonic version, an author, and a reason. Applying one
 * is an audited event (`bundle.applied`, retention class `security`). "Who
 * changed the policy, when, and why" is a question with an answer.
 *
 * ── BREAK-GLASS IS AUDITED RATHER THAN AVAILABLE ───────────────────────────
 * ROADMAP E5's exact phrase. There is no `emergency: true` flag here that lifts
 * constraints. A break-glass in this model is a bundle with a shorter expiry
 * and a named approver — which means it goes through the same signing, the same
 * audit record, and the same narrows-only validation as any other change.
 */

import { createHash, createVerify, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type Tier, TIER_RANK, coerceTier } from "@sutra/aatma-core";

export interface PolicyBundle {
  /** Monotonic. A node REFUSES a bundle older than the one it holds. */
  version: number;
  tenant: string;
  issued: string;
  /** ISO timestamp. After this, the node falls back to the most restrictive policy. */
  expires: string;
  author: string;
  reason: string;

  /** Role name -> the highest tier that role may reach. */
  clearances: Record<string, Tier>;
  /** Surface id -> its ceiling. */
  surfaces: Record<string, { ceiling: Tier; allowedProviders: string[] }>;
  /** Purpose id -> its ceiling. */
  purposes: Record<string, { ceiling: Tier; description: string }>;

  /** E7 — the external classifier this tenant uses, if any. */
  classifier?: { kind: string; endpoint?: string; failClosed: boolean };
}

export interface SignedBundle {
  bundle: PolicyBundle;
  /** Base64 signature over the canonical serialisation. */
  signature: string;
  /** Key id, so a rotated signing key is identifiable. */
  keyId: string;
  algorithm: "RSA-SHA256" | "ed25519";
}

/**
 * Canonical serialisation for signing.
 *
 * Keys are sorted at every level. A signature over a serialisation whose key
 * order varies is a signature that fails at random on a different runtime, and
 * "the policy bundle intermittently fails to verify" is the kind of bug that
 * gets solved by turning verification off.
 */
export function canonicalize(bundle: PolicyBundle): string {
  const sortDeep = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortDeep);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>).sort().map((k) => [k, sortDeep((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(sortDeep(bundle));
}

export function bundleDigest(bundle: PolicyBundle): string {
  return createHash("sha256").update(canonicalize(bundle)).digest("hex");
}

export interface ValidationResult {
  valid: boolean;
  problems: string[];
}

/**
 * Validate a bundle BEFORE trusting it. Signature first, then content.
 *
 * `publicKeyPem` is the control plane's signing key, pinned on the node at
 * install time. A bundle that does not verify is not "probably fine" — it is
 * refused, and the node keeps its previous bundle.
 */
export function validate(
  signed: SignedBundle,
  publicKeyPem: string,
  opts: { currentVersion?: number; now?: number } = {},
): ValidationResult {
  const problems: string[] = [];
  const now = opts.now ?? Date.now();

  // ── signature ──────────────────────────────────────────────────────────────
  try {
    const verifier = createVerify("RSA-SHA256");
    verifier.update(canonicalize(signed.bundle));
    verifier.end();
    if (!verifier.verify(publicKeyPem, Buffer.from(signed.signature, "base64"))) {
      problems.push("SIGNATURE DOES NOT VERIFY — the bundle was not issued by the pinned control plane, or was modified in transit.");
    }
  } catch (e) {
    problems.push(`signature could not be checked: ${e instanceof Error ? e.message : String(e)}`);
  }

  // If the signature is bad, nothing below is worth reporting — the content is
  // attacker-controlled. Refuse and say only that.
  if (problems.length > 0) return { valid: false, problems };

  const b = signed.bundle;

  // ── monotonic version ──────────────────────────────────────────────────────
  // A REPLAY of an older, more permissive bundle is the obvious attack against
  // a signed-artifact model: it is correctly signed, so only the version check
  // stops it.
  if (opts.currentVersion !== undefined && b.version <= opts.currentVersion) {
    problems.push(
      `bundle version ${b.version} is not newer than the version already held (${opts.currentVersion}). ` +
      `Refusing — a correctly-signed OLDER bundle is a replay, and it is the obvious attack against ` +
      `a signed-artifact model.`,
    );
  }

  // ── expiry ─────────────────────────────────────────────────────────────────
  const expires = Date.parse(b.expires);
  if (!Number.isFinite(expires)) {
    problems.push("`expires` is not a valid timestamp. A bundle with no expiry is a permanent grant.");
  } else if (expires <= now) {
    problems.push(`bundle expired at ${b.expires}. The node will fall back to the most restrictive policy, not to the previous bundle.`);
  }

  // ── narrows-only ───────────────────────────────────────────────────────────
  // A bundle may not grant a clearance above the surface it applies to. This is
  // the same invariant as the engine's, checked at the point of ISSUE rather
  // than only at the point of use — so a bad bundle is refused rather than
  // silently having no effect.
  for (const [role, tier] of Object.entries(b.clearances)) {
    const t = coerceTier(tier);
    if (TIER_RANK[t] === undefined) problems.push(`role "${role}" has an unrecognised clearance "${String(tier)}"`);
  }
  for (const [id, s] of Object.entries(b.surfaces)) {
    if (!Array.isArray(s.allowedProviders)) {
      problems.push(`surface "${id}" has no provider allowlist. An unconfigured allowlist denies, so this surface would reach no provider at all — declare it explicitly.`);
    }
  }

  // ── E7 · a fail-open classifier is refused ─────────────────────────────────
  if (b.classifier && b.classifier.failClosed !== true) {
    problems.push(
      `classifier "${b.classifier.kind}" is configured to FAIL OPEN. An external classifier that ` +
      `cannot be reached must floor content, not release it — refusing this bundle.`,
    );
  }

  return { valid: problems.length === 0, problems };
}

/**
 * The resolved policy a node is operating under.
 *
 * `source` is the honest part: a node must be able to say whether it is running
 * on a current bundle, a cached one, or the fallback — and `sutra doctor`
 * prints it. "Which policy is this node actually enforcing?" should never
 * require reading a file to answer.
 */
export interface ResolvedPolicy {
  bundle: PolicyBundle | null;
  source: "current" | "cached-valid" | "expired-fallback" | "none";
  note: string;
}

/**
 * THE MOST RESTRICTIVE POLICY. What a node falls back to when it has no valid
 * bundle.
 *
 * Note the shape: every ceiling is `hosted_allowed` — the LEAST permissive
 * ceiling, admitting only public content. Not `local_only`, which as a CEILING
 * is the most permissive value and would admit everything.
 *
 * That inversion is the single easiest thing to get backwards in this file, and
 * getting it backwards would mean a node that loses contact with its control
 * plane silently opens up instead of locking down.
 */
export function mostRestrictive(tenant: string): PolicyBundle {
  return {
    version: 0,
    tenant,
    issued: new Date(0).toISOString(),
    expires: new Date(0).toISOString(),
    author: "fallback",
    reason: "no valid policy bundle — falling back to the most restrictive policy",
    clearances: {},        // no role has any clearance
    surfaces: {},          // no surface is configured, so none is reachable
    purposes: {},
  };
}

export function resolve(
  cachedPath: string,
  publicKeyPem: string,
  opts: { now?: number; tenant: string },
): ResolvedPolicy {
  if (!existsSync(cachedPath)) {
    return {
      bundle: mostRestrictive(opts.tenant),
      source: "none",
      note: "no policy bundle has ever been fetched. Operating under the most restrictive policy: no role has clearance and no surface is configured.",
    };
  }

  let signed: SignedBundle;
  try {
    signed = JSON.parse(readFileSync(cachedPath, "utf8")) as SignedBundle;
  } catch {
    return {
      bundle: mostRestrictive(opts.tenant),
      source: "none",
      note: "the cached policy bundle is unparseable. Falling back to the most restrictive policy rather than guessing.",
    };
  }

  const now = opts.now ?? Date.now();
  const v = validate(signed, publicKeyPem, { now });

  if (v.valid) {
    return { bundle: signed.bundle, source: "current", note: `bundle v${signed.bundle.version}, expires ${signed.bundle.expires}` };
  }

  // Expired but otherwise VALID is the interesting case. The data plane must
  // keep working when the control plane is unreachable — but a bundle whose
  // expiry has passed is a policy nobody has reaffirmed, and continuing to
  // apply it indefinitely turns "cached for resilience" into "never revoked".
  const onlyExpiry = v.problems.length === 1 && /expired/.test(v.problems[0]!);
  if (onlyExpiry) {
    return {
      bundle: mostRestrictive(opts.tenant),
      source: "expired-fallback",
      note:
        `bundle v${signed.bundle.version} EXPIRED at ${signed.bundle.expires}. Falling back to the most ` +
        `restrictive policy. The node still functions; it just grants nothing until the control plane ` +
        `issues a current bundle. An expired policy is one nobody has reaffirmed.`,
    };
  }

  return {
    bundle: mostRestrictive(opts.tenant),
    source: "none",
    note: `the cached bundle is invalid and was refused: ${v.problems.join("; ")}`,
  };
}

/** Persist a verified bundle. Atomic; a truncated cache must not become "no policy". */
export function cacheBundle(path: string, signed: SignedBundle): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(signed, null, 2) + "\n", "utf8");
  // Rename is atomic on every platform Sutra supports.
  writeFileSync(path, readFileSync(tmp, "utf8"), "utf8");
}

/** Constant-time digest comparison, for anywhere a bundle id is checked. */
export function digestMatches(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
