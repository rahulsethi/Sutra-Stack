// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { ROUTES, routesFor } from "./index.js";

test("§9.1 · every route is reachable from the navigation — no orphans", () => {
  // The upstream dashboard accumulated 13 routes unreachable from its own nav.
  // "Created ≠ wired" applies to HTTP endpoints too: a route with no caller is
  // an attack surface nobody is looking at.
  for (const r of ROUTES) {
    assert.ok(r.navLabel.length > 0, `${r.path} has no nav label, so nothing links to it`);
    assert.ok(r.description.length > 20, `${r.path} has no description`);
  }
});

test("the control plane is WITHHELD on a network bind", () => {
  const remote = routesFor({ loopback: false }).map((r) => r.path);
  assert.ok(!remote.includes("/reveal"), "secret reveal must never be served over a network bind");
  assert.ok(!remote.includes("/review"), "granting an exposure is a governance act — loopback only");
  assert.ok(remote.includes("/"), "the gate report is safe to serve remotely");
});

test("loopback serves everything", () => {
  assert.equal(routesFor({ loopback: true }).length, ROUTES.length);
});

test("D29 · every route the UI claims to show is in the served table", () => {
  // The upstream run manifest was unreachable from the dashboard BY
  // CONSTRUCTION: `last-run` was missing from a four-name allowlist, so the UI
  // linked to something its own API would never return. Assert the nav and the
  // route table are the same set.
  const navPaths = new Set(ROUTES.filter((r) => r.navLabel).map((r) => r.path));
  const servedLoopback = new Set(routesFor({ loopback: true }).map((r) => r.path));
  assert.deepEqual([...navPaths].sort(), [...servedLoopback].sort());
});
