// SPDX-License-Identifier: Apache-2.0
/**
 * @sutra/dashboard — OPTIONAL. Shape (c) only.
 *
 * A zero-build static UI served by `@sutra/daemon`: the graph explorer, the
 * exposure review queue, and the gate report rendered for a human.
 *
 * ── ZERO BUILD, DELIBERATELY ───────────────────────────────────────────────
 * Plain HTML, CSS and ES modules from `public/`. No bundler, no framework, no
 * transpile step.
 *
 * The reasoning is the same one that keeps `@sutra/mcp` at zero dependencies:
 * this is the surface that renders SECRET-TIER CONTENT to the operator's own
 * screen, and a build pipeline is a supply chain. A dashboard whose source you
 * can read in the browser, with view-source, is one whose behaviour you can
 * verify without trusting a lockfile.
 *
 * ── THE 13 LEGACY ROUTES ARE NOT HERE ──────────────────────────────────────
 * The upstream dashboard accumulated thirteen routes unreachable from its own
 * navigation, and §3.6 drops them. A route with no caller is not a feature; it
 * is an attack surface nobody is looking at. "Created ≠ wired" (§9.1) applies
 * to HTTP endpoints exactly as it does to scripts and scheduled jobs.
 */

export interface DashboardRoute {
  path: string;
  /** EVERY route is reachable from the navigation. There are no orphans. */
  navLabel: string;
  /** Refused outright on a network bind, regardless of authentication. */
  loopbackOnly: boolean;
  description: string;
}

/**
 * The complete route table. If it is not here, it is not served.
 *
 * `dashboard.test.ts` asserts every route carries a nav label, so a route
 * cannot be added without also being reachable — which is the mechanical form
 * of "created ≠ wired".
 */
export const ROUTES: readonly DashboardRoute[] = [
  { path: "/",       navLabel: "Gate",   loopbackOnly: false, description: "What can your AI see? The visible and withheld counts, by tier." },
  { path: "/search", navLabel: "Search", loopbackOnly: false, description: "Search and read, at the daemon's own ceiling." },
  { path: "/graph",  navLabel: "Graph",  loopbackOnly: false, description: "The knowledge graph, gated per node." },
  { path: "/review", navLabel: "Review", loopbackOnly: true,  description: "Pending exposure requests. Granting one is a governance act, so it is loopback-only." },
  { path: "/reveal", navLabel: "Reveal", loopbackOnly: true,  description: "Break-glass secret reveal. Loopback-only, passphrase-gated, audited, single-use." },
  { path: "/status", navLabel: "Status", loopbackOnly: false, description: "Pipeline health: what ran, what was skipped, and why." },
];

/** The routes served at this bind. The control plane is withheld remotely. */
export function routesFor(opts: { loopback: boolean }): DashboardRoute[] {
  return ROUTES.filter((r) => opts.loopback || !r.loopbackOnly);
}
