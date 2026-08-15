#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * THE STRIP GATE — 00-MASTER-BUILD-BRIEF.md §8, milestone M3.
 *
 * "The single riskiest step. Nothing ships until it is clean."
 *
 * Sutra Core is an extraction from one person's live private system. By default
 * it inherits that person: their names, their hosts, their clients, their keys.
 * This scan is the mechanical answer to "a stranger reading this repo learns
 * nothing about any person".
 *
 * Two design rules, both learned the hard way:
 *
 *   D7 — an ignore file is an EGRESS SURFACE. `.easignore` silently superseded
 *   `.gitignore` for Expo uploads and shipped five credential files. So this
 *   scan walks the FILESYSTEM, not `git ls-files`: a file that is untracked but
 *   present is still a file a `cp -r` or a packaging tool will pick up.
 *
 *   D14 — a scanner is only ever as good as its list, and the list WILL be
 *   incomplete. The pattern set is content-hashed (I15) so that improving it
 *   invalidates the last full scan instead of changing nothing retroactively.
 *
 * Exit 0 = clean. Exit 1 = something must not ship.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, sep, basename } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const args = new Set(process.argv.slice(2));
const VERBOSE = args.has("--verbose");

const findings = [];
const stats = { files: 0, bytes: 0, rules: 0 };

function report(severity, rule, rel, detail, line) {
  findings.push({ severity, rule, file: rel, detail, line });
}

// ── Pattern set ──────────────────────────────────────────────────────────────
const PATTERNS_PATH = join(ROOT, "automation/policies/secret-patterns.json");
const patternSet = JSON.parse(readFileSync(PATTERNS_PATH, "utf8"));

/**
 * The pattern strings are shared with PowerShell and Python, which use inline
 * `(?i)`. JavaScript's RegExp does not support inline flags, so translate.
 */
export function toJsRegExp(pattern, extraFlags = "g") {
  let flags = extraFlags;
  let body = pattern;
  const inline = body.match(/^\(\?([ims]+)\)/);
  if (inline) {
    body = body.slice(inline[0].length);
    for (const f of inline[1]) if (!flags.includes(f)) flags += f;
  }
  return new RegExp(body, flags);
}

const secretRules = patternSet.rules.map((r) => ({ ...r, re: toJsRegExp(r.pattern) }));
stats.rules = secretRules.length;

// ── What must never appear, beyond key shapes ────────────────────────────────
// Every entry is a CLASS of leak, not one person's data — the point is that this
// file itself must be publishable. Deployment-specific names go in
// `.leakscanrc.json`, which is gitignored.
const CLASS_RULES = [
  {
    id: "windows-user-path",
    severity: "error",
    re: /[A-Za-z]:[\\/]Users[\\/](?!<|\$|USERNAME|%|\{)[A-Za-z0-9._-]+/g,
    why: "an absolute path naming a real user account on a real machine",
  },
  {
    id: "unix-home-path",
    severity: "error",
    re: /\/(?:home|Users)\/(?!<|\$|\{)[a-z][a-z0-9._-]{2,}\//g,
    why: "an absolute home path naming a real account",
  },
  {
    id: "root-path",
    severity: "warn",
    re: /(?:^|[\s"'=(])\/root\/[A-Za-z0-9._/-]+/g,
    why: "a VPS-specific root path — one deployment's topology",
  },
  {
    id: "tailnet-ip",
    severity: "error",
    re: /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/g,
    why: "a CGNAT/tailnet address — a specific private network node",
  },
  {
    id: "public-ip-literal",
    severity: "warn",
    re: /(?<![\w.])(?!0\.|10\.|127\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|22[4-9]\.|2[3-5]\d\.)(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g,
    why: "a literal public IP address — almost always someone's server",
  },
  {
    id: "email-address",
    severity: "error",
    re: /\b[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net)|test\b|localhost|sutra\.invalid)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    why: "a real email address",
  },
  {
    id: "telegram-handle",
    severity: "warn",
    re: /(?:^|\s)@[A-Za-z][A-Za-z0-9_]{4,31}(?:bot|Bot)\b/g,
    why: "a bot handle bound to one deployment",
  },
  {
    id: "claude-brain-feeder",
    severity: "error",
    re: /claude[-_]brain/gi,
    why: "the personal feeder — §8 requires the feeder, imports, MCP entry and external_dirs reference all removed",
  },
  {
    id: "legacy-component-name",
    severity: "error",
    re: /\b(?:dimaag_[a-z_]+|DIMAAG_[A-Z_]+)\b/g,
    why: "a pre-rename identifier. §9.11 — this project renamed itself twice and lingering paths are still drift. The names are `sutra`, `sutra_*`, `SUTRA_*`, and they do not change again.",
  },
];

// ── Files and directories that must not exist at all ─────────────────────────
const FORBIDDEN_PATHS = [
  { glob: /(^|\/)Keys\.md$/i, why: "a credential file" },
  { glob: /(^|\/)[^/]*\.local\.(md|json|ya?ml|toml|js|ts)$/i, why: "a machine-local config that is not shipped" },
  { glob: /(^|\/)keys(\/|$)/i, why: "a key directory" },
  { glob: /(^|\/)state\/secrets(\/|$)/i, why: "a secret store" },
  { glob: /(^|\/)Conv_history(\/|$)/i, why: "conversation history" },
  { glob: /(^|\/)Voice Samples/i, why: "voice reference clips" },
  { glob: /(^|\/)systemd(\/|$)/i, why: "one deployment's 31 unit files" },
  { glob: /\.age$/i, why: "an encrypted vault blob" },
  { glob: /(^|\/)graphify-out(\/|$)/i, why: "per-machine tool output" },
];

// ── Vault-content check: vault-template/ must contain ZERO notes ─────────────
function checkVaultTemplateIsEmpty() {
  const tpl = join(ROOT, "vault-template");
  if (!existsSync(tpl)) return;
  const allowedMd = /(?:^|\/)(?:README|AGENTS|CLAUDE)\.md$|(?:^|\/)config\/|\.gitkeep$/;
  for (const abs of walk(tpl)) {
    const rel = relative(ROOT, abs).split(sep).join("/");
    if (!abs.endsWith(".md")) continue;
    if (allowedMd.test(rel)) continue;
    report("error", "vault-content", rel,
      "vault-template must ship the SKELETON ONLY — zero notes. Templates belong under config/templates/.");
  }
}

// ── Policy files that must ship EMPTY ────────────────────────────────────────
const MUST_BE_EMPTY = [
  {
    path: "automation/config/redaction-aliases.json",
    key: "aliases",
    why: "the alias map is a LIST OF REAL CLIENT NAMES. It is local_only by nature and must never ship.",
  },
  {
    path: "automation/policies/exposure-allowlist.json",
    key: "promotions",
    why: "a promotion names a specific note in a specific person's vault",
  },
  {
    path: "automation/policies/exposure-allowlist.json",
    key: "projections",
    why: "a projection names a specific note",
  },
  {
    path: "automation/policies/exposure-requests.json",
    key: "requests",
    why: "the request queue is one person's pending exposure decisions",
  },
];

function checkMustBeEmpty() {
  for (const { path, key, why } of MUST_BE_EMPTY) {
    const abs = join(ROOT, path);
    if (!existsSync(abs)) continue;
    let json;
    try { json = JSON.parse(readFileSync(abs, "utf8")); } catch {
      report("error", "policy-unparseable", path, "must be valid JSON — the gate fails closed on it");
      continue;
    }
    const val = json[key];
    if (Array.isArray(val) && val.length > 0) {
      report("error", "policy-not-empty", path, `\`${key}\` has ${val.length} entr(ies) — ${why}`);
    }
  }
}

// ── Provider config must be account-neutral ──────────────────────────────────
function checkProviderNeutrality() {
  const abs = join(ROOT, "automation/policies/provider-router.json");
  if (!existsSync(abs)) return;
  const text = readFileSync(abs, "utf8");
  let json;
  try { json = JSON.parse(text); } catch { return; }
  const envNames = JSON.stringify(json).match(/[A-Z][A-Z0-9_]{4,}_(?:API_)?KEY/g) ?? [];
  for (const name of new Set(envNames)) {
    if (/PERSONAL|MY_|RAHUL|WORK_|CORP/i.test(name)) {
      report("error", "provider-account-bound", "automation/policies/provider-router.json",
        `env var \`${name}\` implies a specific account`);
    }
  }
  // A provider declared in the router with no key shape in the pattern set is
  // exactly D5's failure: a configurable provider the scanner cannot see.
  const declared = new Set((json.providers ?? []).map((p) => p.id ?? p.name).filter(Boolean));
  const covered = new Set(patternSet.rules.map((r) => r.provider).filter(Boolean));
  for (const p of declared) {
    if (!covered.has(p) && !["ollama", "local", "deterministic", "harness"].includes(p)) {
      report("warn", "provider-uncovered", "automation/policies/secret-patterns.json",
        `provider \`${p}\` is configurable but has no key shape in the pattern set (D5)`);
    }
  }
}

// ── Walk ─────────────────────────────────────────────────────────────────────
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", ".sutra"]);
const BINARY_EXT = /\.(png|jpg|jpeg|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|otf|eot|mp3|wav|m4a|mp4|mov|wasm|node|exe|dll)$/i;

// Files that legitimately contain the SHAPES this scan hunts for, because they
// ARE the hunt. Kept deliberately short and exact — a broad exclusion is how a
// leak scan quietly stops scanning.
const SELF_REFERENTIAL = new Set([
  "automation/policies/secret-patterns.json",
  "scripts/leak-scan.mjs",
  "packages/core/src/gate/patterns.ts",
  "packages/core/src/gate/patterns.test.ts",
  "automation/scripts/governance/Invoke-SecretScan.ps1",
  ".githooks/pre-commit",
  ".githooks/pre-commit.ps1",
  "tests/fixtures/planted-secrets.md",
  "Master_documentation/SECURITY.md",
  "INHERITED-DEFECTS.md",
  "CONTRIBUTING.md",
]);

function* walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) yield* walk(abs);
    else if (e.isFile()) yield abs;
  }
}

function scanFile(abs) {
  const rel = relative(ROOT, abs).split(sep).join("/");

  for (const { glob, why } of FORBIDDEN_PATHS) {
    if (glob.test(rel)) report("error", "forbidden-path", rel, why);
  }

  if (BINARY_EXT.test(abs)) return;
  let size;
  try { size = statSync(abs).size; } catch { return; }
  if (size > 4_000_000) return;

  let text;
  try { text = readFileSync(abs, "utf8"); } catch { return; }
  if (text.includes(" ")) return; // binary in disguise

  stats.files++;
  stats.bytes += size;

  if (SELF_REFERENTIAL.has(rel)) return;

  const lineAt = (idx) => text.slice(0, idx).split("\n").length;

  for (const rule of secretRules) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text)) !== null) {
      // A `heuristic` rule may raise a tier and warn; it must never be the thing
      // that blocks. D24 / I17.
      const sev = rule.band === "definite" ? "error" : "warn";
      report(sev, `secret:${rule.id}`, rel, `${rule.description.split(".")[0]}`, lineAt(m.index));
      if (rule.re.lastIndex === m.index) rule.re.lastIndex++;
    }
  }

  for (const rule of CLASS_RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text)) !== null) {
      report(rule.severity, rule.id, rel, `${rule.why} — matched \`${m[0].trim().slice(0, 60)}\``, lineAt(m.index));
      if (rule.re.lastIndex === m.index) rule.re.lastIndex++;
    }
  }
}

// ── Run ──────────────────────────────────────────────────────────────────────
for (const abs of walk(ROOT)) scanFile(abs);
checkVaultTemplateIsEmpty();
checkMustBeEmpty();
checkProviderNeutrality();

// ── Ignore-file supersession (D7) ────────────────────────────────────────────
// Every ignore-like file is a separate egress surface with its own rules. Answer
// the question empirically — which files does THAT tool's ruleset let through?
const IGNORE_FILES = [".gitignore", ".npmignore", ".dockerignore", ".vercelignore", ".easignore"];
const presentIgnores = IGNORE_FILES.filter((f) => existsSync(join(ROOT, f)));
for (const f of presentIgnores) {
  if (f === ".gitignore") continue;
  report("warn", "ignore-supersession", f,
    `a second ignore file is present. It SUPERSEDES .gitignore for its own tool (D7 — .easignore did exactly this and shipped five credential files). It needs its own case in tests/leak/ignore-supersession.test.ts.`);
}

// ── Pattern-set hash (I15) ───────────────────────────────────────────────────
const patternHash = createHash("sha256").update(readFileSync(PATTERNS_PATH)).digest("hex");

// ── Output ───────────────────────────────────────────────────────────────────
const errors = findings.filter((f) => f.severity === "error");
const warns = findings.filter((f) => f.severity === "warn");

const fmt = (f) => `  ${f.severity === "error" ? "✗" : "!"} [${f.rule}] ${f.file}${f.line ? ":" + f.line : ""}\n      ${f.detail}`;

if (errors.length) {
  console.error("leak-scan: FAIL\n");
  for (const f of errors) console.error(fmt(f));
}
if (warns.length && (VERBOSE || errors.length)) {
  console.error(`\n${warns.length} warning(s) — these do not block, by design (I17: a fuzzy rule may raise a tier, never fail a gate):\n`);
  for (const f of warns.slice(0, 40)) console.error(fmt(f));
  if (warns.length > 40) console.error(`  … and ${warns.length - 40} more (run with --verbose)`);
}

console.log(
  `\nleak-scan: ${errors.length ? "FAIL" : "OK"} — ${stats.files} files, ` +
  `${(stats.bytes / 1024).toFixed(0)} KB, ${stats.rules} secret rules + ${CLASS_RULES.length} class rules.\n` +
  `pattern-set sha256: ${patternHash.slice(0, 16)}…  (I15: a change here invalidates the last full corpus scan)\n` +
  `${errors.length} blocking, ${warns.length} advisory.`,
);

process.exit(errors.length ? 1 : 0);
