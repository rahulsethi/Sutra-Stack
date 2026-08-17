// SPDX-License-Identifier: Apache-2.0
/**
 * DIMAAG · THE GATED CORPUS. The knowledge substrate a model is allowed to see,
 * with AATMA's gate applied on every read.
 *
 * Every read path in the product goes through this class, and `visible()` is
 * the second of the four secret-floor enforcement points. If a note is not
 * returned by `allNotes()` → `visible()`, no tool, no answer, no search, and no
 * context block can contain it.
 *
 * The single most important property, and the one the tests hammer: THE
 * WITHHELD COUNT IS RETURNED, THE WITHHELD CONTENT IS NOT. A caller always
 * learns that something was withheld and never learns what. That is what makes
 * `sutra gate` an honest answer rather than a claim:
 *
 *     Ceiling: public. Visible: 812.
 *     Withheld — private: 401, secret: 37, do_not_learn: 12.
 */

import { join, relative, sep } from "node:path";
import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import matter from "gray-matter";
import { type Tier, coerceTier, isDoNotLearn, TIER_DISPLAY } from "../gate/tiers.js";
import { sensitivityGuard } from "../gate/guard.js";
import { loadPolicy, hasLivePromotion, appendRequest, type ExposurePolicy } from "../gate/exposure.js";
import { DEFAULT_WALK_ROOTS, EXCLUDED_DIR_NAMES } from "../config.js";
import type { VaultClient } from "./client.js";

export interface NoteRef {
  relPath: string;
  title: string;
  type: string;
  sensitivity: Tier;
}
export interface NoteHit extends NoteRef {
  snippet: string;
}
export interface NoteBody extends NoteRef {
  body: string;
}
export interface CorpusNote extends NoteRef {
  body: string;
  /** frontmatter updated/created/date, for a recency tie-break. */
  updated?: string;
}
export interface IdentityBundle {
  principal: string | null;
  persona: string | null;
  telos: string | null;
  /** Names of files the gate withheld — the names, never the content. */
  withheld: string[];
}

export interface GateReport {
  ceiling: Tier;
  ceiling_display: string;
  visible: number;
  withheld_by_tier: { private: number; secret: number; do_not_learn: number };
  /** Titles of a few VISIBLE notes, so the answer is checkable, not just asserted. */
  sample: string[];
  scanned: number;
}

interface ParsedNote {
  relPath: string;
  data: Record<string, unknown>;
  body: string;
}

export class Brain {
  private readonly roots: string[];

  constructor(
    private readonly vc: Pick<VaultClient, "root">,
    /**
     * THE EXPOSURE CEILING.
     *
     * INVARIANT 2: this is read from the environment at server startup and is
     * never accepted as a tool argument. It is `readonly` here and set once, in
     * the constructor, so there is no setter a request handler could reach.
     */
    public readonly exposure: Tier,
    roots?: readonly string[],
  ) {
    this.roots = roots ? [...roots] : [...DEFAULT_WALK_ROOTS];
  }

  /**
   * Fresh policy read per operation. The file is small, and reading it fresh
   * means a promotion granted while the server runs takes effect immediately —
   * and, more importantly, a REVOKED promotion stops working immediately. A
   * cached allowlist is a stale allowlist.
   */
  private policy(): ExposurePolicy {
    return loadPolicy(this.vc.root());
  }

  /**
   * THE VISIBILITY RULE. Four lines, and the whole product rests on them.
   *
   * A note is visible iff:
   *   - it is NOT marked `do_not_learn`, AND
   *   - the gate allows it at this ceiling, OR a live promotion lifts it.
   *
   * `local_only` IS NEVER LIFTED. Not by a promotion, not by a flag, not by a
   * ceiling. It fails `sensitivityGuard` at every ceiling but `local_only`, and
   * the promotion branch below is reachable ONLY for `review_required`. That
   * `tier === "review_required"` check is the enforcement — a promotion naming
   * a secret note is silently inert, which is exactly what upstream's
   * `local_only is NEVER promotable` test asserts.
   */
  private visible(
    tier: Tier,
    dnl: boolean,
    relPath?: string,
    policy?: ExposurePolicy,
  ): boolean {
    if (dnl) return false;
    if (sensitivityGuard(tier, this.exposure).allowed) return true;
    if (tier === "review_required" && relPath) {
      const pol = policy ?? this.policy();
      if (hasLivePromotion(pol, relPath)) return true;
    }
    return false;
  }

  private titleFrom(data: Record<string, unknown>, body: string, fallback: string): string {
    const h = /^#\s+(.+)$/m.exec(body);
    if (h) return h[1]!.trim();
    if (data["title"]) return String(data["title"]);
    return fallback;
  }

  private *walkMdFiles(absDir: string): Generator<string> {
    let entries: Dirent[];
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = join(absDir, e.name);
      if (e.isDirectory()) {
        // Structure is not knowledge. `vault/config/` holds the conventions,
        // schemas and TEMPLATES — and a template cited as a source is a
        // confident, plausible, useless answer. See EXCLUDED_DIR_NAMES.
        if (EXCLUDED_DIR_NAMES.has(e.name)) continue;
        yield* this.walkMdFiles(abs);
      } else if (e.isFile() && e.name.endsWith(".md") && e.name !== ".gitkeep") {
        yield abs;
      }
    }
  }

  /**
   * Parse one note. Returns `null` on ANY failure.
   *
   * A note that cannot be parsed is EXCLUDED, not included with a default tier.
   * The difference matters: an unparseable file might be unparseable *because*
   * of what it contains, and "I could not read the frontmatter, so I will treat
   * it as public" is the worst possible resolution.
   */
  private parse(abs: string): ParsedNote | null {
    try {
      const file = matter(readFileSync(abs, "utf8"));
      return {
        relPath: relative(this.vc.root(), abs).split(sep).join("/"),
        data: file.data as Record<string, unknown>,
        body: file.content,
      };
    } catch {
      return null;
    }
  }

  /** Every parsed note under the walk roots. No gating applied yet. */
  private allNotes(): ParsedNote[] {
    const out: ParsedNote[] = [];
    for (const rel of this.roots) {
      const dir = join(this.vc.root(), rel);
      if (!existsSync(dir)) continue;
      for (const abs of this.walkMdFiles(dir)) {
        const p = this.parse(abs);
        if (p) out.push(p);
      }
    }
    return out;
  }

  private toRef(n: ParsedNote): NoteRef {
    const fallback = n.relPath.split("/").pop()!.replace(/\.md$/, "");
    return {
      relPath: n.relPath,
      title: this.titleFrom(n.data, n.body, fallback),
      type: String(n.data["type"] ?? "Untyped"),
      sensitivity: coerceTier(n.data["sensitivity"]),
    };
  }

  /**
   * Keyword search across VISIBLE notes.
   *
   * Per-TERM scoring, not whole-query substring: "Agentic Coding" matches any
   * note containing "agentic" and/or "coding" anywhere, ranked by how many
   * terms hit (title ×3, body ×1) — rather than only notes containing the exact
   * contiguous phrase. For vector recall use `semanticSearch`; this is the fast
   * lexical path with no model and no index.
   */
  search(query: string, limit = 10): { hits: NoteHit[]; scanned: number; withheld: number } {
    const q = query.trim().toLowerCase();
    const terms = q.split(/[^a-z0-9]+/i).filter((t) => t.length > 1);
    const scored: Array<NoteHit & { score: number }> = [];
    let scanned = 0;
    let withheld = 0;
    const pol = this.policy();

    for (const n of this.allNotes()) {
      scanned++;
      const tier = coerceTier(n.data["sensitivity"]);
      if (!this.visible(tier, isDoNotLearn(n.data), n.relPath, pol)) {
        withheld++;
        continue;
      }
      const ref = this.toRef(n);
      const title = ref.title.toLowerCase();
      const body = n.body.toLowerCase();
      let score = 0;
      if (terms.length === 0) {
        score = 1; // empty query → list everything visible
      } else {
        for (const t of terms) {
          if (title.includes(t)) score += 3;
          else if (body.includes(t)) score += 1;
        }
      }
      if (score === 0) continue;

      let at = -1;
      for (const t of terms) {
        const i = body.indexOf(t);
        if (i >= 0) { at = i; break; }
      }
      const start = at >= 0 ? Math.max(0, at - 60) : 0;
      const snippet = n.body.slice(start, start + 200).replace(/\s+/g, " ").trim();
      scored.push({ ...ref, snippet, score });
    }

    scored.sort((a, b) => b.score - a.score || a.relPath.localeCompare(b.relPath));
    const hits = scored.slice(0, limit).map(({ score: _score, ...h }) => h);
    return { hits, scanned, withheld };
  }

  /**
   * The full GATED corpus, for hybrid retrieval.
   *
   * Applies the IDENTICAL visibility gate as `search()` and `getNote()` — the
   * same `do_not_learn` exclusion, the same guard, the same promotions — so a
   * caller can never receive a note it could not already see through another
   * path. This is why retrieval is built on top of one gate rather than each
   * retrieval mode re-deriving its own: ROADMAP E1 counted six re-implementations
   * of one tier comparison upstream, and every divergence failed open in at
   * least one of them.
   */
  visibleCorpus(): { notes: CorpusNote[]; scanned: number; withheld: number } {
    const pol = this.policy();
    const notes: CorpusNote[] = [];
    let scanned = 0;
    let withheld = 0;

    for (const n of this.allNotes()) {
      scanned++;
      const tier = coerceTier(n.data["sensitivity"]);
      if (!this.visible(tier, isDoNotLearn(n.data), n.relPath, pol)) {
        withheld++;
        continue;
      }
      const ref = this.toRef(n);
      const updated = n.data["updated"] ?? n.data["created"] ?? n.data["date"];
      notes.push({
        ...ref,
        body: n.body,
        ...(updated != null ? { updated: String(updated) } : {}),
      });
    }
    return { notes, scanned, withheld };
  }

  /**
   * Fetch one note by relative path, frontmatter id, or filename.
   *
   * Three outcomes, deliberately distinguished: `ok`, `withheld`, `not_found`.
   * Collapsing the last two would be more "secure" in a naive sense and is
   * wrong — it would make a refusal indistinguishable from a typo, and the user
   * could never tell whether to fix their query or grant an exposure. The
   * withheld case leaves a REQUEST behind, which is the reviewable trail that
   * makes the refusal actionable.
   */
  getNote(
    idOrPath: string,
  ): { status: "ok"; note: NoteBody } | { status: "withheld" } | { status: "not_found" } {
    const needle = idOrPath.trim();
    let match: ParsedNote | null = null;
    let withheldMatch = false;

    for (const n of this.allNotes()) {
      const filename = n.relPath.split("/").pop()!.replace(/\.md$/, "");
      const id = String(n.data["id"] ?? "");
      const isMatch =
        n.relPath === needle ||
        n.relPath === needle.replace(/\\/g, "/") ||
        filename === needle ||
        (id !== "" && id === needle);
      if (!isMatch) continue;

      const tier = coerceTier(n.data["sensitivity"]);
      if (!this.visible(tier, isDoNotLearn(n.data), n.relPath)) {
        withheldMatch = true;
        continue;
      }
      match = n;
      break;
    }

    if (match) return { status: "ok", note: { ...this.toRef(match), body: match.body } };

    if (withheldMatch) {
      appendRequest(this.vc.root(), {
        id: `${new Date().toISOString().replace(/[:.]/g, "-")}-${needle.replace(/[^\w.-]/g, "_")}`,
        note: needle,
        scope: "hosted",
        surface_hint: process.env["SUTRA_MCP_SURFACE"] ?? undefined,
        context: "a gated client requested a withheld note",
        at: new Date().toISOString(),
        status: "pending",
      });
      return { status: "withheld" };
    }
    return { status: "not_found" };
  }

  /**
   * THE TRUST DEMO. `sutra gate` / `sutra_can_you_see`.
   *
   * One tool call that makes the gate legible: what the ceiling is, how much is
   * visible, exactly how much is withheld and under which rule. It is the
   * demonstration that sells the product, and it is also the thing that would
   * expose the product as a lie if the gate did not hold — which is why it
   * reports counts computed by the SAME `visible()` the real read paths use,
   * rather than a separate summary that could drift from it.
   */
  gateInspect(maxSample = 8): GateReport {
    let visible = 0;
    let withheldPrivate = 0;
    let withheldSecret = 0;
    let withheldDnl = 0;
    let scanned = 0;
    const sample: string[] = [];
    const pol = this.policy();

    for (const n of this.allNotes()) {
      scanned++;
      const tier = coerceTier(n.data["sensitivity"]);
      const dnl = isDoNotLearn(n.data);
      if (dnl) {
        withheldDnl++;
        continue;
      }
      if (this.visible(tier, false, n.relPath, pol)) {
        visible++;
        if (sample.length < maxSample) {
          sample.push(
            this.titleFrom(n.data, n.body, n.relPath.split("/").pop()!.replace(/\.md$/, "")),
          );
        }
      } else if (tier === "local_only") {
        withheldSecret++;
      } else {
        withheldPrivate++;
      }
    }

    return {
      ceiling: this.exposure,
      ceiling_display: TIER_DISPLAY[this.exposure],
      visible,
      withheld_by_tier: { private: withheldPrivate, secret: withheldSecret, do_not_learn: withheldDnl },
      sample,
      scanned,
    };
  }

  /** Identity bundle (Principal + persona + TELOS), gated PER FILE. */
  identityBundle(): IdentityBundle {
    const withheld: string[] = [];
    const tryGated = (rel: string, label: string): string | null => {
      const relPath = `vault/11-identity/${rel}`;
      const abs = join(this.vc.root(), relPath);
      if (!existsSync(abs)) return null;
      const p = this.parse(abs);
      if (!p) return null;
      const tier = coerceTier(p.data["sensitivity"]);
      if (!this.visible(tier, isDoNotLearn(p.data), relPath)) {
        // The NAME and the TIER, never the content.
        withheld.push(`${label} (${TIER_DISPLAY[tier]})`);
        appendRequest(this.vc.root(), {
          id: `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}`,
          note: relPath,
          scope: "hosted",
          surface_hint: process.env["SUTRA_MCP_SURFACE"] ?? undefined,
          context: `identity bundle: ${label} requested`,
          at: new Date().toISOString(),
          status: "pending",
        });
        return null;
      }
      return p.body.trim();
    };

    return {
      principal: tryGated("principal.md", "principal"),
      persona: tryGated("persona.md", "persona"),
      telos: tryGated("telos.md", "telos"),
      withheld,
    };
  }
}
