// SPDX-License-Identifier: Apache-2.0
/**
 * The MCP surface's contract tests.
 *
 * The most important one is `no tool accepts a ceiling argument`. It is the
 * structural enforcement of invariant 2, and it is written as a walk over the
 * PUBLISHED SCHEMAS rather than as a review checklist, because the erosion this
 * guards against arrives as a reasonable-sounding feature request, one tool at
 * a time.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createDispatcher, buildTools } from "./server.js";
import { VaultClient, Brain, loadConfig, type SutraConfig } from "@sutra/core";

const EXPECTED_TOOLS = [
  "sutra_whoami",
  "sutra_search",
  "sutra_semantic_search",
  "sutra_ask",
  "sutra_get_note",
  "sutra_read_section",
  "sutra_list_projects",
  "sutra_status",
  "sutra_get_graph",
  "sutra_expand",
  "sutra_can_you_see",
  "sutra_list_skills",
  "sutra_get_skill",
  "sutra_capture",
];

function seed(root: string, rel: string, fm: Record<string, unknown>, body = "body"): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n${body}\n`);
}

function fixtureVault(): string {
  const r = mkdtempSync(join(tmpdir(), "sutra-mcp-"));
  mkdirSync(join(r, "automation", "policies"), { recursive: true });
  seed(r, "vault/public.md", { type: "Note", sensitivity: "public" }, "quantum widgets, publicly known");
  seed(r, "vault/private.md", { type: "Note", sensitivity: "private" }, "quantum widgets PRIVATEPAYLOAD");
  seed(r, "vault/secret.md", { type: "Note", sensitivity: "secret" }, "quantum widgets SECRETPAYLOAD");
  seed(r, "vault/dnl.md", { type: "Note", sensitivity: "public", do_not_learn: true }, "quantum DNLPAYLOAD");
  return r;
}

function testConfig(vaultRoot: string): SutraConfig {
  const base = loadConfig();
  return {
    ...base,
    vaultRoot: { path: vaultRoot, origin: "env", exists: true },
    skillsRoot: { path: join(vaultRoot, "skills"), origin: "default", exists: false },
    warnings: [],
  };
}

function toolsAt(vaultRoot: string, ceiling: "hosted_allowed" | "review_required" | "local_only"): ReturnType<typeof buildTools> {
  const cfg = testConfig(vaultRoot);
  const vc = new VaultClient(vaultRoot);
  return buildTools(cfg, vc, new Brain(vc, ceiling, cfg.walkRoots), []);
}

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT 2 — the model cannot lift the gate
// ─────────────────────────────────────────────────────────────────────────────

test("INVARIANT 2 · NO tool accepts a ceiling, tier, exposure or override argument", () => {
  const forbidden = [
    "exposure", "ceiling", "tier", "sensitivity_ceiling", "override", "passphrase",
    "unlock", "reveal", "trust", "scope", "allow_secret", "include_secret",
    "include_private", "bypass", "ignore_gate", "as_user", "surface", "root", "vault",
  ];
  // `sensitivity` on sutra_capture is legitimate: it can only RAISE (its enum is
  // private|secret and the floor clamps anything else up). It is named here so
  // the exception is deliberate rather than a hole in the loop.
  const allowedException = new Set(["sutra_capture:sensitivity"]);

  for (const tool of toolsAt(fixtureVault(), "hosted_allowed")) {
    const props = (tool.def.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    for (const key of Object.keys(props)) {
      if (allowedException.has(`${tool.def.name}:${key}`)) continue;
      assert.ok(
        !forbidden.includes(key.toLowerCase()),
        `${tool.def.name} publishes an argument named "${key}". The ceiling is read from the ` +
        `environment at startup and must never be reachable from a tool call.`,
      );
    }
  }
});

test("INVARIANT 2 · sutra_capture's `sensitivity` enum cannot express `public`", () => {
  const capture = toolsAt(fixtureVault(), "hosted_allowed").find((t) => t.def.name === "sutra_capture")!;
  const props = (capture.def.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties;
  const values = props["sensitivity"]?.enum ?? [];
  assert.deepEqual(values, ["private", "secret"]);
  assert.ok(!values.includes("public"), "the schema itself must not offer `public`");
});

test("INVARIANT 2 · every gate-touching tool TELLS the model the ceiling is fixed", () => {
  const gateTouching = ["sutra_whoami", "sutra_search", "sutra_semantic_search", "sutra_ask", "sutra_get_note", "sutra_get_graph", "sutra_expand", "sutra_list_projects"];
  for (const tool of toolsAt(fixtureVault(), "hosted_allowed")) {
    if (!gateTouching.includes(tool.def.name)) continue;
    assert.match(
      tool.def.description,
      /CANNOT be changed by any argument/,
      `${tool.def.name}'s description must state that the ceiling is fixed — a model that ` +
      `understands the constraint stops trying to work around it`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// The tool surface
// ─────────────────────────────────────────────────────────────────────────────

test("exactly 14 tools, with the names the plugins and docs promise", () => {
  const names = toolsAt(fixtureVault(), "hosted_allowed").map((t) => t.def.name);
  assert.equal(names.length, 14);
  assert.deepEqual([...names].sort(), [...EXPECTED_TOOLS].sort());
});

test("the deprecated override_unlock tool is NOT present", () => {
  const names = toolsAt(fixtureVault(), "hosted_allowed").map((t) => t.def.name);
  assert.ok(!names.some((n) => n.includes("override") || n.includes("unlock")));
});

test("no tool carries a legacy pre-rename name", () => {
  for (const t of toolsAt(fixtureVault(), "hosted_allowed")) {
    assert.ok(t.def.name.startsWith("sutra_"), `${t.def.name} is not namespaced`);
    assert.ok(!/dimaag|aatma|parvo/i.test(t.def.name));
  }
});

test("exactly one tool is a writer; the other thirteen are read-only", () => {
  const tools = toolsAt(fixtureVault(), "hosted_allowed");
  const writers = tools.filter((t) => t.def.readOnlyHint !== true);
  assert.deepEqual(writers.map((t) => t.def.name), ["sutra_capture"]);
});

test("every tool has a description a model can act on", () => {
  for (const t of toolsAt(fixtureVault(), "hosted_allowed")) {
    assert.ok(t.def.description.length > 80, `${t.def.name}'s description is too thin to route on`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GATE 1 — no payload escapes through ANY tool
// ─────────────────────────────────────────────────────────────────────────────

test("GATE 1 · at a hosted ceiling, no secret or do_not_learn payload escapes ANY tool", async () => {
  const root = fixtureVault();
  const tools = toolsAt(root, "hosted_allowed");
  const forbidden = ["SECRETPAYLOAD", "DNLPAYLOAD", "PRIVATEPAYLOAD"];

  // Argument sets chosen to actively HUNT for each payload.
  const probes: Record<string, Record<string, unknown>> = {
    sutra_search: { query: "quantum widgets", limit: 100 },
    sutra_semantic_search: { query: "quantum widgets" },
    sutra_ask: { question: "what do I know about quantum widgets?" },
    sutra_get_note: { id: "vault/secret.md" },
    sutra_read_section: { id: "vault/secret.md", section: "anything" },
    sutra_expand: { node: "vault/secret.md" },
    sutra_get_skill: { id: "anything" },
    sutra_capture: { text: "probe" },
  };

  for (const tool of tools) {
    const out = JSON.stringify(await tool.handler(probes[tool.def.name] ?? {}));
    for (const payload of forbidden) {
      assert.ok(!out.includes(payload), `${payload} leaked through ${tool.def.name}`);
    }
  }
});

test("GATE 1 · a hybrid search cannot surface what a plain search cannot", async () => {
  const root = fixtureVault();
  const search = toolsAt(root, "hosted_allowed").find((t) => t.def.name === "sutra_search")!;
  const hybrid = JSON.stringify(await search.handler({ query: "quantum widgets", hybrid: true, limit: 100 }));
  for (const p of ["SECRETPAYLOAD", "DNLPAYLOAD", "PRIVATEPAYLOAD"]) {
    assert.ok(!hybrid.includes(p), `${p} leaked through the hybrid path`);
  }
});

test("sutra_can_you_see reports the withheld counts honestly", async () => {
  const out = JSON.stringify(
    await toolsAt(fixtureVault(), "hosted_allowed").find((t) => t.def.name === "sutra_can_you_see")!.handler({}),
  );
  assert.match(out, /Ceiling: public/);
  assert.match(out, /secret: 1/);
  assert.match(out, /do_not_learn: 1/);
  assert.match(out, /private: 1/);
  assert.ok(!out.includes("SECRETPAYLOAD"), "it reports the COUNT, never the content");
});

test("a withheld get_note tells the user the remedy instead of just failing", async () => {
  const out = JSON.stringify(
    await toolsAt(fixtureVault(), "hosted_allowed").find((t) => t.def.name === "sutra_get_note")!.handler({ id: "vault/private.md" }),
  );
  assert.match(out, /withheld/);
  assert.match(out, /sutra review/);
  assert.match(out, /do not attempt another route/i);
});

// ─────────────────────────────────────────────────────────────────────────────
// The write gate
// ─────────────────────────────────────────────────────────────────────────────

test("sutra_capture refuses when SUTRA_MCP_ALLOW_WRITE is unset", async () => {
  const prev = process.env["SUTRA_MCP_ALLOW_WRITE"];
  delete process.env["SUTRA_MCP_ALLOW_WRITE"];
  try {
    const out = JSON.stringify(
      await toolsAt(fixtureVault(), "hosted_allowed").find((t) => t.def.name === "sutra_capture")!.handler({ text: "hello" }),
    );
    assert.match(out, /disabled/);
    assert.match(out, /SUTRA_MCP_ALLOW_WRITE/);
  } finally {
    if (prev !== undefined) process.env["SUTRA_MCP_ALLOW_WRITE"] = prev;
  }
});

test("sutra_capture clamps to private when enabled, and SAYS it clamped", async () => {
  const prev = process.env["SUTRA_MCP_ALLOW_WRITE"];
  process.env["SUTRA_MCP_ALLOW_WRITE"] = "1";
  try {
    const out = JSON.stringify(
      await toolsAt(fixtureVault(), "hosted_allowed").find((t) => t.def.name === "sutra_capture")!
        .handler({ text: "hello", sensitivity: "public" }),
    );
    assert.match(out, /tier \*\*private\*\*/);
    assert.match(out, /clamped up/);
  } finally {
    if (prev === undefined) delete process.env["SUTRA_MCP_ALLOW_WRITE"];
    else process.env["SUTRA_MCP_ALLOW_WRITE"] = prev;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// The JSON-RPC transport
// ─────────────────────────────────────────────────────────────────────────────

test("initialize returns the protocol version and server info", async () => {
  const d = createDispatcher(testConfig(fixtureVault()));
  const r = (await d.handle({ jsonrpc: "2.0", id: 1, method: "initialize" })) as { result: { protocolVersion: string; serverInfo: { name: string } } };
  assert.equal(r.result.protocolVersion, "2024-11-05");
  assert.equal(r.result.serverInfo.name, "sutra");
});

test("tools/list publishes all 14", async () => {
  const d = createDispatcher(testConfig(fixtureVault()));
  const r = (await d.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" })) as { result: { tools: unknown[] } };
  assert.equal(r.result.tools.length, 14);
});

test("an unknown tool is a JSON-RPC error, not a silent empty result", async () => {
  const d = createDispatcher(testConfig(fixtureVault()));
  const r = (await d.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "sutra_nope" } })) as { error: { code: number } };
  assert.equal(r.error.code, -32602);
});

test("a THROWING tool returns isError, not a transport fault", async () => {
  const d = createDispatcher(testConfig(fixtureVault()));
  // Empty text throws inside writeCapture; the model should see it and adapt.
  const prev = process.env["SUTRA_MCP_ALLOW_WRITE"];
  process.env["SUTRA_MCP_ALLOW_WRITE"] = "1";
  try {
    const r = (await d.handle({
      jsonrpc: "2.0", id: 4, method: "tools/call",
      params: { name: "sutra_capture", arguments: { text: "" } },
    })) as { result: { isError?: boolean } };
    assert.equal(r.result.isError, true);
  } finally {
    if (prev === undefined) delete process.env["SUTRA_MCP_ALLOW_WRITE"];
    else process.env["SUTRA_MCP_ALLOW_WRITE"] = prev;
  }
});

test("notifications receive no reply; ping does", async () => {
  const d = createDispatcher(testConfig(fixtureVault()));
  assert.equal(await d.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.ok(await d.handle({ jsonrpc: "2.0", id: 5, method: "ping" }));
});

test("an unknown method is method-not-found", async () => {
  const d = createDispatcher(testConfig(fixtureVault()));
  const r = (await d.handle({ jsonrpc: "2.0", id: 6, method: "resources/list" })) as { error: { code: number } };
  assert.equal(r.error.code, -32601);
});

// ─────────────────────────────────────────────────────────────────────────────
// The ceiling comes from the environment, once
// ─────────────────────────────────────────────────────────────────────────────

test("the ceiling is read from SUTRA_MCP_EXPOSURE at construction", () => {
  const root = fixtureVault();
  const prev = process.env["SUTRA_MCP_EXPOSURE"];
  try {
    process.env["SUTRA_MCP_EXPOSURE"] = "private";
    assert.equal(createDispatcher(testConfig(root)).exposure, "review_required");
    process.env["SUTRA_MCP_EXPOSURE"] = "secret";
    assert.equal(createDispatcher(testConfig(root)).exposure, "local_only");
    delete process.env["SUTRA_MCP_EXPOSURE"];
    assert.equal(createDispatcher(testConfig(root)).exposure, "hosted_allowed", "the default is the SAFEST useful one");
  } finally {
    if (prev === undefined) delete process.env["SUTRA_MCP_EXPOSURE"];
    else process.env["SUTRA_MCP_EXPOSURE"] = prev;
  }
});

test("an UNRECOGNISED ceiling does not become the most permissive one", () => {
  const root = fixtureVault();
  const prev = process.env["SUTRA_MCP_EXPOSURE"];
  try {
    process.env["SUTRA_MCP_EXPOSURE"] = "everything";
    assert.equal(
      createDispatcher(testConfig(root)).exposure,
      "review_required",
      "a typo in a registration must fail toward restriction, never toward exposure",
    );
  } finally {
    if (prev === undefined) delete process.env["SUTRA_MCP_EXPOSURE"];
    else process.env["SUTRA_MCP_EXPOSURE"] = prev;
  }
});
