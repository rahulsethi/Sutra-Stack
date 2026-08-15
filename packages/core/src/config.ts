// SPDX-License-Identifier: Apache-2.0
/**
 * Configuration — ported from `aatma/src/config.ts`.
 *
 * Three changes from the source, each with a reason:
 *
 *  1. **The `daemon` block is gone.** The daemon is an optional module (shape
 *     (c)); the core must not carry its configuration surface. `@sutra/daemon`
 *     owns its own config and extends this one.
 *
 *  2. **TOML → JSON.** The upstream used `smol-toml`. The core's contract is
 *     ONE runtime dependency (`gray-matter`), and `JSON.parse` is in the
 *     platform. A config format is not worth a dependency in the one package
 *     whose auditability is the product.
 *
 *  3. **No path is resolved relative to this file.** The upstream derived the
 *     vault root from `__dirname`, which silently assumed the install layout —
 *     the same class of assumption as D6's hook that did not survive a clone.
 *     Here the root is explicit: `SUTRA_VAULT` or a resolved config file or the
 *     cwd, in that order, and `sutra doctor` prints which one won.
 *
 * ── §9.6 · config synced between nodes carries the wrong paths ─────────────
 * A Windows interpreter path once landed in a Linux config and only surfaced on
 * restart. So every resolved path is recorded on the loaded config with WHERE
 * it came from, and `doctor` asserts the resolution is valid on THIS node
 * rather than trusting the file.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, dirname, isAbsolute } from "node:path";
import { homedir } from "node:os";
import type { Tier } from "./gate/tiers.js";
import type { ProviderMode } from "./gate/guard.js";

export type { Tier, ProviderMode };

/** Where a resolved value came from. Printed by `doctor`; never guessed at. */
export type ValueOrigin = "env" | "config-file" | "default" | "cwd" | "not-found";

export interface ResolvedPath {
  path: string;
  origin: ValueOrigin;
  exists: boolean;
}

export interface SutraConfig {
  /** The user's vault — a separate, user-owned git repo. Never a submodule (§9.9). */
  vaultRoot: ResolvedPath;
  /** The Sutra installation, where `automation/` and `vault-template/` live. */
  installRoot: ResolvedPath;
  /** Runtime skills. Split public/trusted; the trusted half is never exposed. */
  skillsRoot: ResolvedPath;

  provider: {
    /** Which provider mode serves each tier. `local_only` is `local` and is not configurable to anything else. */
    local_only: ProviderMode;
    review_required: ProviderMode;
    hosted_allowed: ProviderMode;
    /** An on-machine model endpoint, if the user has one. */
    local: { endpoint: string; model: string };
  };

  observability: {
    event_log: string;
    sensitivity_log: string;
    provider_log: string;
    metrics_csv: string;
  };

  /** Vault-relative directories the retrieval layer is allowed to walk. */
  walkRoots: string[];

  /** Non-fatal problems found while loading. Surfaced by `doctor`, never swallowed. */
  warnings: string[];
}

export const CONFIG_FILENAME = "sutra.config.json";

/**
 * Defence in depth, restated as code: the tier→provider mapping is loadable
 * from config for `review_required` and `hosted_allowed`, but `local_only` is
 * PINNED to `local`. There is no configuration, environment variable, or flag
 * that routes secret content to a hosted provider — which is what "the secret
 * floor is absolute in every instance" means operationally.
 */
const PINNED_LOCAL_ONLY: ProviderMode = "local";

function resolvePath(
  candidates: Array<{ path: string | undefined; origin: ValueOrigin }>,
): ResolvedPath {
  for (const c of candidates) {
    if (!c.path) continue;
    const abs = isAbsolute(c.path) ? c.path : resolve(process.cwd(), c.path);
    if (existsSync(abs)) return { path: abs, origin: c.origin, exists: true };
  }
  const fallback = candidates.find((c) => c.path);
  if (fallback?.path) {
    const abs = isAbsolute(fallback.path) ? fallback.path : resolve(process.cwd(), fallback.path);
    return { path: abs, origin: fallback.origin, exists: false };
  }
  return { path: "", origin: "not-found", exists: false };
}

/**
 * Find the config file: `SUTRA_CONFIG`, then walking up from cwd, then
 * `~/.sutra/sutra.config.json`. Walking up is what makes `sutra ask` work from
 * any subdirectory of a project, which is where people actually run it.
 */
function findConfigFile(): { path: string | null; origin: ValueOrigin } {
  const fromEnv = process.env["SUTRA_CONFIG"];
  if (fromEnv && existsSync(fromEnv)) return { path: fromEnv, origin: "env" };

  let dir = process.cwd();
  for (let i = 0; i < 24; i++) {
    const candidate = join(dir, CONFIG_FILENAME);
    if (existsSync(candidate)) return { path: candidate, origin: "cwd" };
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const home = join(homedir(), ".sutra", CONFIG_FILENAME);
  if (existsSync(home)) return { path: home, origin: "default" };
  return { path: null, origin: "not-found" };
}

interface RawConfig {
  vault_root?: string;
  install_root?: string;
  skills_root?: string;
  walk_roots?: string[];
  provider?: {
    review_required?: string;
    hosted_allowed?: string;
    local?: { endpoint?: string; model?: string };
  };
  observability?: Record<string, string>;
}

function coerceMode(v: unknown, fallback: ProviderMode): ProviderMode {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "local" || s === "hosted" || s === "manual" || s === "skip" ? s : fallback;
}

export function loadConfig(opts: { cwd?: string } = {}): SutraConfig {
  const warnings: string[] = [];
  const found = findConfigFile();

  let raw: RawConfig = {};
  if (found.path) {
    try {
      raw = JSON.parse(readFileSync(found.path, "utf8")) as RawConfig;
    } catch (e) {
      // Loud. A malformed config that silently becomes defaults is how a node
      // ends up running with a ceiling nobody chose.
      warnings.push(
        `config file ${found.path} is unparseable — running on defaults: ` +
        `${e instanceof Error ? e.message : String(e)}`,
      );
    }
  } else {
    warnings.push(
      `no ${CONFIG_FILENAME} found (looked at $SUTRA_CONFIG, up from the working directory, ` +
      `and ~/.sutra/). Run \`sutra init\`.`,
    );
  }

  const configDir = found.path ? dirname(found.path) : (opts.cwd ?? process.cwd());
  const rel = (p: string | undefined): string | undefined =>
    p === undefined ? undefined : isAbsolute(p) ? p : resolve(configDir, p);

  const vaultRoot = resolvePath([
    { path: process.env["SUTRA_VAULT"], origin: "env" },
    { path: rel(raw.vault_root), origin: "config-file" },
    { path: join(configDir, "vault"), origin: "default" },
  ]);

  const installRoot = resolvePath([
    { path: process.env["SUTRA_HOME"], origin: "env" },
    { path: rel(raw.install_root), origin: "config-file" },
    { path: configDir, origin: "default" },
  ]);

  const skillsRoot = resolvePath([
    { path: process.env["SUTRA_SKILLS"], origin: "env" },
    { path: rel(raw.skills_root), origin: "config-file" },
    { path: join(installRoot.path, "skills"), origin: "default" },
  ]);

  if (!vaultRoot.exists) {
    warnings.push(
      `vault root ${vaultRoot.path} (from ${vaultRoot.origin}) does not exist on this node. ` +
      `A config synced from another machine carries that machine's paths (§9.6).`,
    );
  }

  return {
    vaultRoot,
    installRoot,
    skillsRoot,
    provider: {
      // NOT configurable. See PINNED_LOCAL_ONLY above.
      local_only: PINNED_LOCAL_ONLY,
      review_required: coerceMode(raw.provider?.review_required, "local"),
      hosted_allowed: coerceMode(raw.provider?.hosted_allowed, "hosted"),
      local: {
        endpoint: raw.provider?.local?.endpoint ?? "http://127.0.0.1:11434",
        model: raw.provider?.local?.model ?? "",
      },
    },
    observability: {
      event_log: raw.observability?.["event_log"] ?? "logs/sutra/events.ndjson",
      sensitivity_log: raw.observability?.["sensitivity_log"] ?? "logs/sutra/sensitivity.ndjson",
      provider_log: raw.observability?.["provider_log"] ?? "logs/sutra/provider.ndjson",
      metrics_csv: raw.observability?.["metrics_csv"] ?? "state/metrics.csv",
    },
    walkRoots: Array.isArray(raw.walk_roots) && raw.walk_roots.length
      ? raw.walk_roots
      : DEFAULT_WALK_ROOTS.slice(),
    warnings,
  };
}

/**
 * DEFENCE IN DEPTH, BEFORE THE PER-NOTE GATE EVEN RUNS.
 *
 * Only durable, human-facing trees are ever walked. `raw/` (intake, unclassified
 * by definition), `compiled/conversations/` (interpersonal), `logs/` and
 * `state/` are excluded structurally — not because their notes would fail the
 * tier gate, but so that a note that somehow lacks a tier can never be reached
 * by a retrieval path in the first place.
 *
 * D14's lesson applies directly: nothing in the upstream system reached the
 * public mirror only because the exporter *happened* not to copy
 * `compiled/extracts/`. That was a lucky omission, not a control. This list is
 * the control.
 */
export const DEFAULT_WALK_ROOTS = ["vault", "compiled/pages"];

/** THE EXPOSURE CEILING. Read from the environment ONCE, at startup. */
export function ceilingFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fallback: Tier = "hosted_allowed",
): Tier {
  const raw = env["SUTRA_MCP_EXPOSURE"];
  if (!raw) return fallback;
  const s = raw.trim().toLowerCase();
  const map: Record<string, Tier> = {
    public: "hosted_allowed", hosted_allowed: "hosted_allowed",
    private: "review_required", review_required: "review_required",
    secret: "local_only", local_only: "local_only",
  };
  const resolved = map[s];
  if (!resolved) {
    // An unrecognised ceiling must not become the most permissive one.
    process.stderr.write(
      `sutra: SUTRA_MCP_EXPOSURE="${raw}" is not a recognised tier. ` +
      `Falling back to the most restrictive interpretation (private).\n`,
    );
    return "review_required";
  }
  return resolved;
}

/** Directory mtime, or null. Used by doctor/status; never throws. */
export function safeMtime(path: string): Date | null {
  try {
    return statSync(path).mtime;
  } catch {
    return null;
  }
}
