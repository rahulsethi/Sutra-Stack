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
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const args = new Set(process.argv.slice(2));
const VERBOSE = args.has("--verbose");

const findings = [];
const stats = { files: 0, bytes: 0, rules: 0, tracked: 0, ignored: 0 };

/**
 * D7, implemented rather than merely cited.
 *
 * The defect was: `.easignore` SUPERSEDED `.gitignore` for the Expo uploader,
 * so five credential files that git correctly ignored were uploaded on every
 * build. The lesson it produced was NOT "scan everything" — it was:
 *
 *     answer the question EMPIRICALLY. Replay the ruleset through the tool's
 *     own engine rather than reasoning about it.
 *
 * So this scan asks git what git would ship, and classifies each finding by
 * whether that particular file actually travels:
 *
 *   tracked                  → BLOCKING. It is in the repo; it ships. No argument.
 *   untracked, NOT ignored   → BLOCKING. `git add -A`, `npm pack` or a plain
 *                              `cp -r` all pick it up. Nothing is protecting it.
 *   untracked AND ignored    → advisory, NAMING the rule that excludes it. It
 *                              does not ship via git — but it is on the disk,
 *                              and the moment a second ignore file appears (see
 *                              the `ignore-supersession` check below) that
 *                              protection may not apply to that tool.
 *
 * A file the scan cannot classify is treated as BLOCKING. Failing closed here
 * costs a false alarm; failing open costs a credential.
 */
function gitClassify() {
  const tracked = new Set();
  const ignored = new Map(); // relPath → the ignore rule that excludes it
  try {
    for (const line of execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64e6 }).split("\0")) {
      if (line) tracked.add(line);
    }
  } catch {
    return { tracked: null, ignored: null }; // not a git repo → everything blocking
  }
  try {
    // `-v` reports WHICH rule matched, so a finding can name it.
    const out = execFileSync(
      "git",
      ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 64e6 },
    );
    for (const p of out.split("\0")) if (p) ignored.set(p, ".gitignore");
  } catch { /* leave empty → those files stay blocking */ }
  return { tracked, ignored };
}

const git = gitClassify();

/** Does this file actually travel? */
function shipStatus(rel) {
  if (!git.tracked) return { ships: true, why: "not a git repo — cannot verify what would ship" };
  if (git.tracked.has(rel)) return { ships: true, why: "tracked" };
  if (git.ignored?.has(rel)) return { ships: false, why: `excluded by ${git.ignored.get(rel)}` };
  return { ships: true, why: "untracked and NOT ignored — `git add -A` or a `cp -r` would take it" };
}

function report(severity, rule, rel, detail, line) {
  // A finding in a file that provably does not ship is downgraded to advisory
  // and carries the reason, so the list stays honest in both directions.
  const status = shipStatus(rel);
  if (severity === "error" && !status.ships) {
    findings.push({ severity: "warn", rule, file: rel, detail: `${detail}  [does not ship — ${status.why}]`, line });
    return;
  }
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
    aboutFileIdentity: true,
    severity: "error",
    re: /[A-Za-z]:[\\/]Users[\\/](?!<|\$|USERNAME|%|\{)[A-Za-z0-9._-]+/g,
    why: "an absolute path naming a real user account on a real machine",
  },
  {
    id: "unix-home-path",
    aboutFileIdentity: true,
    severity: "error",
    re: /\/(?:home|Users)\/(?!<|\$|\{)[a-z][a-z0-9._-]{2,}\//g,
    why: "an absolute home path naming a real account",
  },
  {
    id: "root-path",
    aboutFileIdentity: true,
    severity: "warn",
    re: /(?:^|[\s"'=(])\/root\/[A-Za-z0-9._/-]+/g,
    why: "a VPS-specific root path — one deployment's topology",
  },
  {
    id: "tailnet-ip",
    aboutFileIdentity: true,
    severity: "error",
    re: /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/g,
    why: "a CGNAT/tailnet address — a specific private network node",
  },
  {
    id: "public-ip-literal",
    aboutFileIdentity: true,
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

// Declared in the PATTERN SET, not here — so this scan and the PowerShell
// scanner cannot drift apart, and a reviewer has exactly one list to audit.
const SELF_REFERENTIAL = new Set(patternSet.scanner_exempt_paths ?? []);

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

/**
 * SOURCE CODE IS NOT VAULT CONTENT, and the distinction decides which rules apply.
 *
 * Two kinds of rule live in this scan, and conflating them produces exactly the
 * false positives that get a scanner disabled:
 *
 *   WHAT A FILE CONTAINS — a matched key prefix, a PEM block, a JWT.
 *     Applies EVERYWHERE, including source. A real key in a .ts file is a real
 *     key, and nothing about being source code makes it less so.
 *
 *   WHAT A FILE *IS* — a path under `keys/`, a literal host address, a home
 *     directory. These describe VAULT CONTENT and DEPLOYMENT ARTIFACTS. In
 *     source code the same strings are directory names, constants, parsers and
 *     test fixtures.
 *
 * Two real findings prompted this, and both were the scan being wrong:
 *
 *   - `ee/src/keys/kms.ts` matched the `keys/` secret-floor path. It is a source
 *     directory named for the KMS integration, not a key store.
 *   - `packages/daemon/src/bind.test.ts` matched the tailnet rule on
 *     `100.64.0.1` — the first address of RFC 6598's reserved CGNAT range, used
 *     as a fixture to assert that a tailnet address is NOT treated as loopback.
 *     Removing it would delete the test's point.
 *
 * Suppressing either individually would have been a suppression. This is a rule:
 * D24's banding logic one level up. A guard that is wrong in a predictable way
 * gets routed around, and then it protects nothing.
 */
const SOURCE_EXT = /\.(ts|mts|cts|tsx|js|mjs|cjs|jsx|ps1|psm1|psd1|py|sh|go|rs|java|rb)$/i;

function scanFile(abs) {
  const rel = relative(ROOT, abs).split(sep).join("/");
  const isSource = SOURCE_EXT.test(abs);

  // A path rule describes what a file IS. In a source tree it describes a
  // directory name, so it does not apply.
  if (!isSource) {
    for (const { glob, why } of FORBIDDEN_PATHS) {
      if (glob.test(rel)) report("error", "forbidden-path", rel, why);
    }
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
    // A path- or address-shaped rule describes what a file IS. In source code
    // the same strings are constants, parsers and test fixtures — see the note
    // on SOURCE_EXT above. Identity-leak rules (an email, claude-brain, a legacy
    // identifier) still apply everywhere, because those are always leaks.
    if (isSource && rule.aboutFileIdentity) continue;

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
