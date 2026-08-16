// SPDX-License-Identifier: Apache-2.0
/**
 * @sutra/daemon — OPTIONAL. Shape (c) only.
 *
 * A loopback HTTP surface over the same gate, for the graph explorer, the
 * review queue and secret reveal.
 *
 * ── DELETING THIS PACKAGE MUST BREAK NOTHING ───────────────────────────────
 * Release gate 5: "Uninstalling the daemon/dashboard breaks nothing in shapes
 * (a) and (b)."
 *
 *   shape (a)  the CLI, with no daemon, no harness, no accounts, no keys and
 *              no network
 *   shape (b)  (a) plus the MCP server, plugged into a harness
 *
 * Neither imports anything from here, and nothing here is required to answer a
 * question. That is why this is a SEPARATE PACKAGE rather than a flag on the
 * CLI: a flag would let the dependency creep back in, one import at a time,
 * until "optional" was only true in the documentation.
 */
export * from "./bind.js";
