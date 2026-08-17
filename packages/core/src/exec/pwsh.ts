// SPDX-License-Identifier: Apache-2.0
/**
 * DIMAAG · PowerShell 7 invocation. The boundary between the TypeScript core
 * and the pipeline that does the heavy lifting.
 *
 * ── §9.8 · `pwsh` is not `powershell` ──────────────────────────────────────
 * `pwsh` is PowerShell 7 and is cross-platform. `powershell` is Windows
 * PowerShell 5.1 and is Windows-only, has a different `$PSVersionTable`, no
 * `??`, no `-Parallel`, and different default encodings.
 *
 * The upstream fell back to `powershell` when `pwsh` was missing. That fallback
 * is REMOVED here, deliberately. It produces a machine that appears to work and
 * then fails on the first script using 7-only syntax — a class of failure the
 * `doctor` check cannot distinguish from a script bug. `pwsh` is a declared
 * prerequisite, `doctor` checks it, and its absence is an error with an install
 * instruction rather than a silent degradation to a different language.
 *
 * ── D26 · a backslash is a legal filename character on Linux ───────────────
 * `Join-Path $Root 'state\checks'` creates a directory literally named
 * `state\checks` on Linux. Every path this module builds goes through
 * `node:path`, never string concatenation, and the pwsh scripts it calls use
 * `[IO.Path]::Combine`.
 */

import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { join, isAbsolute, normalize } from "node:path";

export interface PwshResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Which interpreter actually ran. `doctor` prints this. */
  interpreter: string | null;
  /**
   * D11 — five distinct outcomes, never sharing a counter.
   * `missing-interpreter` is NOT a script failure and must not be counted as one.
   */
  outcome: "ok" | "failed" | "missing-interpreter" | "missing-script";
}

let cachedPwsh: string | null | undefined;

/**
 * Locate `pwsh`. Cached per process — this is called once per pipeline stage
 * and the answer does not change mid-run.
 *
 * Returns `null` if PowerShell 7 is not installed. It does NOT fall back to
 * Windows PowerShell; see the header.
 */
export function findPwsh(opts: { refresh?: boolean } = {}): string | null {
  if (!opts.refresh && cachedPwsh !== undefined) return cachedPwsh;

  const explicit = process.env["SUTRA_PWSH"];
  if (explicit && existsSync(explicit)) {
    cachedPwsh = explicit;
    return cachedPwsh;
  }

  const probe = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], {
    encoding: "utf8",
    shell: process.platform === "win32",
    timeout: 10_000,
  });
  if (!probe.error && probe.status === 0) {
    const major = Number((probe.stdout ?? "").trim());
    if (Number.isFinite(major) && major >= 7) {
      cachedPwsh = "pwsh";
      return cachedPwsh;
    }
  }

  cachedPwsh = null;
  return null;
}

/** Test seam. */
export function resetPwshCache(): void {
  cachedPwsh = undefined;
}

/**
 * Run a PowerShell script.
 *
 * `scriptPath` may be absolute, or relative to `opts.cwd`. It is normalised
 * through `node:path` — never concatenated — so a caller cannot accidentally
 * create D26's `state\checks` directory on Linux.
 *
 * Note `-NoProfile`: a user profile that writes to stdout would corrupt every
 * `--json` response, and one that sets `$ErrorActionPreference` would change
 * pipeline semantics invisibly.
 */
export function runPwsh(
  scriptPath: string,
  args: readonly string[] = [],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): PwshResult {
  const abs = isAbsolute(scriptPath)
    ? normalize(scriptPath)
    : join(opts.cwd ?? process.cwd(), scriptPath);

  if (!existsSync(abs)) {
    return {
      code: 2, // exit code 2 = not found / no workflow — lifted verbatim
      stdout: "",
      stderr: `script not found: ${abs}`,
      interpreter: null,
      outcome: "missing-script",
    };
  }

  const exe = findPwsh();
  if (!exe) {
    return {
      code: 6, // exit code 6 = runner missing — lifted verbatim
      stdout: "",
      stderr:
        "PowerShell 7 (`pwsh`) was not found on PATH.\n" +
        "  It is a declared prerequisite of the Sutra pipeline and is cross-platform.\n" +
        "  Windows: winget install Microsoft.PowerShell\n" +
        "  macOS:   brew install --cask powershell\n" +
        "  Linux:   https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-linux\n" +
        "  (Windows PowerShell 5.1 is NOT a substitute — Sutra does not fall back to it, because a\n" +
        "   fallback that half-works is harder to diagnose than an absence.)",
      interpreter: null,
      outcome: "missing-interpreter",
    };
  }

  const spawnOpts: SpawnSyncOptions = {
    encoding: "utf8",
    cwd: opts.cwd ?? process.cwd(),
    env: opts.env ?? process.env,
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
  };
  if (opts.timeoutMs) spawnOpts.timeout = opts.timeoutMs;

  const result = spawnSync(
    exe,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", abs, ...args],
    spawnOpts,
  );

  const code = result.status ?? -1;
  return {
    code,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    interpreter: exe,
    outcome: code === 0 ? "ok" : "failed",
  };
}

/**
 * §9.7 · ARGUMENT-DROPPING WRAPPER HOPS.
 *
 * A runner invoked as `<tool> -- run <skill> -- args` silently dropped the arguments across
 * thirteen skills. Nothing errored; the skills simply ran with no input.
 *
 * The lesson is architectural: prefer ONE flat invocation, and test that the
 * arguments actually arrive. This helper exists so that any place tempted to
 * build a nested command string has an alternative that is already tested
 * (`exec/pwsh.test.ts` → "arguments survive the hop").
 */
export function flatArgs(...groups: Array<readonly string[] | string | undefined>): string[] {
  const out: string[] = [];
  for (const g of groups) {
    if (g === undefined) continue;
    if (typeof g === "string") { out.push(g); continue; }
    for (const a of g) if (a !== undefined) out.push(String(a));
  }
  return out;
}
