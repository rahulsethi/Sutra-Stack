// SPDX-License-Identifier: Apache-2.0
/**
 * HERMES · THE SUTRA MCP SERVER. The integration surface every harness speaks
 * to, and the outermost place AATMA's gate is applied.
 *
 * Newline-delimited JSON-RPC 2.0 over stdio. The protocol is implemented
 * directly rather than through an SDK, which is a deliberate constraint: this
 * package has ZERO external dependencies, so a user auditing the thing that
 * decides what their AI can see reads ~700 lines and nothing else. A supply
 * chain is a poor foundation for a trust claim.
 *
 * stdout carries ONLY protocol messages. Every log line goes to stderr — a
 * single stray `console.log` corrupts the stream and the harness reports a
 * confusing parse error rather than the actual problem.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * INVARIANT 2 · THE GATE IS SERVER-SIDE AND THE MODEL CANNOT LIFT IT
 * ══════════════════════════════════════════════════════════════════════════
 * `SUTRA_MCP_EXPOSURE` is read ONCE, in `createDispatcher`, BEFORE the first
 * request is served. It is then captured in a `Brain` whose `exposure` is
 * readonly, and no tool handler receives it, reads it, or can change it.
 *
 * NO TOOL TAKES A TIER, A CEILING, AN EXPOSURE, OR AN OVERRIDE AS AN ARGUMENT.
 * `packages/mcp/src/server.test.ts` — "INVARIANT 2 · NO tool accepts a ceiling,
 * tier, exposure or override argument" — walks every published `inputSchema`
 * and fails the build if one ever appears. That test exists
 * because this is the property most likely to be eroded by a well-meaning
 * feature request — "could the tool just take an optional scope?" — and the
 * answer has to be structurally no rather than culturally no.
 *
 * Every tool description that touches exposure says so explicitly, so a model
 * reading the tool list learns it should not try.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * §9.2 · SILENT HARNESS-VERSION BREAKAGE
 * ══════════════════════════════════════════════════════════════════════════
 * A harness upgrade once stopped reading the config block that registered this
 * server. Applying the old config left the tool list EMPTY, and "the gated read
 * path would have been dead unnoticed."
 *
 * So the ready line on stderr states the TOOL COUNT AND THE CEILING, and
 * `sutra doctor --harness X` asserts both. File existence proves nothing.
 */

import { createInterface } from "node:readline";
import {
  loadConfig,
  ceilingFromEnv,
  VaultClient,
  Brain,
  TIER_DISPLAY,
  coerceTier,
  writeCapture,
  writeAllowed,
  semanticSearch,
  hybridSearch,
  getGraph,
  expand,
  extractSection,
  ask,
  listSkills,
  getSkill,
  loadRedactionMap,
  redactText,
  auditLog,
  auditGateBlock,
  type SutraConfig,
  type Tier,
  type RedactionEntry,
} from "@sutra/aatma-core";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "sutra", version: "1.0.0" };

interface RpcMessage {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

type TextContent = { type: "text"; text: string };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnlyHint?: boolean;
}

interface Tool {
  def: ToolDef;
  handler: (args: Record<string, unknown>) => TextContent[] | Promise<TextContent[]>;
}

const NO_INPUT = { type: "object", properties: {}, additionalProperties: false };
const text = (s: string): TextContent[] => [{ type: "text", text: s }];
const disp = (t: unknown): string => TIER_DISPLAY[coerceTier(t)];

/**
 * The sentence appended to every tool that touches the gate. Stated to the
 * model in its own tool list, because a model that understands the constraint
 * stops trying to work around it and starts telling the user what to do instead
 * — which is the behaviour we actually want.
 */
const CEILING_NOTE =
  " The exposure ceiling is fixed by the server at startup from its environment and CANNOT be " +
  "changed by any argument to this or any other tool. Withheld items are counted, never returned. " +
  "If something you need is withheld, say so and suggest `sutra review` — do not attempt a workaround.";

export function buildTools(
  cfg: SutraConfig,
  vc: VaultClient,
  brain: Brain,
  redactMap: RedactionEntry[],
): Tool[] {
  const vaultRoot = vc.root();
  const installRoot = cfg.installRoot.path;

  /**
   * The egress wrapper. Aliasing is applied to OUTBOUND TEXT ONLY — search and
   * matching always run over the real names, so redaction can never change
   * which notes are found, only how they read on the way out.
   */
  const rx = (s: string): string => redactText(s, redactMap).text;

  const surface = process.env["SUTRA_MCP_SURFACE"] ?? "unknown";

  /** Record a refusal. Counts and paths; never content. */
  const noteWithheld = (tool: string, what: string): void => {
    auditGateBlock(vaultRoot, {
      note: what,
      source: "vault",
      destination: `mcp:${surface}`,
      reason: `withheld at ceiling ${brain.exposure}`,
    });
    auditLog(vaultRoot, { kind: "gate.withheld", message: `${tool}: ${what}`, surface });
  };

  return [
    // ── 1 ────────────────────────────────────────────────────────────────
    {
      def: {
        name: "sutra_whoami",
        description:
          "Load the user's identity bundle — Principal (who they are), persona (how their assistant " +
          "should sound), and TELOS (what they are trying to do). Call this at the start of " +
          "substantive work. Returns only content cleared by the sensitivity gate; withheld files " +
          "are named but not shown." + CEILING_NOTE,
        inputSchema: NO_INPUT,
        readOnlyHint: true,
      },
      handler: () => {
        const b = brain.identityBundle();
        const parts: string[] = [];
        if (b.principal) parts.push(`## Principal\n\n${rx(b.principal)}`);
        if (b.persona) parts.push(`## Assistant persona\n\n${rx(b.persona)}`);
        if (b.telos) parts.push(`## TELOS\n\n${rx(b.telos)}`);
        if (parts.length === 0) {
          parts.push(
            "No identity content is cleared for this client.\n\n" +
            "This is normal on a new vault. Either the identity notes have not been written yet " +
            "(`sutra init` walks the user through it), or they are tiered above this client's " +
            "ceiling — which is the correct default for personal identity material.",
          );
        }
        if (b.withheld.length > 0) parts.push(`\n_Withheld by the sensitivity gate: ${b.withheld.join(", ")}._`);
        return text(parts.join("\n\n"));
      },
    },

    // ── 2 ────────────────────────────────────────────────────────────────
    {
      def: {
        name: "sutra_search",
        description:
          "Keyword search the user's durable notes. Returns title, path and a snippet per hit. " +
          "Use this before answering any question about the user or their work. Pass hybrid:true " +
          "for fused BM25 + vector ranking (Reciprocal-Rank Fusion) — better recall on paraphrases, " +
          "identical gating. Hybrid degrades to BM25-only when no embedding index exists, and says " +
          "so." + CEILING_NOTE,
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search terms." },
            limit: { type: "number", description: "Max hits (default 10)." },
            hybrid: { type: "boolean", description: "Fuse BM25 with the local vector ranking. Default false." },
          },
          required: ["query"],
          additionalProperties: false,
        },
        readOnlyHint: true,
      },
      handler: (args) => {
        const query = String(args["query"] ?? "");
        const limit = Number(args["limit"] ?? 10);

        if (args["hybrid"] === true) {
          const r = hybridSearch(vaultRoot, installRoot, brain, query, limit);
          const lines = r.hits.map(
            (h) => `- **${rx(h.title)}** \`${h.relPath}\` (${disp(h.sensitivity)}, via ${h.via})`,
          );
          const foot = [
            `\n_${r.hits.length} shown · ${r.scanned} scanned · ${r.withheld} withheld by the gate · retrieval: ${r.retrieval}._`,
            ...r.degraded.map((d) => `_Degraded — ${d}_`),
          ];
          if (r.withheld > 0) noteWithheld("sutra_search", `${r.withheld} note(s) for "${query}"`);
          return text((lines.length ? lines.join("\n") : "_No visible note matched._") + "\n" + foot.join("\n"));
        }

        const r = brain.search(query, limit);
        const lines = r.hits.map(
          (h) => `- **${rx(h.title)}** \`${h.relPath}\` (${disp(h.sensitivity)})\n  ${rx(h.snippet)}`,
        );
        if (r.withheld > 0) noteWithheld("sutra_search", `${r.withheld} note(s) for "${query}"`);
        return text(
          (lines.length ? lines.join("\n") : "_No visible note matched._") +
          `\n\n_${r.hits.length} shown · ${r.scanned} scanned · ${r.withheld} withheld by the gate._`,
        );
      },
    },

    // ── 3 ────────────────────────────────────────────────────────────────
    {
      def: {
        name: "sutra_semantic_search",
        description:
          "Vector search over the local embedding index — finds notes by MEANING rather than by " +
          "shared words. Use when keyword search returns nothing but the concept should exist. " +
          "Requires `sutra refresh-index` to have been run; if the index is absent it says so and " +
          "you should fall back to sutra_search, which needs no index." + CEILING_NOTE,
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "A natural-language description of what you are looking for." },
            limit: { type: "number", description: "Max hits (default 10)." },
          },
          required: ["query"],
          additionalProperties: false,
        },
        readOnlyHint: true,
      },
      handler: (args) => {
        const r = semanticSearch(
          vaultRoot, installRoot, String(args["query"] ?? ""), brain.exposure, Number(args["limit"] ?? 10),
        );
        if (r.status !== "ok") {
          // D16 — degradation is REPORTED with its remedy, never silently empty.
          return text(`_${r.status === "not_built" ? "No embedding index" : "Query could not be embedded"}._\n\n${r.message}`);
        }
        if (r.withheld > 0) noteWithheld("sutra_semantic_search", `${r.withheld} indexed note(s)`);
        const lines = r.hits.map(
          (h) => `- **${rx(h.title)}** \`${h.relPath}\` (${disp(h.sensitivity)}, score ${h.score.toFixed(3)})`,
        );
        return text(
          (lines.length ? lines.join("\n") : "_No visible note matched._") +
          `\n\n_model: ${r.model} · ${r.scanned} indexed · ${r.withheld} withheld by the gate._`,
        );
      },
    },

    // ── 4 ────────────────────────────────────────────────────────────────
    {
      def: {
        name: "sutra_ask",
        description:
          "Ask the vault a question and get a CITED answer assembled from the user's own notes. " +
          "Prefer this over search when you want an answer rather than a list. Works with no API " +
          "key and no network: without a model it returns the cited source passages themselves, " +
          "which is a real answer, not a failure." + CEILING_NOTE,
        inputSchema: {
          type: "object",
          properties: {
            question: { type: "string", description: "The question, in natural language." },
            k: { type: "number", description: "How many sources to consider (default 6)." },
          },
          required: ["question"],
          additionalProperties: false,
        },
        readOnlyHint: true,
      },
      handler: (args) => {
        const r = ask(vaultRoot, installRoot, brain, String(args["question"] ?? ""), {
          k: Number(args["k"] ?? 6),
        });
        const parts: string[] = [];
        if (r.answer) parts.push(rx(r.answer));
        parts.push(rx(r.context_block));
        if (r.sources.length) {
          parts.push(
            "\n**Sources**\n" +
            r.sources.map((s) => `${s.n}. \`${s.relPath}\` — ${rx(s.title)} (${s.tier}, via ${s.via})`).join("\n"),
          );
        }
        parts.push(
          `\n_Ceiling: ${r.exposure_display} · retrieval: ${r.retrieval_mode} · synthesis: ${r.synthesis_mode} · ` +
          `${r.withheld} withheld by the gate._`,
        );
        // "Degradation is allowed. Silent degradation is not."
        for (const d of r.degraded) parts.push(`_Note — ${d}_`);
        if (r.withheld > 0) noteWithheld("sutra_ask", `${r.withheld} note(s)`);
        return text(parts.join("\n\n"));
      },
    },

    // ── 5 ────────────────────────────────────────────────────────────────
    {
      def: {
        name: "sutra_get_note",
        description:
          "Read one note in full, by path, frontmatter id, or filename. Returns `withheld` if the " +
          "note exists but is above this client's ceiling — that is a real answer, and it queues a " +
          "reviewable exposure request the user can approve. Do not retry a withheld read." + CEILING_NOTE,
        inputSchema: {
          type: "object",
          properties: { id: { type: "string", description: "Relative path, frontmatter id, or filename." } },
          required: ["id"],
          additionalProperties: false,
        },
        readOnlyHint: true,
      },
      handler: (args) => {
        const id = String(args["id"] ?? "");
        const r = brain.getNote(id);
        if (r.status === "not_found") return text(`_No note matches \`${id}\`._`);
        if (r.status === "withheld") {
          noteWithheld("sutra_get_note", id);
          return text(
            `_\`${id}\` exists but is withheld at this client's ceiling (${TIER_DISPLAY[brain.exposure]})._\n\n` +
            "An exposure request has been queued. The user can review it with `sutra review`. " +
            "Tell them that; do not attempt another route to the content.",
          );
        }
        return text(
          `# ${rx(r.note.title)}\n\n_\`${r.note.relPath}\` · type: ${r.note.type} · tier: ${disp(r.note.sensitivity)}_\n\n` +
          rx(r.note.body),
        );
      },
    },

    // ── 6 ────────────────────────────────────────────────────────────────
    {
      def: {
        name: "sutra_read_section",
        description:
          "Read ONE section of a note, by heading text or anchor slug. Use this instead of " +
          "sutra_get_note when you need one part of a long document — it is the same gate, less " +
          "context. On a miss it returns the note's headings so you can retry precisely.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Relative path, frontmatter id, or filename." },
            section: { type: "string", description: "Heading text or anchor slug." },
          },
          required: ["id", "section"],
          additionalProperties: false,
        },
        readOnlyHint: true,
      },
      handler: (args) => {
        const id = String(args["id"] ?? "");
        const note = brain.getNote(id);
        if (note.status === "not_found") return text(`_No note matches \`${id}\`._`);
        if (note.status === "withheld") {
          noteWithheld("sutra_read_section", id);
          return text(`_\`${id}\` is withheld at this client's ceiling. An exposure request has been queued._`);
        }
        const sec = extractSection(note.note.body, String(args["section"] ?? ""));
        if (sec.status === "not_found") {
          return text(
            `_No section "${String(args["section"])}" in \`${id}\`._\n\nAvailable headings:\n` +
            (sec.headings.length
              ? sec.headings.map((h) => `- ${"  ".repeat(h.level - 1)}${rx(h.text)}`).join("\n")
              : "_(the note has no headings)_"),
          );
        }
        return text(`_From \`${note.note.relPath}\` (${disp(note.note.sensitivity)})_\n\n${rx(sec.section)}`);
      },
    },

    // ── 7 ────────────────────────────────────────────────────────────────
    {
      def: {
        name: "sutra_list_projects",
        description:
          "List the user's active projects and their target states, with progress. Use to orient " +
          "on what they are working on before proposing anything." + CEILING_NOTE,
        inputSchema: NO_INPUT,
        readOnlyHint: true,
      },
      handler: () => {
        const all = vc.listProjects();
        const visible = all.filter(
          (p) => brain.getNote(p.path.split(/[\\/]/).slice(-2).join("/")).status === "ok" ||
                 coerceTier(p.sensitivity) === "hosted_allowed",
        );
        const shown = visible.length ? visible : all.filter((p) => coerceTier(p.sensitivity) === "hosted_allowed");
        const withheld = all.length - shown.length;
        if (all.length === 0) return text("_No projects yet._");
        return text(
          shown
            .map((p) => `- **${rx(p.title)}** (${p.project}) — ${p.progress_pct}% · ${disp(p.sensitivity)}`)
            .join("\n") +
          (withheld > 0 ? `\n\n_${withheld} project(s) withheld by the gate._` : ""),
        );
      },
    },

    // ── 8 ────────────────────────────────────────────────────────────────
    {
      def: {
        name: "sutra_status",
        description:
          "Pipeline and vault health: inbox depth, last run, contradictions, freshness. Use when " +
          "the user asks whether their system is working, or before trusting a stale answer. " +
          "Reports what ran, what was skipped, and WHY — a degraded run says degraded.",
        inputSchema: NO_INPUT,
        readOnlyHint: true,
      },
      handler: () => {
        const inbox = vc.inboxCounts();
        const last = vc.lastRun();
        const contra = vc.contradictions();
        const gate = brain.gateInspect(0);
        return text(
          [
            `**Vault** \`${vaultRoot}\``,
            `- notes scanned: ${gate.scanned} · visible at this ceiling (${gate.ceiling_display}): ${gate.visible}`,
            `- withheld — private ${gate.withheld_by_tier.private}, secret ${gate.withheld_by_tier.secret}, do_not_learn ${gate.withheld_by_tier.do_not_learn}`,
            `- inbox: ${inbox.vault_inbox} note(s), raw intake: ${inbox.raw_inbox}, review queue: ${inbox.review_queue}`,
            `- last pipeline run: ${last.iso ?? "never"}`,
            `- open contradictions: ${contra.total}`,
            ...(cfg.warnings.length ? ["", "**Warnings**", ...cfg.warnings.map((w) => `- ${w}`)] : []),
          ].join("\n"),
        );
      },
    },

    // ── 9 ────────────────────────────────────────────────────────────────
    {
      def: {
        name: "sutra_get_graph",
        description:
          "The knowledge graph's most-connected visible nodes — the shape of what the user knows. " +
          "Use to find hubs worth exploring, then sutra_expand to walk out from one." + CEILING_NOTE,
        inputSchema: NO_INPUT,
        readOnlyHint: true,
      },
      handler: () => {
        const r = getGraph(vaultRoot, brain.exposure);
        if (r.status === "not_built") return text(`_No graph yet._\n\n${r.message}`);
        if (r.withheld > 0) noteWithheld("sutra_get_graph", `${r.withheld} node(s)`);
        return text(
          r.nodes.map((n) => `- **${rx(n.label)}** (${n.type}, degree ${n.degree})${n.path ? ` \`${n.path}\`` : ""}`).join("\n") +
          `\n\n_${r.nodes.length} of ${r.total_nodes} nodes · ${r.edges} edges · ${r.withheld} withheld by the gate._`,
        );
      },
    },

    // ── 10 ───────────────────────────────────────────────────────────────
    {
      def: {
        name: "sutra_expand",
        description:
          "One-hop neighbourhood of a graph node. Both the centre AND each neighbour are gated " +
          "independently — adjacency to a visible node grants nothing." + CEILING_NOTE,
        inputSchema: {
          type: "object",
          properties: { node: { type: "string", description: "Node id, label, or note path." } },
          required: ["node"],
          additionalProperties: false,
        },
        readOnlyHint: true,
      },
      handler: (args) => {
        const r = expand(vaultRoot, brain.exposure, String(args["node"] ?? ""));
        if (r.status !== "ok") return text(`_${r.message}_`);
        if (r.withheld > 0) noteWithheld("sutra_expand", `${r.withheld} neighbour(s)`);
        return text(
          `**${rx(r.center.label)}** (${r.center.type}, degree ${r.center.degree})\n\n` +
          (r.neighbours.length
            ? r.neighbours.map((n) => `- ${rx(n.label)} (${n.type}, degree ${n.degree})`).join("\n")
            : "_No visible neighbours._") +
          (r.withheld > 0 ? `\n\n_${r.withheld} neighbour(s) withheld by the gate._` : ""),
        );
      },
    },

    // ── 11 · THE TRUST DEMO ──────────────────────────────────────────────
    {
      def: {
        name: "sutra_can_you_see",
        description:
          "Report exactly what this client can and cannot see: the ceiling, how many notes are " +
          "visible, and how many are withheld — broken down by tier. Call this when the user asks " +
          "what you have access to, or when you want to state your limits honestly rather than " +
          "guess at them. It is the one tool that makes the gate checkable.",
        inputSchema: NO_INPUT,
        readOnlyHint: true,
      },
      handler: () => {
        const g = brain.gateInspect(8);
        const w = g.withheld_by_tier;
        return text(
          [
            `**Ceiling: ${g.ceiling_display}** (\`${g.ceiling}\`), fixed by the server at startup.`,
            "",
            `- **Visible: ${g.visible}** of ${g.scanned} notes`,
            `- **Withheld — private: ${w.private}, secret: ${w.secret}, do_not_learn: ${w.do_not_learn}**`,
            "",
            g.sample.length ? `Sample of what IS visible:\n${g.sample.map((s) => `- ${rx(s)}`).join("\n")}` : "",
            "",
            "_Secret-tier content and anything marked `do_not_learn` never reaches any model — not " +
            "under an override, not under a flag, not at any ceiling. Private content can be " +
            "released per-note by the user via `sutra review`._",
          ].filter(Boolean).join("\n"),
        );
      },
    },

    // ── 12 ───────────────────────────────────────────────────────────────
    {
      def: {
        name: "sutra_list_skills",
        description:
          "List the user's runtime skills — reusable procedures they have written down. Use to " +
          "check whether an established procedure exists before improvising one. Only PUBLIC " +
          "skills are listed; the governance surface is never exposed.",
        inputSchema: NO_INPUT,
        readOnlyHint: true,
      },
      handler: () => {
        const skills = listSkills(cfg.skillsRoot.path); // includeTrusted defaults to false
        if (!skills.length) return text("_No public skills installed._");
        return text(skills.map((s) => `- **${s.id}** — ${s.description || "(no description)"}`).join("\n"));
      },
    },

    // ── 13 ───────────────────────────────────────────────────────────────
    {
      def: {
        name: "sutra_get_skill",
        description:
          "Read one public skill in full. Follow its instructions rather than improvising when it " +
          "covers the task at hand.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string", description: "The skill id from sutra_list_skills." } },
          required: ["id"],
          additionalProperties: false,
        },
        readOnlyHint: true,
      },
      handler: (args) => {
        const r = getSkill(cfg.skillsRoot.path, String(args["id"] ?? ""));
        if (r.status === "not_found") return text(`_No public skill "${String(args["id"])}"._`);
        return text(`# ${r.skill.name}\n\n_${r.skill.description}_\n\n${r.skill.body}`);
      },
    },

    // ── 14 · THE ONLY WRITE ──────────────────────────────────────────────
    {
      def: {
        name: "sutra_capture",
        description:
          "Save something into the user's inbox for later review. THE ONLY WRITE this server can " +
          "perform. It creates a new inbox note — it never edits, overwrites, or promotes anything, " +
          "and it cannot create public content: a capture is floored to `private` regardless of " +
          "what is requested. A stricter request (`secret`) is honoured. Off unless the server was " +
          "registered with SUTRA_MCP_ALLOW_WRITE=1. Use it when the user says something worth " +
          "keeping; tell them where it landed.",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string", description: "The content to capture." },
            title: { type: "string", description: "Optional title." },
            sensitivity: {
              type: "string",
              enum: ["private", "secret"],
              description:
                "Floor is `private`; `public` is not accepted and any more-permissive value is " +
                "clamped up. `secret` means it never reaches any model again, including you.",
            },
            tags: { type: "array", items: { type: "string" }, description: "Optional tags." },
          },
          required: ["text"],
          additionalProperties: false,
        },
      },
      handler: (args) => {
        const gate = writeAllowed();
        if (!gate.allowed) {
          auditLog(vaultRoot, { kind: "capture.refused", message: gate.reason, surface });
          return text(`_Write-back is disabled._\n\n${gate.reason}`);
        }
        const res = writeCapture(vaultRoot, {
          text: String(args["text"] ?? ""),
          ...(args["title"] !== undefined ? { title: String(args["title"]) } : {}),
          sensitivity: args["sensitivity"],
          tags: args["tags"],
          source: `mcp:${surface}`,
        });
        auditLog(vaultRoot, {
          kind: "capture.write",
          message: res.relPath,
          tier: res.tier,
          clamped: res.clamped,
          surface,
        });
        return text(
          `Captured to \`${res.relPath}\` at tier **${res.display}**` +
          (res.clamped ? " (clamped up from the requested tier — a capture can never be public)" : "") +
          ".\n\nIt is queued for review and will flow through the normal ingest → review → compile " +
          "pipeline. It is not yet a durable page.",
        );
      },
    },
  ];
}

function ok(id: RpcMessage["id"], result: unknown): object {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id: RpcMessage["id"], code: number, message: string): object {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export interface Dispatcher {
  handle: (msg: RpcMessage) => Promise<object | null>;
  brain: Brain;
  tools: Tool[];
  exposure: Tier;
}

/**
 * Build the dispatcher.
 *
 * THE CEILING IS RESOLVED HERE, ONCE, AND NOWHERE ELSE. Everything downstream
 * receives a `Brain` that already has it.
 */
export function createDispatcher(cfg: SutraConfig = loadConfig()): Dispatcher {
  const vc = new VaultClient(cfg.vaultRoot.path);
  const exposure = ceilingFromEnv();
  const brain = new Brain(vc, exposure, cfg.walkRoots);

  // Loaded once per process: every egress from this server aliases configured
  // third-party names before text leaves it. Ships empty (see gate/redact.ts).
  const redactMap = loadRedactionMap(vc.root());
  const tools = buildTools(cfg, vc, brain, redactMap);

  async function handle(msg: RpcMessage): Promise<object | null> {
    const { id, method, params } = msg;
    switch (method) {
      case "initialize":
        return ok(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });
      case "tools/list":
        return ok(id, { tools: tools.map((t) => t.def) });
      case "tools/call": {
        const name = String(params?.["name"] ?? "");
        const args = (params?.["arguments"] as Record<string, unknown>) ?? {};
        const tool = tools.find((t) => t.def.name === name);
        if (!tool) return rpcError(id, -32602, `unknown tool: ${name}`);
        try {
          return ok(id, { content: await tool.handler(args) });
        } catch (e) {
          // A tool error is a RESULT with isError, not a protocol error — the
          // model should see it and adapt, not have the transport report a fault.
          return ok(id, {
            content: text(`error: ${e instanceof Error ? e.message : String(e)}`),
            isError: true,
          });
        }
      }
      case "ping":
        return ok(id, {});
      default:
        if (method && method.startsWith("notifications/")) return null;
        return rpcError(id, -32601, `method not found: ${method}`);
    }
  }

  return { handle, brain, tools, exposure };
}

/** Run the stdio server. stdout is protocol-only; everything else is stderr. */
export async function runStdioServer(cfg: SutraConfig = loadConfig()): Promise<number> {
  const { handle, exposure, tools } = createDispatcher(cfg);

  // §9.2 — the ready line states TOOL COUNT AND CEILING, because those are the
  // two things `doctor` asserts and a silent harness-version break shows up as
  // "0 tools" here rather than as a mystery three weeks later.
  process.stderr.write(
    `sutra-mcp: ready — ${tools.length} tools at ceiling "${TIER_DISPLAY[exposure]}" (${exposure})\n`,
  );
  for (const w of cfg.warnings) process.stderr.write(`sutra-mcp: warning — ${w}\n`);

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg: RpcMessage;
    try {
      msg = JSON.parse(trimmed) as RpcMessage;
    } catch {
      continue; // a malformed line is ignored, never echoed back
    }
    const resp = await handle(msg);
    if (resp) process.stdout.write(JSON.stringify(resp) + "\n");
  }
  return 0;
}
