<!-- SPDX-License-Identifier: LicenseRef-Sutra-Commercial -->
# Sutra Enterprise Edition

> **This subtree is not open source.** See [`LICENSE`](LICENSE). Everything
> outside `ee/` is Apache-2.0 and unaffected by anything in here.

---

## `rm -rf ee/` is a supported operation

Delete this directory and you have a complete, fully-tested, Apache-2.0 product.
CI proves it on **every commit** — `scripts/check-core-alone.mjs` stages a copy
of the tree, deletes `ee/`, installs, builds, and runs the entire Core test
suite. It also greps Core's source for any import pointing back here.

The dependency arrow points one way: `ee → core`, never `core → ee`.

If you are evaluating Sutra and do not want the commercial subtree, deleting it
is not a workaround. It is the open-source build, and it is a first-class
configuration.

---

## The one property worth reviewing

**Everything in this subtree can only NARROW access. Nothing here can widen it.**

There is no code path, no policy bundle, no role, no group and no break-glass in
Enterprise that makes content more visible than the open-source Core would have
made it.

This is asserted mechanically, over the full cross-product of content tier ×
`do_not_learn` × clearance × surface × purpose, on every build:

```
ee/src/policy/engine.test.ts → "ENTERPRISE NARROWS, NEVER WIDENS"
```

The practical consequence for a security review: **read Core's ~600-line gate,
then confirm that assertion still passes.** That is a review a team can finish
in an afternoon, which is worth considerably more than a longer feature list.

In particular, and because every enterprise buyer asks: **no role reaches
secret-tier content on a model surface.** Not a tenant admin, not a super admin,
not a break-glass role. The floor is checked *before* clearance is read, so the
guarantee comes from the ordering of the code rather than from a policy setting
someone has to trust.

---

## The shape

A customer-hosted **control plane** issues signed policy bundles to an unchanged
**file-and-git data plane** — which keeps working, and stays air-gappable, when
the control plane is unreachable.

We sell software and support. You bring the infrastructure. There is no
Sutra-operated service in this picture, because the product's entire claim is
that your knowledge stays where you put it, and running it for you would
contradict that.

### Why this is credible, stated plainly

The enterprise-readiness scorecard behind this edition is **1 current / 7
partial / 8 missing**, and the split is what makes it worth building:

- The **data plane** — classification, egress gating, per-class provider
  allowlisting, residency, offline operation — is largely built, and it is
  battle-scarred rather than theoretical.
- The **control plane** — tenancy, identity, RBAC, SSO, KMS, retention, supply
  chain, certification — was entirely absent. It is commodity work.

The differentiating half already existed. This is the commodity half.

---

## The modules

| | Module | What it is |
|---|---|---|
| **E1** | `policy/engine` | One policy engine. The gate is **imported** from Core, not re-implemented — the upstream system had six re-implementations of one tier comparison and *every divergence failed open in at least one of them*. |
| **E2** | `identity/subject` · `policy/engine` | SSO claims → clearance. Groups, RBAC/ABAC, **purpose limitation**, per-tenant provider allowlists. |
| **E3** | `audit/chain` | A tamper-**evident** hash chain, retention classes, legal hold, and an external anchor. |
| **E4** | `keys/kms` | KMS/HSM seam. No plaintext key material anywhere in the product. |
| **E5** | `policy/bundle` | Signed, versioned, expiring policy bundles. Break-glass is **audited rather than available**. |
| **E6** | `supply/sbom` | SBOM, dependency policy, signed releases. |
| **E7** | `classifier/external` | Your own DLP supplies the tier. Strictest wins. |

---

## Three design decisions worth knowing before you evaluate

### The data plane survives the control plane

If the control plane is unreachable, the last valid bundle keeps applying and
nodes keep answering. Failing closed on every request when the policy server is
down sounds more secure and is worse — it makes the control plane a single point
of failure for reading your own notes, which is how organisations end up running
with policy enforcement disabled "temporarily".

A **stale** bundle is a different matter: once `expires` passes, the node falls
back to the **most restrictive** policy rather than to the last one. An expired
policy is one nobody has reaffirmed.

### "Tamper-evident", not "immutable"

The audit log is a hash chain: altering or removing any entry breaks every link
after it, and `verifyChain()` names the entry and the mode.

What that does **not** do is stop someone with write access from truncating the
log and re-chaining from that point — a shortened chain is internally
consistent. Detecting *that* needs an anchor outside the file, which
`exportAnchor()` produces and your deployment ships somewhere the log's writer
cannot reach.

`chain.test.ts` contains a test that asserts this limitation deliberately. A
customer who discovers the gap themselves will not believe the next claim
either.

### The environment-variable key provider does not satisfy E4, and says so

`EnvKeyProvider` exists so a deployment can start. `posture()` reports
`satisfiesE4: false` for it, and `sutra doctor` prints that rather than passing
it. A product that overstates its own posture in its own tooling is one whose
other claims also get checked.

---

## Contributions

The Licensor does not accept outside contributions into `ee/` except under a
signed agreement. Contributions to Core are governed by Apache-2.0 plus the CLA
and grant no rights here. See [`../CONTRIBUTING.md`](../CONTRIBUTING.md).
