// SPDX-License-Identifier: Apache-2.0
/**
 * Output. Every read command supports `--json`.
 *
 * Two rules, both from the contract:
 *
 *  1. **`--json` writes ONLY JSON to stdout.** Progress, warnings and
 *     degradation notes go to stderr. A caller piping `sutra ask --json` into
 *     `jq` must never have to strip a banner — and a mixed stream is exactly
 *     the class of breakage that makes people stop scripting against a tool.
 *
 *  2. **A degradation is always reported, in both modes.** In human mode it is
 *     a dimmed note; in JSON it is a `degraded[]` array. "Degradation is
 *     allowed. Silent degradation is not" is not only a pipeline rule — a CLI
 *     that quietly returns fewer results is the same defect at a smaller scale.
 */

/** NO_COLOR is honoured, and colour is off when stdout is not a TTY. */
const useColor =
  process.stdout.isTTY === true &&
  !process.env["NO_COLOR"] &&
  process.env["TERM"] !== "dumb";

const wrap = (code: string) => (s: string): string => (useColor ? `[${code}m${s}[0m` : s);

export const c = {
  bold: wrap("1"),
  dim: wrap("2"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("34"),
  magenta: wrap("35"),
  cyan: wrap("36"),
};

export interface OutputMode {
  json: boolean;
  quiet: boolean;
}

/** Human-readable output. Suppressed entirely in `--json` mode. */
export function say(mode: OutputMode, ...lines: string[]): void {
  if (mode.json || mode.quiet) return;
  process.stdout.write(lines.join("\n") + "\n");
}

/** The JSON payload. stdout, exactly once, nothing else. */
export function emitJson(mode: OutputMode, payload: unknown): void {
  if (!mode.json) return;
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
}

/** A note that something ran in a reduced mode. ALWAYS shown, even when quiet. */
export function degraded(mode: OutputMode, ...notes: string[]): void {
  if (!notes.length) return;
  if (mode.json) return; // carried in the payload's `degraded[]` instead
  for (const n of notes) process.stderr.write(c.yellow("  ~ ") + c.dim(n) + "\n");
}

/** A warning. stderr in both modes — it is not part of the data. */
export function warn(msg: string): void {
  process.stderr.write(c.yellow("warning: ") + msg + "\n");
}

/** An error, with its remedy. stderr in both modes. */
export function fail(msg: string, remedy?: string): void {
  process.stderr.write(c.red("error: ") + msg + "\n");
  if (remedy) process.stderr.write(c.dim("  → " + remedy) + "\n");
}

export function heading(mode: OutputMode, s: string): void {
  say(mode, "", c.bold(s));
}

/** ✓ / ! / ✗ — used by `doctor`, where the shape of the list is the report. */
export function check(mode: OutputMode, status: "ok" | "warn" | "fail", label: string, detail?: string): void {
  if (mode.json || mode.quiet) return;
  const mark = status === "ok" ? c.green("✓") : status === "warn" ? c.yellow("!") : c.red("✗");
  process.stdout.write(`  ${mark} ${label}\n`);
  if (detail) {
    for (const line of detail.split("\n")) process.stdout.write(c.dim(`      ${line}`) + "\n");
  }
}

export function table(mode: OutputMode, rows: Array<[string, string]>): void {
  if (mode.json || mode.quiet || rows.length === 0) return;
  const width = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) process.stdout.write(`  ${c.dim(k.padEnd(width))}  ${v}\n`);
}
