// SPDX-License-Identifier: LicenseRef-Sutra-Commercial
/**
 * E6 · SUPPLY CHAIN AND ASSURANCE.
 *
 * SBOM, signed releases, dependency policy. The part of enterprise readiness
 * that is pure paperwork right up until the moment a customer's procurement
 * team asks for it, at which point it is the whole deal.
 *
 * ── SUTRA HAS AN UNUSUALLY EASY TIME HERE, AND SHOULD SAY SO ──────────────
 * `@sutra/aatma-core` has ONE runtime dependency. `@sutra/hermes-mcp` has ZERO. That was a
 * design constraint for auditability — the thing deciding what your AI can see
 * should be readable in an afternoon — and it pays a second time here: an SBOM
 * with four entries is one a security team actually reads.
 *
 * `enforce()` below is what keeps it that way. A dependency added casually is
 * a dependency nobody audits, and the ratchet only holds if something checks.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export interface SbomComponent {
  name: string;
  version: string;
  license: string;
  /** Which package pulled it in. Transitive dependencies have a path. */
  introducedBy: string[];
  purl: string;
}

export interface DependencyPolicy {
  /**
   * Licences that are FORBIDDEN outright.
   *
   * GPL and AGPL are here for a specific reason, from LICENSING.md §5: a
   * copyleft runtime dependency can force Core's own licence, which would undo
   * the Apache-2.0 choice entirely. That is not a style preference — it is a
   * dependency that silently relicenses the product.
   */
  forbiddenLicenses: readonly string[];
  /** Licences that need a human decision before they land. */
  reviewLicenses: readonly string[];
  /** The ratchet. Exceeding it is a decision, not an accident. */
  maxRuntimeDependencies: Readonly<Record<string, number>>;
}

export const DEFAULT_POLICY: DependencyPolicy = {
  forbiddenLicenses: [
    "GPL-2.0", "GPL-3.0", "AGPL-3.0", "AGPL-3.0-only", "AGPL-3.0-or-later",
    "SSPL-1.0", "BUSL-1.1",
  ],
  reviewLicenses: ["LGPL-2.1", "LGPL-3.0", "MPL-2.0", "EPL-2.0", "CDDL-1.0", "UNKNOWN"],
  maxRuntimeDependencies: {
    // These numbers are the product's auditability claim, expressed as a limit.
    // Raising one is a deliberate act with a reason attached.
    "@sutra/aatma-core": 1,   // gray-matter
    "@sutra/hermes-mcp": 0,    // zero, by design. The MCP server is the trust surface.
    "@sutra/cli": 0,    // workspace-internal only
  },
};

export interface PolicyViolation {
  severity: "block" | "review";
  component: string;
  reason: string;
}

/**
 * Check the dependency graph against the policy.
 *
 * Runs in CI. A forbidden licence BLOCKS; a review licence and a breached
 * ceiling are reported for a human.
 */
export function enforce(
  components: readonly SbomComponent[],
  runtimeCounts: Readonly<Record<string, number>>,
  policy: DependencyPolicy = DEFAULT_POLICY,
): { ok: boolean; violations: PolicyViolation[] } {
  const violations: PolicyViolation[] = [];

  for (const c of components) {
    const lic = (c.license ?? "UNKNOWN").toUpperCase();
    if (policy.forbiddenLicenses.some((f) => lic.includes(f.toUpperCase()))) {
      violations.push({
        severity: "block",
        component: `${c.name}@${c.version}`,
        reason:
          `licence ${c.license} is forbidden. A copyleft RUNTIME dependency can force Core's own ` +
          `licence, which would silently undo the Apache-2.0 choice. Introduced by: ${c.introducedBy.join(" -> ")}`,
      });
    } else if (policy.reviewLicenses.some((r) => lic.includes(r.toUpperCase()))) {
      violations.push({
        severity: "review",
        component: `${c.name}@${c.version}`,
        reason: `licence ${c.license} needs a human decision before it ships.`,
      });
    }
  }

  for (const [pkg, max] of Object.entries(policy.maxRuntimeDependencies)) {
    const actual = runtimeCounts[pkg];
    if (actual !== undefined && actual > max) {
      violations.push({
        severity: "review",
        component: pkg,
        reason:
          `${actual} runtime dependencies, ceiling ${max}. That ceiling IS the auditability claim — ` +
          `"the thing deciding what your AI can see is readable in an afternoon". Raise it deliberately, ` +
          `with a reason, or drop the dependency.`,
      });
    }
  }

  return { ok: !violations.some((v) => v.severity === "block"), violations };
}

/** Build an SBOM from the workspace's package manifests. CycloneDX-shaped. */
export function generate(root: string, packages: readonly string[]): {
  bomFormat: string;
  specVersion: string;
  serialNumber: string;
  components: SbomComponent[];
} {
  const components = new Map<string, SbomComponent>();

  for (const pkg of packages) {
    const manifestPath = join(root, pkg, "package.json");
    if (!existsSync(manifestPath)) continue;
    let manifest: { name?: string; dependencies?: Record<string, string> };
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      continue;
    }

    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      // A workspace-internal dependency is not third-party supply chain.
      if (name.startsWith("@sutra/")) continue;

      const key = `${name}@${version}`;
      const existing = components.get(key);
      if (existing) {
        existing.introducedBy.push(manifest.name ?? pkg);
        continue;
      }

      let license = "UNKNOWN";
      const depManifest = join(root, "node_modules", name, "package.json");
      if (existsSync(depManifest)) {
        try {
          const d = JSON.parse(readFileSync(depManifest, "utf8")) as { license?: string | { type?: string } };
          license = typeof d.license === "string" ? d.license : (d.license?.type ?? "UNKNOWN");
        } catch { /* leave UNKNOWN — which lands in `reviewLicenses`, deliberately */ }
      }

      components.set(key, {
        name,
        version,
        license,
        introducedBy: [manifest.name ?? pkg],
        purl: `pkg:npm/${name}@${version.replace(/^[\^~]/, "")}`,
      });
    }
  }

  const sorted = [...components.values()].sort((a, b) => a.name.localeCompare(b.name));

  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    // Deterministic from the content: two builds of the same tree produce the
    // same serial. A "reproducible" SBOM containing a random UUID is not one
    // anyone can diff, and diffing is the only thing an SBOM is good for.
    serialNumber:
      "urn:uuid:" +
      createHash("sha256")
        .update(sorted.map((c) => c.purl).join("\n"))
        .digest("hex")
        .slice(0, 32)
        .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5"),
    components: sorted,
  };
}
