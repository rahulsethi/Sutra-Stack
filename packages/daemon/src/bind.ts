// SPDX-License-Identifier: Apache-2.0
/**
 * THE BIND POLICY — lifted from `aatma/src/auth.ts`.
 *
 * 00-MASTER-BUILD-BRIEF.md §7 M6's verify names this specifically:
 * *"`assertBindPolicy` still refuses a non-loopback bind with no secret and no
 * TLS."* It is the one part of the optional daemon that is not optional.
 *
 * ── WHY A DAEMON NEEDS ITS OWN GATE AT ALL ─────────────────────────────────
 * The tier gate answers "may this content reach this destination?". It cannot
 * answer "is this destination who they claim to be?", and an HTTP surface makes
 * that second question suddenly load-bearing: a `local_only` ceiling on a
 * loopback socket is a person reading their own screen, and the identical
 * ceiling on `0.0.0.0` is the whole vault published to the network.
 *
 * Same ceiling. Completely different meaning. So the bind host is a governance
 * input, not a deployment detail.
 *
 * ── NO LOOPBACK-TRUST TRAP ─────────────────────────────────────────────────
 * A non-loopback bind does not merely add authentication. The control plane and
 * the secret-reveal path stay WITHHELD REMOTELY, and they key off THE BIND
 * HOST, not off the client's address.
 *
 * That distinction matters: keying off the client address would mean anything
 * that can make a request appear to originate locally — a proxy, an SSRF, a
 * container's network namespace — inherits full trust. Keying off the bind host
 * means a daemon that was started listening on a network interface never grants
 * that trust to anyone, including a genuinely local client.
 */

export interface DaemonSecurity {
  host: string;
  /** From the environment, never from a config file. A secret in a file gets committed. */
  secret: string | null;
  tlsCert: string | null;
  tlsKey: string | null;
  /**
   * Explicitly accept an unencrypted non-loopback bind.
   *
   * There is a legitimate case — a WireGuard or Tailscale interface already
   * encrypts the link, so requiring TLS on top is ceremony. But it must be
   * SAID, because the same flag is what someone reaches for when they just want
   * the error to go away.
   */
  allowInsecure: boolean;
}

/** Every spelling of "this machine only". */
export function isLoopback(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "127.0.0.1" || h === "::1" || h === "localhost" || h.startsWith("127.");
}

/**
 * Refuse to start under an unsafe bind.
 *
 * THROWS rather than warning. A daemon that warns and starts anyway has
 * published the vault; the warning scrolls past in a service log nobody reads,
 * and the failure is silent from the operator's point of view.
 */
export function assertBindPolicy(sec: DaemonSecurity): void {
  if (isLoopback(sec.host)) return;

  if (!sec.secret) {
    throw new Error(
      `Refusing to start: host '${sec.host}' is not loopback and SUTRA_DAEMON_SECRET is not set.\n` +
      `  A non-loopback bind publishes this vault to the network. Set a secret, or bind to 127.0.0.1.`,
    );
  }

  const hasTls = Boolean(sec.tlsCert && sec.tlsKey);
  if (!hasTls && !sec.allowInsecure) {
    throw new Error(
      `Refusing to start: host '${sec.host}' is not loopback and TLS is not configured.\n` +
      `  Provide tls_cert and tls_key, or set allow_insecure=true if the link is already encrypted\n` +
      `  (a WireGuard or Tailscale interface, for instance). Say it deliberately — this flag is also\n` +
      `  what someone reaches for when they just want the error to go away.`,
    );
  }
}

/**
 * The read ceiling for an HTTP request.
 *
 * ── THE KEY PROPERTY: IT KEYS OFF THE BIND HOST ───────────────────────────
 * Not off the client's address. A daemon listening on a network interface never
 * grants secret-tier reads to anyone, including a client connecting from
 * 127.0.0.1 — because "the request appears to come from localhost" is a
 * property an attacker can arrange (a proxy, an SSRF, a shared network
 * namespace) and "the operator started this bound to loopback" is not.
 */
export function resolveReadCeiling(sec: DaemonSecurity, opts: { overrideAttempted?: boolean } = {}):
  { ceiling: "local_only" | "review_required" | "hosted_allowed"; reason: string } {

  if (!isLoopback(sec.host)) {
    // REMOTE. Secret is unreachable, and an override does not change that.
    return {
      ceiling: opts.overrideAttempted ? "review_required" : "hosted_allowed",
      reason:
        `bound to '${sec.host}' (not loopback). Secret-tier content is never served over a network ` +
        `bind, and an override cannot raise it — the ceiling keys off the BIND HOST, not the client, ` +
        `so an address that merely appears local grants nothing.`,
    };
  }

  return {
    ceiling: opts.overrideAttempted ? "local_only" : "review_required",
    reason: opts.overrideAttempted
      ? "loopback bind with a verified override — a direct render to the operator's own screen, no model in the loop."
      : "loopback bind. Private content is served; secret requires an explicit, audited override.",
  };
}

/** Build the security posture from the environment. The secret NEVER comes from a file. */
export function securityFromEnv(env: NodeJS.ProcessEnv = process.env): DaemonSecurity {
  return {
    host: env["SUTRA_DAEMON_HOST"] ?? "127.0.0.1",
    secret: env["SUTRA_DAEMON_SECRET"] ?? null,
    tlsCert: env["SUTRA_DAEMON_TLS_CERT"] ?? null,
    tlsKey: env["SUTRA_DAEMON_TLS_KEY"] ?? null,
    allowInsecure: env["SUTRA_DAEMON_ALLOW_INSECURE"] === "true",
  };
}
