// SPDX-License-Identifier: Apache-2.0
/**
 * `sutra doctor` — prerequisites, wiring, and the gate self-test.
 *
 * The design rule that makes this useful rather than decorative:
 *
 *     ASSERT BEHAVIOUR, NOT FILE EXISTENCE.
 *
 * §9.2 is the reason. A harness upgrade once stopped reading the config block
 * that registered the MCP server. Every file was still present and correct;
 * `hermes mcp list` was EMPTY, and "the gated read path would have been dead
 * unnoticed." A doctor that checked for the config file would have reported
 * green through the entire outage.
 *
 * So every check here answers a question about what the system DOES:
 *   - not "is pwsh configured" but "does `pwsh -v` return 7 or higher"
 *   - not "is the MCP registered" but "does it serve 14 tools at ceiling X"
 *   - not "does the classifier exist" but "does every rule match its fixture,
 *     and does a planted secret actually get floored"
 *
 * ── D4 · a rule that never fires ───────────────────────────────────────────
 * "Assert positive coverage on every guard — each floor rule ships with a
 * fixture it must match — and count rule hits so a permanently-cold rule is
 * visible." The pattern self-test below is that check, exposed to the user
 * rather than living only in CI.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  loadConfig, VaultClient, Brain, findPwsh, resolveUv, loadPatternSet, selfTestPatterns,
  classify, rescanRequired, loadGraph, verifyHeader, indexAgeHours, staleRunAlert,
  providerHealth, providerAlerts, listSkills, TIER_DISPLAY, type Tier,
} from "@sutra/core";
import { EXIT, type ExitCode } from "../exit.js";
import { say, emitJson, heading, check, warn, c, type OutputMode } from "../output.js";
import { flagString, flagBool, type ParsedArgs } from "../args.js";

interface Finding {
  id: string;
  status: "ok" | "warn" | "fail";
  label: string;
  detail?: string;
  /** What to actually do. A finding without a remedy is a shrug. */
  remedy?: string;
}

const ok = (id: string, label: string, detail?: string): Finding =>
  detail === undefined ? { id, status: "ok", label } : { id, status: "ok", label, detail };
const warnF = (id: string, label: string, detail: string, remedy?: string): Finding =>
  remedy === undefined ? { id, status: "warn", label, detail } : { id, status: "warn", label, detail, remedy };
const failF = (id: string, label: string, detail: string, remedy?: string): Finding =>
  remedy === undefined ? { id, status: "fail", label, detail } : { id, status: "fail", label, detail, remedy };

// ─────────────────────────────────────────────────────────────────────────────
// Prerequisites
// ─────────────────────────────────────────────────────────────────────────────

function checkPrereqs(): Finding[] {
  const out: Finding[] = [];

  const major = Number(process.versions.node.split(".")[0]);
  out.push(
    major >= 20
      ? ok("node", `Node ${process.versions.node}`)
      : failF("node", `Node ${process.versions.node}`, "Sutra requires Node 20 or newer.", "https://nodejs.org"),
  );

  const pwsh = findPwsh();
  out.push(
    pwsh
      ? ok("pwsh", "PowerShell 7 (`pwsh`)", `found: ${pwsh}`)
      : failF(
          "pwsh",
          "PowerShell 7 (`pwsh`) NOT FOUND",
          "The pipeline is PowerShell 7. It is cross-platform. Windows PowerShell 5.1 is NOT a\n" +
          "substitute and Sutra deliberately does not fall back to it — a fallback that half-works\n" +
          "is harder to diagnose than an absence.",
          "winget install Microsoft.PowerShell  ·  brew install --cask powershell  ·  see docs for Linux",
        ),
  );

  const git = spawnSync("git", ["--version"], { encoding: "utf8", shell: process.platform === "win32" });
  out.push(
    !git.error && git.status === 0
      ? ok("git", (git.stdout ?? "").trim())
      : failF("git", "git NOT FOUND", "The vault is a git repo; it is how every change is reversible.", "https://git-scm.com"),
  );

  const uv = resolveUv();
  out.push(
    uv
      ? ok("uv", "uv (embeddings + graph enrichment)")
      : warnF(
          "uv", "uv not found — OPTIONAL",
          "Embeddings and community detection need it. Everything else works without it:\n" +
          "keyword search, BM25, tiering, linking, the gate and cited answers are all unaffected.",
          "https://docs.astral.sh/uv/",
        ),
  );

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// The gate self-test — the check that matters most
// ─────────────────────────────────────────────────────────────────────────────

function checkGate(installRoot: string, vaultRoot: string): Finding[] {
  const out: Finding[] = [];

  let patterns;
  try {
    patterns = loadPatternSet(installRoot);
  } catch (e) {
    return [
      failF(
        "gate.patterns", "SECRET PATTERN SET UNREADABLE",
        e instanceof Error ? e.message : String(e),
        "Sutra refuses to classify with no rules — a scanner with an empty list reports every file clean.",
      ),
    ];
  }

  // D4/D5 — positive coverage. Every rule must match its own fixture.
  const self = selfTestPatterns(patterns);
  const cold = self.coverage.filter((x) => !x.matchesOwnFixture);
  out.push(
    cold.length === 0
      ? ok("gate.coverage", `${patterns.rules.length} detection rules, every one matches its own fixture`)
      : failF(
          "gate.coverage", `${cold.length} DEAD RULE(S)`,
          `These rules cannot match anything: ${cold.map((x) => x.ruleId).join(", ")}.\n` +
          "A rule that fires zero times looks exactly like a rule protecting a clean corpus (D4).",
          "Fix the pattern or the fixture in automation/policies/secret-patterns.json",
        ),
  );

  out.push(
    self.falsePositives.length === 0
      ? ok("gate.false-positives", "no definite rule matches a benign string")
      : warnF(
          "gate.false-positives", `${self.falsePositives.length} false positive(s)`,
          self.falsePositives.map((f) => `${f.ruleId} matched "${f.benign}"`).join("\n"),
          "A definite rule that over-matches will get routed around with --no-verify (D6/D24).",
        ),
  );

  // THE LIVE BEHAVIOURAL PROBE. Plant a secret; assert it is floored.
  //
  // The probe text comes from the pattern set's OWN declared fixtures rather
  // than a literal typed here. Two reasons, and the second is the better one:
  //
  //   1. This file would otherwise ship a real key SHAPE, which the leak scan
  //      correctly flags — and adding an exclusion for it would widen the
  //      exclusion list, which is how a leak scan stops meaning anything.
  //
  //   2. D5's actual lesson. The upstream pattern *looked* right and the tests
  //      written from the same mental model passed. A probe typed by hand here
  //      is a second mental model that can drift from the rules it is checking;
  //      driving it from the data means the probe is always testing the rules
  //      that are actually loaded.
  const definite = patterns.rules.filter((r) => r.band === "definite");
  const probeFixture = definite[0]?.fixture ?? "";
  const planted = classify({ text: `token: ${probeFixture}` }, patterns);
  out.push(
    planted.tier === "local_only" && planted.blocking
      ? ok("gate.floor", `a planted credential (${definite[0]?.id}) is floored to \`secret\` and blocks`)
      : failF(
          "gate.floor", "THE SECRET FLOOR DID NOT FIRE ON A PLANTED CREDENTIAL",
          `probe rule=${definite[0]?.id ?? "none"} → tier=${planted.tier} blocking=${planted.blocking}`,
          "This is a release-blocking failure. Do not use this install until it is fixed.",
        ),
  );

  // …and the converse, over EVERY benign fixture the set declares.
  const falsePositives = patterns.benign.filter((b) => classify({ text: b }, patterns).blocking);
  out.push(
    falsePositives.length === 0
      ? ok("gate.benign", `${patterns.benign.length} known-benign strings are NOT mistaken for credentials`)
      : warnF(
          "gate.benign", `${falsePositives.length} false positive(s)`,
          falsePositives.join("\n"),
          "A definite rule that over-matches gets routed around with --no-verify, and then it protects nothing.",
        ),
  );

  // I15 — has the corpus been scanned under the ACTIVE pattern set?
  const stampPath = join(vaultRoot, "state", "checks", "pattern-scan.json");
  let stamped: string | null = null;
  try {
    stamped = (JSON.parse(readFileSync(stampPath, "utf8")) as { pattern_hash?: string }).pattern_hash ?? null;
  } catch { /* never scanned */ }

  const rescan = rescanRequired(patterns, stamped);
  out.push(
    !rescan.required
      ? ok("gate.rescan", "the corpus has been scanned under the active pattern set")
      : warnF(
          "gate.rescan", "A FULL RE-SCAN IS DUE (I15)", rescan.reason,
          "sutra rescan   — a better pattern list changes NOTHING retroactively without this.",
        ),
  );

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Vault + derived artifacts
// ─────────────────────────────────────────────────────────────────────────────

function checkVault(vaultRoot: string, ceiling: Tier, walkRoots: string[]): Finding[] {
  const out: Finding[] = [];

  if (!existsSync(vaultRoot)) {
    return [failF("vault", `vault not found at ${vaultRoot}`, "A config synced from another machine carries that machine's paths (§9.6).", "sutra init")];
  }
  out.push(ok("vault", `vault at ${vaultRoot}`));

  if (!existsSync(join(vaultRoot, ".git"))) {
    out.push(warnF(
      "vault.git", "the vault is not a git repo",
      "Invariant 7 — automated maintenance may act without asking BECAUSE every action is\n" +
      "git-tracked and reversible. Without git, `reversible-auto` is just `auto`.",
      "git init && git add -A && git commit -m 'vault'",
    ));
  } else {
    out.push(ok("vault.git", "vault is version-controlled"));
  }

  const vc = new VaultClient(vaultRoot);
  const brain = new Brain(vc, ceiling, walkRoots);
  const g = brain.gateInspect(0);
  out.push(ok(
    "vault.notes",
    `${g.scanned} notes · ${g.visible} visible at ceiling ${g.ceiling_display}`,
    `withheld — private ${g.withheld_by_tier.private}, secret ${g.withheld_by_tier.secret}, do_not_learn ${g.withheld_by_tier.do_not_learn}`,
  ));

  // I1/I2/D10 — a missed run must be distinguishable from a run that did nothing.
  const run = staleRunAlert(vaultRoot);
  out.push(
    run.ok
      ? ok("pipeline.run", run.message)
      : run.severity === "loud"
        ? failF("pipeline.run", "PIPELINE", run.message, "sutra daily")
        : warnF("pipeline.run", "pipeline", run.message, "sutra daily"),
  );

  // I18/D13 — a derived artifact's header must agree with its body.
  const graph = loadGraph(vaultRoot);
  if (graph) {
    const problems = verifyHeader(graph);
    out.push(
      problems.length === 0
        ? ok("graph.header", `graph header agrees with its body (${graph.nodes.length} nodes, ${graph.edges.length} edges)`)
        : failF(
            "graph.header", "GRAPH HEADER DISAGREES WITH ITS BODY (I18)",
            problems.map((p) => `${p.counter}: header ${p.header}, actual ${p.actual}`).join("\n") +
            "\nThe cheap reader is the one that is wrong — which is the worst possible arrangement.",
            "sutra graph export   — and check that every enrichment pass updates its own counters",
          ),
    );
  } else {
    out.push(warnF("graph", "no graph export yet", "Search and ask work without it.", "sutra graph export"));
  }

  const age = indexAgeHours(vaultRoot);
  out.push(
    age === null
      ? warnF("index", "no embedding index", "Vector recall is off; BM25 and keyword search are unaffected.", "sutra refresh-index")
      : age > 72
        ? warnF("index", `embedding index is ${Math.round(age)}h old`, "Notes added since then are not vector-searchable.", "sutra refresh-index")
        : ok("index", `embedding index is ${Math.round(age)}h old`),
  );

  // I19/D36 — a builder's inputs must be version-controlled.
  const batchDir = join(vaultRoot, "compiled", "graph", "batches");
  if (existsSync(batchDir)) {
    const ignored = spawnSync("git", ["check-ignore", batchDir], { cwd: vaultRoot, encoding: "utf8", shell: process.platform === "win32" });
    out.push(
      ignored.status === 0
        ? failF(
            "graph.inputs", "THE GRAPH'S INPUT STORE IS GITIGNORED (I19/D36)",
            `${batchDir} is excluded from version control. The graph is a pure function of it, so\n` +
            "losing that directory would not degrade the graph — it would make it UNREPRODUCIBLE,\n" +
            "permanently. Committing only the output is a backup illusion.",
            "Remove the ignore rule. If an artifact is a pure function of an input, the INPUT is the thing you must not lose.",
          )
        : ok("graph.inputs", "the graph's input store is version-controlled"),
    );
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Harness wiring — tool count AND ceiling, never file existence
// ─────────────────────────────────────────────────────────────────────────────

function checkHarness(harness: string, installRoot: string): Finding[] {
  const out: Finding[] = [];
  const binPath = join(installRoot, "packages", "mcp", "dist", "bin.js");

  if (!existsSync(binPath)) {
    return [failF("mcp.build", "the MCP server is not built", `expected ${binPath}`, "npm run build")];
  }

  // Speak the protocol. This is the only check that proves the harness would
  // get a working server — §9.2's whole point.
  const probe = spawnSync(process.execPath, [binPath], {
    input:
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) + "\n" +
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n",
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env },
  });

  const lines = (probe.stdout ?? "").split("\n").filter(Boolean);
  let toolCount = 0;
  for (const line of lines) {
    try {
      const msg = JSON.parse(line) as { result?: { tools?: unknown[] } };
      if (Array.isArray(msg.result?.tools)) toolCount = msg.result.tools.length;
    } catch { /* not a protocol line */ }
  }

  const ceilingLine = /ceiling "([^"]+)"/.exec(probe.stderr ?? "");
  const ceiling = ceilingLine?.[1] ?? "unknown";

  out.push(
    toolCount === 14
      ? ok("mcp.tools", `MCP server serves ${toolCount} tools at ceiling "${ceiling}"`)
      : failF(
          "mcp.tools", `MCP SERVER SERVED ${toolCount} TOOLS (expected 14)`,
          (probe.stderr ?? "").trim() || "no output on stderr",
          "A harness upgrade that stops reading its registration leaves an EMPTY tool list and no error.\n" +
          "That is why this check asserts the count and the ceiling rather than the config file.",
        ),
  );

  if (harness !== "all") {
    out.push(ok("mcp.harness", `checked as: ${harness}`, `register with: sutra wire ${harness}`));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Skills — "created ≠ wired"
// ─────────────────────────────────────────────────────────────────────────────

function checkSkills(skillsRoot: string): Finding[] {
  if (!existsSync(skillsRoot)) {
    return [warnF("skills", "no skills directory", "Skills are optional.", `expected ${skillsRoot}`)];
  }
  const pub = listSkills(skillsRoot);
  const all = listSkills(skillsRoot, { includeTrusted: true });
  return [ok("skills", `${all.length} skill(s) — ${pub.length} public, ${all.length - pub.length} trusted (never exposed)`)];
}

// ─────────────────────────────────────────────────────────────────────────────
// Providers
// ─────────────────────────────────────────────────────────────────────────────

function checkProviders(vaultRoot: string): Finding[] {
  const health = providerHealth(vaultRoot);
  if (!health.length) {
    return [ok(
      "providers", "no provider calls recorded yet",
      "Sutra works with no provider at all — retrieval, tiering, linking and cited answers\n" +
      "need no key. A model adds prose synthesis on top of them.",
    )];
  }
  const alerts = providerAlerts(health);
  const out: Finding[] = health.map((h) =>
    ok("provider." + h.provider,
      `${h.provider} (${h.task}): ${h.success_rate === null ? "no attributable calls" : `${Math.round(h.success_rate * 100)}% over ${h.ok + h.failed}`}`,
      h.client_side > 0 ? `${h.client_side} client-side fault(s), excluded from the denominator (D19)` : undefined),
  );
  for (const a of alerts) {
    out.push(a.severity === "loud" ? failF("provider.alert", "PROVIDER", a.message) : warnF("provider.alert", "provider", a.message));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// The command
// ─────────────────────────────────────────────────────────────────────────────

export function cmdDoctor(args: ParsedArgs, mode: OutputMode): ExitCode {
  const cfg = loadConfig();
  const harness = flagString(args, "harness") ?? "all";
  const findings: Finding[] = [];

  findings.push(...checkPrereqs());
  findings.push(...checkGate(cfg.installRoot.path, cfg.vaultRoot.path));
  findings.push(...checkVault(cfg.vaultRoot.path, "local_only", cfg.walkRoots));
  findings.push(...checkHarness(harness, cfg.installRoot.path));
  findings.push(...checkSkills(cfg.skillsRoot.path));
  findings.push(...checkProviders(cfg.vaultRoot.path));

  for (const w of cfg.warnings) findings.push(warnF("config", "config", w));

  const failed = findings.filter((f) => f.status === "fail");
  const warned = findings.filter((f) => f.status === "warn");

  emitJson(mode, {
    ok: failed.length === 0,
    counts: { ok: findings.length - failed.length - warned.length, warn: warned.length, fail: failed.length },
    findings,
  });

  if (!mode.json) {
    const groups: Array<[string, string[]]> = [
      ["Prerequisites", ["node", "pwsh", "git", "uv"]],
      ["The gate", ["gate.patterns", "gate.coverage", "gate.false-positives", "gate.floor", "gate.benign", "gate.rescan"]],
      ["Vault", ["vault", "vault.git", "vault.notes", "pipeline.run", "graph", "graph.header", "graph.inputs", "index"]],
      ["Harness wiring", ["mcp.build", "mcp.tools", "mcp.harness"]],
      ["Skills", ["skills"]],
      ["Providers", findings.filter((f) => f.id.startsWith("provider")).map((f) => f.id)],
      ["Config", ["config"]],
    ];
    for (const [title, ids] of groups) {
      const inGroup = findings.filter((f) => ids.includes(f.id));
      if (!inGroup.length) continue;
      heading(mode, title);
      for (const f of inGroup) {
        check(mode, f.status, f.label, f.detail);
        if (f.remedy) say(mode, c.dim(`      → ${f.remedy}`));
      }
    }

    say(mode, "");
    if (failed.length) {
      say(mode, c.red(`${failed.length} failing`) + c.dim(` · ${warned.length} warning(s)`));
      say(mode, c.dim("Anything under `The gate` that is failing is release-blocking. Do not use this install."));
    } else if (warned.length) {
      say(mode, c.green("healthy") + c.dim(` · ${warned.length} warning(s) — all optional capability`));
    } else {
      say(mode, c.green("all checks passed"));
    }
    if (flagBool(args, "heal")) {
      say(mode, "", c.dim("--heal applies only idempotent fixes; nothing above is auto-fixable yet."));
    }
  }

  return failed.length ? EXIT.ERROR : EXIT.OK;
}

/** Exported for `sutra init` step 1, which reuses the same prerequisite probes. */
export { checkPrereqs, type Finding };
