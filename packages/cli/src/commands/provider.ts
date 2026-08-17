// SPDX-License-Identifier: Apache-2.0
/**
 * `sutra provider` — BRING YOUR OWN MODEL.
 *
 * Add any OpenAI-compatible endpoint, point it at your own key, and use it from
 * the pipeline or from a specific surface. Nothing here is Sutra-specific: if it
 * speaks `/v1/chat/completions`, it works.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * SUTRA NEVER STORES YOUR API KEY
 * ══════════════════════════════════════════════════════════════════════════
 * The router config records the NAME of an environment variable — `key_env` —
 * and never the value. `sutra provider add` writes `"key_env": "MY_KEY"` and
 * then tells you how to set `MY_KEY`; it does not offer to hold it for you.
 *
 * That is not squeamishness, it is arithmetic. A key written into a config file
 * inside a git repository is a key that gets committed, and re-tiering a
 * committed credential is containment, not remedy — the cleartext stays in
 * history and only rotation fixes it. The cheapest way to never need that
 * conversation is to have no file for the key to live in.
 *
 * `sutra provider key <id>` prints the exact command for your platform, and
 * `sutra provider list` shows which variables are set WITHOUT printing a single
 * character of any of them.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE GATE STILL DECIDES, AND `local` IS THE FIELD THAT MATTERS
 * ══════════════════════════════════════════════════════════════════════════
 * `"local": false` means the model runs on someone else's computer. Such a
 * provider is structurally ineligible for `private` and `secret` content — the
 * router filters by tier BEFORE it considers capability, cost or availability,
 * and no fallback re-admits what the tier filter excluded.
 *
 * So adding a hosted provider cannot widen exposure. It adds an option for
 * `public` work and nothing else. There is no flag on this command that changes
 * that, which is the point.
 *
 * ── D5 · a provider whose key the scanner cannot see ───────────────────────
 * Adding a provider WITHOUT teaching the secret scanner its key shape creates a
 * credential that can be committed silently. `add` therefore checks
 * `secret-patterns.json` for a rule covering the new provider and WARNS,
 * loudly, when there is none — with the JSON to paste.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadConfig,
  providerHealth,
  coerceTier,
  TIER_DISPLAY,
  type Tier,
} from "@sutra/aatma-core";
import { EXIT, type ExitCode, SutraError } from "../exit.js";
import { say, emitJson, heading, check, c, type OutputMode } from "../output.js";
import { flagString, flagBool, type ParsedArgs } from "../args.js";

const ROUTER_REL = join("automation", "policies", "provider-router.json");
const PATTERNS_REL = join("automation", "policies", "secret-patterns.json");

interface ProviderEntry {
  id: string;
  kind?: string;
  local?: boolean;
  enabled?: boolean;
  model?: string;
  base_url?: string;
  base_url_env?: string;
  key_env?: string;
  reasoning_capable?: boolean;
  excluded_tasks?: string[];
  [k: string]: unknown;
}

interface RouterConfig {
  version?: number;
  providers?: ProviderEntry[];
  tasks?: Record<string, unknown>;
  [k: string]: unknown;
}

function routerPath(installRoot: string): string {
  return join(installRoot, ROUTER_REL);
}

function readRouter(installRoot: string): RouterConfig {
  const p = routerPath(installRoot);
  if (!existsSync(p)) {
    throw new SutraError(
      `no provider router config at ${p}`,
      EXIT.ERROR,
      "This ships with Sutra. If it is missing, the install is incomplete — re-run `npm run build`.",
    );
  }
  try {
    return JSON.parse(readFileSync(p, "utf8")) as RouterConfig;
  } catch (e) {
    throw new SutraError(
      `provider router config is not valid JSON: ${p}`,
      EXIT.ERROR,
      `Fix the syntax by hand. ${(e as Error).message}`,
    );
  }
}

/**
 * Write the config back, preserving the `$comment` blocks.
 *
 * Those comments carry the reasons the file is shaped as it is. A rewriter that
 * strips them leaves the next reader with rules and no rationale, which is how a
 * rule gets "simplified" into a defect.
 */
function writeRouter(installRoot: string, cfg: RouterConfig): void {
  writeFileSync(routerPath(installRoot), JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

/** Is this variable set to something non-empty? The VALUE is never returned. */
function keyIsSet(name: string | undefined): boolean {
  if (!name) return true; // a provider needing no key is configured by definition
  const v = process.env[name];
  return typeof v === "string" && v.trim() !== "";
}

/** The highest tier a provider may ever be handed. */
function eligibleCeiling(p: ProviderEntry): Tier {
  return coerceTier(p.local === true ? "local_only" : "hosted_allowed");
}

/** Does the secret scanner know a shape for this provider's keys? (D5) */
function scannerKnows(installRoot: string, providerId: string, keyEnv?: string): boolean {
  const p = join(installRoot, PATTERNS_REL);
  if (!existsSync(p)) return false;
  let text: string;
  try {
    text = readFileSync(p, "utf8");
  } catch {
    return false;
  }
  const needles = [providerId, keyEnv?.replace(/_API_KEY$|_KEY$|_TOKEN$/, "")].filter(
    (x): x is string => typeof x === "string" && x.length > 2,
  );
  return needles.some((n) => new RegExp(n.replace(/[^\w]/g, ".?"), "i").test(text));
}

/** Per-platform instructions for setting one environment variable, persistently. */
function keyInstructions(name: string): string[] {
  if (process.platform === "win32") {
    return [
      `  # PowerShell — this session only`,
      `  $env:${name} = "<paste your key>"`,
      ``,
      `  # PowerShell — persistent, for your user`,
      `  [Environment]::SetEnvironmentVariable("${name}", "<paste your key>", "User")`,
      `  # then open a NEW terminal — an existing one keeps the old environment`,
    ];
  }
  const rc = process.platform === "darwin" ? "~/.zshrc" : "~/.bashrc";
  return [
    `  # this session only`,
    `  export ${name}="<paste your key>"`,
    ``,
    `  # persistent`,
    `  echo 'export ${name}="<paste your key>"' >> ${rc}`,
    `  #  …then: source ${rc}`,
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// list
// ─────────────────────────────────────────────────────────────────────────────

function cmdList(installRoot: string, vaultRoot: string, mode: OutputMode): ExitCode {
  const cfg = readRouter(installRoot);
  const providers = cfg.providers ?? [];
  const health = providerHealth(vaultRoot);

  const rows = providers.map((p) => {
    const set = keyIsSet(p.key_env);
    const h = health.find((x) => x.provider === p.id);
    return {
      id: p.id,
      enabled: p.enabled !== false,
      local: p.local === true,
      model: p.model ?? null,
      max_tier: TIER_DISPLAY[eligibleCeiling(p)],
      key_env: p.key_env ?? null,
      // WHETHER it is set. Never what it is set to.
      key_configured: set,
      reasoning_capable: p.reasoning_capable === true,
      success_rate: h?.success_rate ?? null,
      // `null`, not `false`, when there is no key at all. A local model with no
      // credential has no key shape to know, and reporting that as a gap is the
      // kind of noise that trains people to skim past the real one.
      scanner_knows_key_shape: p.key_env ? scannerKnows(installRoot, p.id, p.key_env) : null,
    };
  });

  emitJson(mode, { providers: rows, config: routerPath(installRoot) });
  if (mode.json) return EXIT.OK;

  heading(mode, "Providers");
  if (rows.length === 0) {
    say(
      mode,
      c.dim("  none configured."),
      "",
      c.dim("  That is a supported state, not a broken one: retrieval, tiering, linking, the graph"),
      c.dim("  and CITED ANSWERS all work with no model at all. A model adds prose on top."),
      "",
      c.dim("  sutra provider add --id my-model --base-url https://... --key-env MY_KEY"),
    );
    return EXIT.OK;
  }

  for (const r of rows) {
    const status = !r.enabled ? "warn" : r.key_configured ? "ok" : "warn";
    const bits: string[] = [];
    bits.push(r.local ? "local" : "hosted");
    bits.push(`max tier: ${r.max_tier}`);
    if (r.model) bits.push(r.model);
    if (!r.enabled) bits.push("DISABLED in policy");
    else if (!r.key_configured) bits.push(`${r.key_env} NOT SET`);
    if (r.success_rate !== null) bits.push(`${Math.round(r.success_rate * 100)}% ok`);
    check(mode, status, r.id, bits.join(" · "));

    if (r.enabled && !r.key_configured && r.key_env) {
      say(mode, c.dim(`         sutra provider key ${r.id}   → how to set ${r.key_env}`));
    }
    if (r.scanner_knows_key_shape === false) {
      say(
        mode,
        c.yellow(`         the secret scanner has no rule for ${r.id}'s key shape`),
        c.dim(`         → a key for this provider could be committed unnoticed (see: sutra provider add --help)`),
      );
    }
  }

  say(
    mode,
    "",
    c.dim(`  config: ${routerPath(installRoot)}`),
    c.dim("  hosted providers are ineligible for private and secret content — the gate filters by"),
    c.dim("  tier before anything else, and no fallback re-admits what it excluded."),
  );
  return EXIT.OK;
}

// ─────────────────────────────────────────────────────────────────────────────
// add
// ─────────────────────────────────────────────────────────────────────────────

function cmdAdd(installRoot: string, args: ParsedArgs, mode: OutputMode): ExitCode {
  const id = flagString(args, "id");
  if (!id) {
    throw new SutraError("--id is required", EXIT.USAGE, [
      "sutra provider add --id <name> [options]",
      "",
      "  --base-url <url>     the OpenAI-compatible endpoint (omit for a local Ollama default)",
      "  --key-env <VAR>      the environment variable holding the key. NOT the key itself.",
      "  --model <name>       the model id to request",
      "  --local              this model runs on THIS machine (eligible for private content)",
      "  --reasoning          the model is capable enough for reasoning tasks",
      "  --enable             enable it immediately (default: added disabled, so you can review)",
    ].join("\n"));
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new SutraError(
      `provider id "${id}" is not usable`,
      EXIT.USAGE,
      "Use lowercase letters, digits and hyphens. The id appears in logs, metrics and page frontmatter.",
    );
  }

  const cfg = readRouter(installRoot);
  cfg.providers = cfg.providers ?? [];
  if (cfg.providers.some((p) => p.id === id)) {
    throw new SutraError(
      `a provider named "${id}" already exists`,
      EXIT.ERROR,
      `Edit ${routerPath(installRoot)} directly, or choose another id.`,
    );
  }

  const local = flagBool(args, "local");
  const keyEnv = flagString(args, "key-env");
  const baseUrl = flagString(args, "base-url");

  if (!local && !keyEnv) {
    throw new SutraError(
      "a hosted provider needs --key-env",
      EXIT.USAGE,
      "Name the ENVIRONMENT VARIABLE that will hold the key — e.g. --key-env MY_PROVIDER_API_KEY.\n" +
      "  Sutra never stores the key itself: a key in a config file inside a git repo is a key that\n" +
      "  gets committed, and only rotation fixes that afterwards.",
    );
  }

  // Refuse a key VALUE passed where a variable NAME belongs. This is the single
  // most likely way someone puts a live credential into a tracked file, and the
  // shape is unmistakable.
  if (keyEnv && /^(sk-|gsk_|AIza|hf_|nvapi-|github_pat_|xoxb-)/i.test(keyEnv)) {
    throw new SutraError(
      "--key-env looks like an API KEY, not a variable name",
      EXIT.ERROR,
      "Pass the NAME of an environment variable (e.g. MY_PROVIDER_API_KEY), never the key.\n" +
      "  If you have already pasted that key anywhere tracked by git, ROTATE IT — re-tiering or\n" +
      "  deleting the line is containment, not remedy; the cleartext stays in history.",
    );
  }

  const entry: ProviderEntry = {
    id,
    kind: flagString(args, "kind") ?? "openai-compatible",
    local,
    // Added DISABLED by default. A provider that starts serving traffic the
    // instant it is added gives you no moment to read what you just wrote.
    enabled: flagBool(args, "enable"),
    reasoning_capable: flagBool(args, "reasoning"),
  };
  if (flagString(args, "model")) entry.model = flagString(args, "model");
  if (baseUrl) entry.base_url = baseUrl;
  else if (local) entry.base_url = "http://127.0.0.1:11434/v1";
  if (keyEnv) entry.key_env = keyEnv;

  cfg.providers.push(entry);
  writeRouter(installRoot, cfg);

  emitJson(mode, { added: entry, config: routerPath(installRoot) });
  if (mode.json) return EXIT.OK;

  heading(mode, `Added provider "${id}"`);
  check(mode, "ok", "written to", routerPath(installRoot));
  check(
    mode,
    "ok",
    "max tier",
    `${TIER_DISPLAY[eligibleCeiling(entry)]} — ${
      local
        ? "a local model may be handed private content"
        : "a HOSTED model is structurally ineligible for private and secret content"
    }`,
  );
  check(
    mode,
    entry.enabled ? "ok" : "warn",
    "enabled",
    entry.enabled ? "yes" : "no — added disabled so you can review it. Set `\"enabled\": true` or re-run with --enable",
  );

  if (keyEnv) {
    say(mode, "", c.bold(`  Set the key — Sutra does not store it:`), "");
    for (const line of keyInstructions(keyEnv)) say(mode, line);
  }

  // D5 · the scanner must know this provider's key shape.
  if (!scannerKnows(installRoot, id, keyEnv)) {
    say(
      mode,
      "",
      c.yellow("  THE SECRET SCANNER HAS NO RULE FOR THIS PROVIDER'S KEY SHAPE."),
      "",
      c.dim("  A configurable provider whose key the scanner cannot recognise is a credential that can"),
      c.dim("  be committed silently. Add a rule to automation/policies/secret-patterns.json — that one"),
      c.dim("  file is read by the classifier, the commit hook and the leak scan, so one entry covers"),
      c.dim("  every path. Every rule ships with a fixture it must match, asserted in CI:"),
      "",
      c.dim(`    {`),
      c.dim(`      "id": "${id}-key",`),
      c.dim(`      "band": "definite",`),
      c.dim(`      "provider": "${id}",`),
      c.dim(`      "pattern": "<a regex matching this provider's key shape>",`),
      c.dim(`      "fixture": "<a NON-REAL string that the pattern above matches>",`),
      c.dim(`      "description": "${id} API key"`),
      c.dim(`    }`),
      "",
      c.dim("  Then: npm run test:ps  &&  npm test"),
    );
  }

  say(mode, "", c.dim("  Verify:  sutra provider list   then   sutra provider test " + id));
  return EXIT.OK;
}

// ─────────────────────────────────────────────────────────────────────────────
// key
// ─────────────────────────────────────────────────────────────────────────────

function cmdKey(installRoot: string, args: ParsedArgs, mode: OutputMode): ExitCode {
  const id = args.positional[1];
  if (!id) throw new SutraError("which provider?", EXIT.USAGE, "sutra provider key <id>");

  const cfg = readRouter(installRoot);
  const p = (cfg.providers ?? []).find((x) => x.id === id);
  if (!p) {
    throw new SutraError(`no provider named "${id}"`, EXIT.USAGE, "sutra provider list");
  }
  if (!p.key_env) {
    emitJson(mode, { id, key_env: null, configured: true });
    say(mode, "", `  "${id}" needs no key (${p.local ? "it runs locally" : "no key_env is configured"}).`);
    return EXIT.OK;
  }

  const set = keyIsSet(p.key_env);
  emitJson(mode, { id, key_env: p.key_env, configured: set });
  if (mode.json) return EXIT.OK;

  heading(mode, `Key for "${id}"`);
  check(mode, set ? "ok" : "warn", p.key_env, set ? "set" : "NOT SET");
  if (!set) {
    say(mode, "");
    for (const line of keyInstructions(p.key_env)) say(mode, line);
  }
  say(
    mode,
    "",
    c.dim("  Sutra reads this variable and never writes it anywhere. `sutra provider list` reports"),
    c.dim("  WHETHER it is set and never its value; no Sutra command prints a key."),
  );

  // The other place a key can live: a harness's own registration.
  say(
    mode,
    "",
    c.bold("  Per-surface keys"),
    c.dim("  To give ONE surface its own model and key, put the variable in that surface's MCP"),
    c.dim("  registration instead of your shell — `sutra wire <harness>` writes that block:"),
    "",
    c.dim(`    "env": {`),
    c.dim(`      "SUTRA_MCP_EXPOSURE": "public",`),
    c.dim(`      "${p.key_env}": "<the key for this surface>"`),
    c.dim(`    }`),
    "",
    c.dim("  Each surface then carries its own key AND its own ceiling, set at startup and not"),
    c.dim("  changeable by the model on the other side."),
  );
  return EXIT.OK;
}

// ─────────────────────────────────────────────────────────────────────────────
// test
// ─────────────────────────────────────────────────────────────────────────────

async function cmdTest(installRoot: string, args: ParsedArgs, mode: OutputMode): Promise<ExitCode> {
  const id = args.positional[1];
  if (!id) throw new SutraError("which provider?", EXIT.USAGE, "sutra provider test <id>");

  const cfg = readRouter(installRoot);
  const p = (cfg.providers ?? []).find((x) => x.id === id);
  if (!p) throw new SutraError(`no provider named "${id}"`, EXIT.USAGE, "sutra provider list");

  // Each of these is a DIFFERENT answer with a different remedy. Collapsing them
  // into one boolean is how "rotation looks like resilience": every request
  // burning attempts on providers that were never going to work.
  type Status = "ok" | "disabled" | "unconfigured" | "unreachable" | "rejected" | "no_base_url";
  let status: Status;
  let detail: string;

  if (p.enabled === false) {
    status = "disabled";
    detail = `"${id}" is disabled in policy. Set "enabled": true in ${ROUTER_REL}.`;
  } else if (!keyIsSet(p.key_env)) {
    status = "unconfigured";
    detail = `${p.key_env} is not set. This is NOT a provider failure — it is a missing key. \`sutra provider key ${id}\``;
  } else {
    const base = p.base_url_env ? process.env[p.base_url_env] : p.base_url;
    if (!base) {
      status = "no_base_url";
      detail = "no base_url and no base_url_env. Nothing to probe.";
    } else {
      const url = base.replace(/\/+$/, "") + "/models";
      const headers: Record<string, string> = { accept: "application/json" };
      if (p.key_env && process.env[p.key_env]) headers["authorization"] = `Bearer ${process.env[p.key_env]}`;
      try {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 10_000);
        const res = await fetch(url, { headers, signal: ac.signal });
        clearTimeout(t);
        if (res.ok) {
          status = "ok";
          detail = `${url} answered ${res.status}`;
        } else {
          // A 401/403 is the endpoint working and the key being wrong. That is a
          // materially different problem from the endpoint being down.
          status = "rejected";
          detail =
            `${url} answered ${res.status}. The endpoint is reachable; the credential or the ` +
            `permission is the problem — not the network.`;
        }
      } catch (e) {
        status = "unreachable";
        detail = `${url} could not be reached: ${(e as Error).message}`;
      }
    }
  }

  emitJson(mode, { id, status, detail, local: p.local === true, max_tier: TIER_DISPLAY[eligibleCeiling(p)] });
  // NOTE ON THE EXIT CODE. Sutra's exit codes are a fixed governance vocabulary,
  // and none of them means "degraded" — so every non-ok probe exits ERROR.
  //
  // The D16 distinction that actually matters (unconfigured is NOT a provider
  // failure) is carried by `status`, which is in the JSON and in the printed
  // line. It must never be collapsed THERE: a missing key and a dead endpoint
  // have different remedies, and one boolean cannot carry a remedy.
  if (mode.json) return status === "ok" ? EXIT.OK : EXIT.ERROR;

  heading(mode, `Probe "${id}"`);
  check(mode, status === "ok" ? "ok" : status === "disabled" ? "warn" : "fail", status, detail);
  say(
    mode,
    "",
    c.dim(`  max tier: ${TIER_DISPLAY[eligibleCeiling(p)]} — ` +
      (p.local === true
        ? "local, so private content may be routed here"
        : "hosted, so private and secret content never will be")),
  );
  if (status !== "ok") {
    say(
      mode,
      "",
      c.dim("  This probe lists models; it does not run a completion. A reachable endpoint that"),
      c.dim("  refuses generation still shows here as ok — `sutra ask` is the end-to-end check."),
    );
  }
  return status === "ok" ? EXIT.OK : EXIT.ERROR;
}

// ─────────────────────────────────────────────────────────────────────────────

export async function cmdProvider(args: ParsedArgs, mode: OutputMode): Promise<ExitCode> {
  const cfg = loadConfig();
  const installRoot = cfg.installRoot.path;
  const sub = args.positional[0] ?? "list";

  switch (sub) {
    case "list":
      return cmdList(installRoot, cfg.vaultRoot.path, mode);
    case "add":
      return cmdAdd(installRoot, args, mode);
    case "key":
      return cmdKey(installRoot, args, mode);
    case "test":
      return await cmdTest(installRoot, args, mode);
    default:
      throw new SutraError(
        `unknown subcommand "${sub}"`,
        EXIT.USAGE,
        "sutra provider list | add | key <id> | test <id>",
      );
  }
}
