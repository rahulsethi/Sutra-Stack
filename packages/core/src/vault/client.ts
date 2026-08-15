// SPDX-License-Identifier: Apache-2.0
/**
 * VaultClient — ported from `aatma/src/dimaag-client.ts`.
 *
 * Owns filesystem access to the user's vault: paths, counts, identity files,
 * the ISA (project) list. It deliberately knows nothing about tiers — the gate
 * sits ABOVE it, in `Brain`. Keeping the two apart means the gate has one
 * chokepoint rather than being sprinkled through I/O helpers.
 *
 * ── INVARIANT 1 · The user's repo is the truth ─────────────────────────────
 * Plain markdown plus git. Caches, indexes, graphs and exports are DISPOSABLE
 * and REBUILDABLE. There is no parallel store, no database, and no state that
 * cannot be reconstructed from the notes. That is why a user can inspect,
 * back up, and leave with everything they have.
 *
 * ── §9.9 · why the vault is not a submodule ────────────────────────────────
 * Upstream, the vault was a git submodule of the parent repo, and a stale
 * parent gitlink silently shipped an old vault. Worse, D25: `git submodule
 * update` ALWAYS aborts on a node whose vault working tree is dirty — which is
 * every node that runs the pipeline, because the pipeline is what dirties it —
 * and every remedy the internet offers for that message (`checkout -f`,
 * `reset --hard`, `clean -fd`) is a way to lose the user's captures.
 *
 * So: the vault is a separate, user-owned git repo that the CLI points at BY
 * PATH. Sutra never runs a submodule command against it.
 */

import { readFileSync, existsSync, readdirSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";

export interface InboxCounts {
  raw_inbox: number;
  vault_inbox: number;
  review_queue: number;
}

export interface FreshnessEntry {
  page: string;
  score: number | null;
}

export interface ContradictionStats {
  total: number;
  first_three: string[];
}

/** An Ideal State Artifact — a project's target state and progress toward it. */
export interface ProjectEntry {
  path: string;
  title: string;
  project: string;
  status: string;
  progress_pct: number;
  last_reviewed: string | null;
  /** Raw frontmatter value. The CALLER gates this; the client does not. */
  sensitivity: string;
}

export interface IdentityFiles {
  principal: string | null;
  persona: string | null;
  telos: string | null;
}

export class VaultClient {
  constructor(private readonly vaultRoot: string) {}

  root(): string {
    return this.vaultRoot;
  }

  exists(rel: string): boolean {
    return existsSync(join(this.vaultRoot, rel));
  }

  read(rel: string): string {
    return readFileSync(join(this.vaultRoot, rel), "utf8");
  }

  /**
   * Never throws — a missing directory is 0, not an exception.
   *
   * Dotfiles are excluded. `.gitkeep` is what makes an empty directory survive
   * a git clone, and counting it reported "1 raw intake file" on a vault that
   * had just been created and contained nothing. A status line that is wrong on
   * a fresh install is worse than one that is absent: it is the first number a
   * new user sees, and it teaches them the numbers cannot be trusted.
   */
  countFiles(rel: string, extFilter?: readonly string[]): number {
    const dir = join(this.vaultRoot, rel);
    if (!existsSync(dir)) return 0;
    try {
      return readdirSync(dir, { withFileTypes: true }).filter((e) => {
        if (!e.isFile()) return false;
        if (e.name.startsWith(".")) return false;
        if (!extFilter) return true;
        return extFilter.some((x) => e.name.endsWith(x));
      }).length;
    } catch {
      return 0;
    }
  }

  inboxCounts(): InboxCounts {
    return {
      raw_inbox: this.countFiles("raw/inbox"),
      vault_inbox: this.countFiles("vault/00-inbox", [".md"]),
      review_queue: this.countFiles("compiled/review-queue", [".md"]),
    };
  }

  contradictions(): ContradictionStats {
    const path = "compiled/contradictions/_queue.md";
    if (!this.exists(path)) return { total: 0, first_three: [] };
    const lines = this.read(path)
      .split(/\r?\n/)
      .filter((l) => l.trim().startsWith("- ") || l.trim().startsWith("* "));
    return {
      total: lines.length,
      first_three: lines.slice(0, 3).map((l) => l.replace(/^[\s\-*]+/, "")),
    };
  }

  /**
   * Freshness scores, worst first.
   *
   * D21 — the score these rows carry must be a CAPTURE RATIO, not "did an LLM
   * run". The upstream rubric banded 520 of 595 pages "healthy" and was, to
   * within five pages, a restatement of `synthesis_mode == hosted`; 164 of
   * those "healthy" pages had been clipped to 6,000 characters of their source.
   * See `quality/capture-ratio.ts` for the band this consumes.
   */
  freshness(topN = 5): FreshnessEntry[] {
    const csv = "state/checks/freshness-history.csv";
    if (!this.exists(csv)) return [];
    const rows = this.read(csv).split(/\r?\n/).slice(1).filter(Boolean);
    const latest = new Map<string, number>();
    for (const row of rows) {
      const cells = row.split(",");
      if (cells.length < 3) continue;
      const page = cells[1]?.trim() ?? "";
      const score = Number(cells[2]?.trim() ?? "");
      if (!page || Number.isNaN(score)) continue;
      latest.set(page, score);
    }
    return [...latest.entries()]
      .map(([page, score]) => ({ page, score }))
      .sort((a, b) => (a.score ?? 999) - (b.score ?? 999))
      .slice(0, topN);
  }

  listProjects(): ProjectEntry[] {
    const projectsDir = join(this.vaultRoot, "vault/02-projects");
    if (!existsSync(projectsDir)) return [];
    const out: ProjectEntry[] = [];
    let entries: Dirent[];
    try {
      entries = readdirSync(projectsDir, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const isaPath = join(projectsDir, e.name, "isa.md");
      if (!existsSync(isaPath)) continue;
      try {
        const file = matter(readFileSync(isaPath, "utf8"));
        const data = file.data as Record<string, unknown>;
        if (data["type"] !== "IdealStateArtifact") continue;
        out.push({
          path: isaPath,
          title: String(data["title"] ?? e.name),
          project: e.name,
          status: String(data["status"] ?? "active"),
          progress_pct: Number(data["progress_pct"] ?? 0),
          last_reviewed: data["last_reviewed"] ? String(data["last_reviewed"]) : null,
          // Projects default to PRIVATE. The caller gates against the ceiling.
          sensitivity: String(data["sensitivity"] ?? "review_required"),
        });
      } catch {
        /* an unparseable ISA is skipped, not fatal */
      }
    }
    return out.filter((i) => i.status === "active");
  }

  /**
   * Raw identity files, UNGATED. Callers must use `Brain.identityBundle()`,
   * which applies the per-file gate. This method exists for the local CLI,
   * where the ceiling is `local_only` and no model is in the loop.
   */
  identityFiles(): IdentityFiles {
    const tryRead = (rel: string): string | null => {
      const p = join(this.vaultRoot, "vault/11-identity", rel);
      if (!existsSync(p)) return null;
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    };
    return {
      principal: tryRead("principal.md"),
      persona: tryRead("persona.md"),
      telos: tryRead("telos.md"),
    };
  }

  /**
   * When the pipeline last produced something.
   *
   * D10/I1 — a run that STARTS and never ENDS is the loudest possible signal
   * and sat unread in the logs for 26 days. `run/outcome.ts` writes both
   * timestamps; this reads the resulting marker.
   */
  lastRun(): { iso: string | null; relPath: string | null } {
    const dir = join(this.vaultRoot, "state/checks");
    const marker = join(dir, "last-run.json");
    if (existsSync(marker)) {
      try {
        const j = JSON.parse(readFileSync(marker, "utf8")) as { ended_at?: string; started_at?: string };
        const iso = j.ended_at ?? j.started_at ?? null;
        if (iso) return { iso, relPath: "state/checks/last-run.json" };
      } catch {
        /* fall through to mtime */
      }
    }
    try {
      return { iso: new Date(statSync(marker).mtimeMs).toISOString(), relPath: "state/checks/last-run.json" };
    } catch {
      return { iso: null, relPath: null };
    }
  }
}
