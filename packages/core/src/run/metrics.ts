// SPDX-License-Identifier: Apache-2.0
/**
 * THE TIME SERIES — the fix for D12 and D35.
 *
 * ── D12 · No time series for anything ──────────────────────────────────────
 * Every state file was overwritten each run. Answering "is my graph growing?"
 * required hand-parsing 90 snapshots — and produced the WRONG answer.
 *
 * It hid because a point-in-time value always looks fine. The absence of
 * history is not visible in any artifact; you discover it at the moment you
 * need to answer a trend question, which is the moment you are already in an
 * incident.
 *
 * So: **append one row per run from day one.** Cost is ~250 bytes per run. Not
 * after the incident that needed it.
 *
 * ── D35 · deltas are computed PER HOST ─────────────────────────────────────
 * Two machines wrote into one git-committed snapshot directory, and sorting by
 * mtime interleaved them into a PHANTOM SHRINK — a graph that appeared to lose
 * 443 nodes and had lost nothing. Cross-host deltas are meaningless and this
 * module refuses to compute them.
 *
 * ── Blank cells, never zeros ───────────────────────────────────────────────
 * An unmeasurable value writes an EMPTY cell. Writing `0` for "I could not
 * measure this" is how a metric becomes a lie that a threshold then fires on.
 *
 * ── Observability must never fail the run ──────────────────────────────────
 * Every function here swallows its own errors. A metrics write that throws
 * would take down the pipeline it exists to observe.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { hostname } from "node:os";

/**
 * The row schema. Adding a column is safe (readers tolerate width changes);
 * REORDERING or REMOVING one is not, because history is already written.
 */
export const METRIC_COLUMNS = [
  "ts",
  "host",
  "run_id",
  "result",
  "did_work",
  "duration_s",
  "notes_total",
  "notes_public",
  "notes_private",
  "notes_secret",
  "notes_dnl",
  "inbox_pending",
  "extracts_pending",
  "pages_total",
  "pages_thin",
  "capture_ratio_median",
  "graph_nodes",
  "graph_edges",
  "graph_communities",
  "kg_entities",
  "kg_relations",
  "provider_calls",
  "provider_ok",
  "provider_failed",
  "provider_unconfigured",
  "stubs_emitted",
  "guard_activations",
] as const;

export type MetricColumn = (typeof METRIC_COLUMNS)[number];
export type MetricRow = Partial<Record<MetricColumn, string | number | null | undefined>>;

/** `null`/`undefined`/NaN → an EMPTY cell. Never a zero. */
function cell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  // CSV-safety: the series must survive a reason string containing a comma.
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Append one row. Creates the file with a header if absent — and writes the
 * header EXACTLY ONCE, which the test asserts, because a header repeated
 * mid-file breaks every downstream parser at the point of the second run.
 */
export function appendMetrics(csvPath: string, row: MetricRow): void {
  try {
    mkdirSync(dirname(csvPath), { recursive: true });
    const header = METRIC_COLUMNS.join(",");
    let needHeader = true;
    if (existsSync(csvPath)) {
      const head = readFileSync(csvPath, "utf8").slice(0, header.length + 8);
      needHeader = !head.startsWith(METRIC_COLUMNS[0]);
    }
    const filled: MetricRow = {
      ts: new Date().toISOString(),
      host: hostname(),
      ...row,
    };
    const line = METRIC_COLUMNS.map((c) => cell(filled[c])).join(",");
    appendFileSync(csvPath, (needHeader ? header + "\n" : "") + line + "\n", "utf8");
  } catch {
    // Observability failure never fails the run.
  }
}

export interface ParsedRow {
  ts: number;
  host: string;
  values: Record<string, number | null>;
  raw: Record<string, string>;
}

/** Minimal CSV reader — handles the quoting `cell()` produces and nothing more. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

export function readMetrics(csvPath: string): ParsedRow[] {
  if (!existsSync(csvPath)) return [];
  let text: string;
  try {
    text = readFileSync(csvPath, "utf8");
  } catch {
    return [];
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]!);
  const rows: ParsedRow[] = [];
  for (const line of lines.slice(1)) {
    // Tolerate a repeated header (from a hand-edit or a bad merge) rather than
    // parsing it as data — tolerance here is cheap and the alternative is a
    // NaN row poisoning a delta.
    if (line.startsWith(METRIC_COLUMNS[0] + ",")) continue;
    const cells = splitCsvLine(line);
    const raw: Record<string, string> = {};
    const values: Record<string, number | null> = {};
    header.forEach((h, i) => {
      const v = cells[i] ?? "";
      raw[h] = v;
      values[h] = v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null;
    });
    const ts = Date.parse(raw["ts"] ?? "");
    rows.push({ ts: Number.isFinite(ts) ? ts : 0, host: raw["host"] ?? "", values, raw });
  }
  return rows;
}

export interface Delta {
  host: string;
  column: string;
  from: number;
  to: number;
  delta: number;
  fromTs: number;
  toTs: number;
}

/**
 * D35 · Compute deltas PER HOST. Rows from different hosts are never compared.
 *
 * The upstream failure this prevents, concretely: two machines wrote a shared
 * snapshot directory, mtime ordering interleaved their rows, and a graph that
 * had grown on both machines appeared to shrink from 3,425 to 2,982. An alert
 * fired on a shrink that never happened; the real signal was drowned.
 *
 * A blank cell yields NO delta — not a delta of zero, and not a delta from
 * zero. "I did not measure it" cannot be allowed to look like "it went to nil".
 */
export function deltasByHost(rows: readonly ParsedRow[], column: MetricColumn): Delta[] {
  const byHost = new Map<string, ParsedRow[]>();
  for (const r of rows) {
    if (!byHost.has(r.host)) byHost.set(r.host, []);
    byHost.get(r.host)!.push(r);
  }
  const out: Delta[] = [];
  for (const [host, hostRows] of byHost) {
    const sorted = [...hostRows].sort((a, b) => a.ts - b.ts);
    let prev: ParsedRow | null = null;
    for (const r of sorted) {
      const v = r.values[column];
      if (v === null || v === undefined) continue; // blank → no delta, by design
      if (prev) {
        const pv = prev.values[column];
        if (pv !== null && pv !== undefined) {
          out.push({ host, column, from: pv, to: v, delta: v - pv, fromTs: prev.ts, toTs: r.ts });
        }
      }
      prev = r;
    }
  }
  return out;
}

/**
 * I6 · "The graph grows or explains itself."
 *
 * Fires on a decrease WITHIN ONE HOST, or on no change across N runs while new
 * notes exist. Both were real, unalerted failures upstream — and I6b (all 679
 * communities silently degrading to `-1`) is the reason `graph_communities`
 * dropping to zero is called out separately: a collapse to zero is a Louvain
 * failure, not a shrinking graph, and it needs a different remedy.
 */
export function regressionAlerts(
  rows: readonly ParsedRow[],
  opts: { column?: MetricColumn; flatRuns?: number } = {},
): Array<{ severity: "warn" | "loud"; message: string }> {
  const column = opts.column ?? "graph_nodes";
  const flatRuns = opts.flatRuns ?? 3;
  const alerts: Array<{ severity: "warn" | "loud"; message: string }> = [];

  for (const d of deltasByHost(rows, column)) {
    if (d.delta < 0) {
      alerts.push({
        severity: "loud",
        message:
          `${column} DECREASED on ${d.host}: ${d.from} → ${d.to} (${d.delta}). ` +
          `A derived artifact that shrank is either a rebuild regression or a real deletion — ` +
          `it is never routine. (Delta is per-host: D35.)`,
      });
    }
  }

  for (const d of deltasByHost(rows, "graph_communities")) {
    if (d.to === 0 && d.from > 0) {
      alerts.push({
        severity: "loud",
        message:
          `COMMUNITIES COLLAPSED to 0 on ${d.host} (was ${d.from}) — community detection failed ` +
          `silently. This is I6b; it happened twice upstream and was never alerted.`,
      });
    }
  }

  const byHost = new Map<string, ParsedRow[]>();
  for (const r of rows) {
    if (!byHost.has(r.host)) byHost.set(r.host, []);
    byHost.get(r.host)!.push(r);
  }
  for (const [host, hostRows] of byHost) {
    const sorted = [...hostRows].sort((a, b) => a.ts - b.ts).slice(-flatRuns);
    if (sorted.length < flatRuns) continue;
    const vals = sorted.map((r) => r.values[column]).filter((v) => v !== null);
    if (vals.length < flatRuns) continue;
    const flat = vals.every((v) => v === vals[0]);
    const grew = sorted.some((r) => (r.values["notes_total"] ?? 0) > (sorted[0]!.values["notes_total"] ?? 0));
    if (flat && grew) {
      alerts.push({
        severity: "warn",
        message: `${column} unchanged for ${flatRuns} runs on ${host} while new notes arrived — the builder may not be seeing them.`,
      });
    }
  }

  return alerts;
}
