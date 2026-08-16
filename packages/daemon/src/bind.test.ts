// SPDX-License-Identifier: Apache-2.0
/**
 * M6's verify: "assertBindPolicy still refuses a non-loopback bind with no
 * secret and no TLS."
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertBindPolicy, isLoopback, resolveReadCeiling, securityFromEnv, type DaemonSecurity } from "./bind.js";

const sec = (over: Partial<DaemonSecurity> = {}): DaemonSecurity => ({
  host: "127.0.0.1", secret: null, tlsCert: null, tlsKey: null, allowInsecure: false, ...over,
});

test("every spelling of loopback is recognised", () => {
  for (const h of ["127.0.0.1", "::1", "[::1]", "localhost", "LOCALHOST", "127.1.2.3"]) {
    assert.equal(isLoopback(h), true, h);
  }
  for (const h of ["0.0.0.0", "192.168.1.10", "10.0.0.1", "example.invalid", "100.64.0.1"]) {
    assert.equal(isLoopback(h), false, h);
  }
});

test("a loopback bind needs no secret and no TLS", () => {
  assert.doesNotThrow(() => assertBindPolicy(sec()));
});

test("M6 · a non-loopback bind with NO SECRET is REFUSED", () => {
  assert.throws(() => assertBindPolicy(sec({ host: "0.0.0.0" })), /not loopback and SUTRA_DAEMON_SECRET is not set/);
});

test("M6 · a non-loopback bind with a secret but NO TLS is REFUSED", () => {
  assert.throws(() => assertBindPolicy(sec({ host: "0.0.0.0", secret: "s" })), /TLS is not configured/);
});

test("a non-loopback bind with a secret and TLS is allowed", () => {
  assert.doesNotThrow(() => assertBindPolicy(sec({ host: "0.0.0.0", secret: "s", tlsCert: "c", tlsKey: "k" })));
});

test("allow_insecure permits an unencrypted network bind — but ONLY with a secret", () => {
  assert.doesNotThrow(() => assertBindPolicy(sec({ host: "0.0.0.0", secret: "s", allowInsecure: true })));
  // The flag does not substitute for the secret. Someone reaching for it to
  // silence an error must not thereby disable authentication too.
  assert.throws(() => assertBindPolicy(sec({ host: "0.0.0.0", allowInsecure: true })), /SUTRA_DAEMON_SECRET/);
});

test("HALF-configured TLS is refused — a cert with no key is not TLS", () => {
  assert.throws(() => assertBindPolicy(sec({ host: "0.0.0.0", secret: "s", tlsCert: "c" })), /TLS is not configured/);
  assert.throws(() => assertBindPolicy(sec({ host: "0.0.0.0", secret: "s", tlsKey: "k" })), /TLS is not configured/);
});

test("the ceiling keys off the BIND HOST, never the client", () => {
  // The property that closes the loopback-trust trap: an address that merely
  // APPEARS local — via a proxy, an SSRF, a shared network namespace — grants
  // nothing, because the decision was made when the daemon started.
  const remote = resolveReadCeiling(sec({ host: "0.0.0.0", secret: "s", tlsCert: "c", tlsKey: "k" }));
  assert.equal(remote.ceiling, "hosted_allowed");
  assert.match(remote.reason, /BIND HOST, not the client/);

  const local = resolveReadCeiling(sec());
  assert.equal(local.ceiling, "review_required");
});

test("an override raises the ceiling on loopback, and CANNOT on a network bind", () => {
  assert.equal(resolveReadCeiling(sec(), { overrideAttempted: true }).ceiling, "local_only");
  assert.equal(
    resolveReadCeiling(sec({ host: "0.0.0.0", secret: "s", tlsCert: "c", tlsKey: "k" }), { overrideAttempted: true }).ceiling,
    "review_required",
    "secret content must never be served over a network bind, override or not",
  );
});

test("the secret comes from the environment, never a config file", () => {
  const s = securityFromEnv({ SUTRA_DAEMON_SECRET: "from-env", SUTRA_DAEMON_HOST: "0.0.0.0" });
  assert.equal(s.secret, "from-env");
  assert.equal(s.host, "0.0.0.0");
  assert.equal(securityFromEnv({}).host, "127.0.0.1", "the default bind is loopback");
  assert.equal(securityFromEnv({}).secret, null);
});

test("allowInsecure requires the literal string 'true'", () => {
  assert.equal(securityFromEnv({ SUTRA_DAEMON_ALLOW_INSECURE: "1" }).allowInsecure, false);
  assert.equal(securityFromEnv({ SUTRA_DAEMON_ALLOW_INSECURE: "yes" }).allowInsecure, false);
  assert.equal(securityFromEnv({ SUTRA_DAEMON_ALLOW_INSECURE: "true" }).allowInsecure, true);
});
