// SPDX-License-Identifier: Apache-2.0
/**
 * Skill enumeration — ported from `aatma/src/mcp/skills.ts`.
 *
 * ── THE STRUCTURAL TRUST SPLIT ─────────────────────────────────────────────
 * Upstream had 47 runtime skills in one tree, with exposure decided per-skill by
 * frontmatter. Sutra Core splits them by DIRECTORY instead:
 *
 *     skills/public/    hosted-safe leaves      — may be listed and read by a harness
 *     skills/trusted/   the governance surface  — NEVER exposed, at any ceiling
 *
 * A directory is a stronger boundary than a frontmatter key, for one specific
 * reason: a missing or misspelled key defaults to *something*, and the
 * upstream default was permissive. A file in `skills/trusted/` cannot
 * accidentally become public by having a typo in its header — it would have to
 * be MOVED, which is visible in a diff and in a review.
 *
 * This is D4's lesson generalised: a rule that can silently fail to apply is a
 * rule that will silently fail to apply.
 */

import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { join, relative, sep } from "node:path";
import matter from "gray-matter";

export type SkillTrust = "public" | "trusted";

export interface SkillRef {
  id: string;
  name: string;
  description: string;
  trust: SkillTrust;
  relPath: string;
  /** `inference.hosted_allowed: false` → this skill refuses to run in a hosted context. */
  hosted_allowed: boolean | undefined;
}

export interface SkillDetail extends SkillRef {
  body: string;
}

const SKILL_FILE = "SKILL.md";

function* walkSkillDirs(root: string): Generator<string> {
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = join(root, e.name);
    if (existsSync(join(dir, SKILL_FILE))) yield dir;
    else yield* walkSkillDirs(dir);
  }
}

function parseSkill(skillsRoot: string, dir: string, trust: SkillTrust): SkillDetail | null {
  const file = join(dir, SKILL_FILE);
  try {
    const parsed = matter(readFileSync(file, "utf8"));
    const data = parsed.data as Record<string, unknown>;
    const relPath = relative(skillsRoot, file).split(sep).join("/");
    const id = String(data["name"] ?? dir.split(/[\\/]/).pop() ?? "unknown");
    const inference = data["inference"] as { hosted_allowed?: boolean } | undefined;
    return {
      id,
      name: String(data["name"] ?? id),
      description: String(data["description"] ?? "").trim(),
      trust,
      relPath,
      hosted_allowed: typeof inference?.hosted_allowed === "boolean" ? inference.hosted_allowed : undefined,
      body: parsed.content,
    };
  } catch {
    return null;
  }
}

/**
 * List skills.
 *
 * `includeTrusted` defaults to FALSE. The MCP server never passes true; only
 * the local CLI does. The default is the safe one, because a helper whose
 * dangerous mode is the default gets used in its dangerous mode.
 */
export function listSkills(
  skillsRoot: string,
  opts: { includeTrusted?: boolean } = {},
): SkillRef[] {
  const out: SkillRef[] = [];
  const roots: Array<[string, SkillTrust]> = [[join(skillsRoot, "public"), "public"]];
  if (opts.includeTrusted) roots.push([join(skillsRoot, "trusted"), "trusted"]);

  for (const [root, trust] of roots) {
    if (!existsSync(root)) continue;
    for (const dir of walkSkillDirs(root)) {
      const s = parseSkill(skillsRoot, dir, trust);
      if (s) {
        const { body: _body, ...ref } = s;
        out.push(ref);
      }
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/**
 * Fetch one skill's full text.
 *
 * A trusted skill is NOT FOUND unless `includeTrusted` is set — deliberately
 * `not_found` rather than `withheld`. Unlike a note, whose existence is a
 * legitimate thing for a user to learn about (and which leaves an exposure
 * request behind), the trusted skill surface is the governance machinery
 * itself, and enumerating it to an untrusted caller is a reconnaissance aid
 * with no corresponding user benefit.
 */
export function getSkill(
  skillsRoot: string,
  id: string,
  opts: { includeTrusted?: boolean } = {},
): { status: "ok"; skill: SkillDetail } | { status: "not_found" } {
  const roots: Array<[string, SkillTrust]> = [[join(skillsRoot, "public"), "public"]];
  if (opts.includeTrusted) roots.push([join(skillsRoot, "trusted"), "trusted"]);

  for (const [root, trust] of roots) {
    if (!existsSync(root)) continue;
    for (const dir of walkSkillDirs(root)) {
      const s = parseSkill(skillsRoot, dir, trust);
      if (s && (s.id === id || s.relPath === id)) return { status: "ok", skill: s };
    }
  }
  return { status: "not_found" };
}

/**
 * §9.1 · "CREATED ≠ WIRED" — the single most repeated failure in the upstream
 * project.
 *
 * A timer installed but never enabled. A script with no scheduler. A config
 * applier superseded but still present. Each looked like working machinery.
 *
 * So: after every build step, GREP FOR THE CALLER, NOT THE FILE. This function
 * is that grep, run by `sutra doctor` and by CI — every skill on disk must be
 * reachable from a registry, a command, or an explicit interactive marker.
 */
export function unwiredSkills(
  skillsRoot: string,
  referencedIds: ReadonlySet<string>,
): SkillRef[] {
  return listSkills(skillsRoot, { includeTrusted: true }).filter(
    (s) => !referencedIds.has(s.id) && !referencedIds.has(s.relPath),
  );
}

/** Total size of the skill tree, for `doctor`. */
export function skillsTreeBytes(skillsRoot: string): number {
  let total = 0;
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else {
        try { total += statSync(abs).size; } catch { /* ignore */ }
      }
    }
  };
  walk(skillsRoot);
  return total;
}
