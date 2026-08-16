// SPDX-License-Identifier: LicenseRef-Sutra-Commercial
/**
 * E4 · KEY AND SECRET MANAGEMENT.
 *
 * ROADMAP v2.0: "KMS/HSM integration, encryption at rest, NO PLAINTEXT SECRET
 * FILE ANYWHERE IN THE PRODUCT."
 *
 * That last clause is a direct response to how Core does it. Core resolves its
 * override passphrase from `state/secrets/override.key` — a plaintext file,
 * gitignored, carried between the user's own trusted machines. For one person
 * on their own laptop that is a defensible trade: it is inspectable, it
 * survives a reinstall, and the threat model is "this machine is mine".
 *
 * It is not defensible for an enterprise, where the threat model includes a
 * backup snapshot, a support engineer with filesystem access, and an auditor
 * asking where key material lives.
 *
 * So Enterprise replaces the RESOLVER, not the gate. `KeyProvider` is the seam:
 * the same constant-time comparison in Core runs against a secret that never
 * touched a disk.
 */

import type { Tier } from "@sutra/core";

export interface KeyProvider {
  kind: "kms" | "hsm" | "vault" | "env";

  /**
   * Resolve a named secret. Returns null when unavailable.
   *
   * THE CALLER FAILS CLOSED, and it already does: every check in Core treats an
   * unresolvable secret as "no secret configured", which makes every check
   * fail. That behaviour was correct for the single-user case and needed no
   * change for Enterprise — which is the sort of thing that only stays true if
   * you resist re-implementing it here.
   */
  resolve(name: string): Promise<string | null>;

  /** E4 — data-key encryption for at-rest protection of derived artifacts. */
  encrypt(plaintext: Buffer, context: EncryptionContext): Promise<Buffer>;
  decrypt(ciphertext: Buffer, context: EncryptionContext): Promise<Buffer>;

  /** Rotation is an audited event; the id is what makes it traceable. */
  currentKeyId(): Promise<string>;
}

/**
 * Encryption context — additional authenticated data, bound to tenant and tier.
 *
 * Binding the TIER into the AAD is not decoration: a ciphertext encrypted as
 * `secret` cannot then be decrypted while claiming to be `public`. A tier
 * confusion at the storage layer becomes a DECRYPTION FAILURE rather than a
 * silent downscope — which is the direction I14 wants such a failure to go.
 */
export interface EncryptionContext {
  tenant: string;
  tier: Tier;
  purpose: string;
}

/**
 * The environment-variable provider. Present so a deployment can start, and
 * deliberately loud about what it is not.
 *
 * An env var is better than a file — it does not land in a filesystem backup
 * and it is not readable by someone with a shell in the wrong container — and
 * it is still not a KMS. It is offered as a starting point, and it says so
 * rather than letting a customer discover it during a security review.
 */
export class EnvKeyProvider implements KeyProvider {
  readonly kind = "env" as const;

  async resolve(name: string): Promise<string | null> {
    const v = process.env[name];
    return v && v.trim() !== "" ? v : null;
  }

  async encrypt(): Promise<Buffer> {
    throw new Error(
      "EnvKeyProvider does not implement encryption at rest. Configure a KMS or HSM provider — " +
      "E4 requires that no plaintext key material exists in the product, and an environment " +
      "variable holding a data key is still key material this process can read.",
    );
  }

  async decrypt(): Promise<Buffer> {
    throw new Error("EnvKeyProvider does not implement encryption at rest. Configure a KMS or HSM provider.");
  }

  async currentKeyId(): Promise<string> {
    return "env";
  }
}

/**
 * The compliance posture of a provider, for `sutra doctor` and for the
 * security questionnaire a customer will send.
 *
 * It answers honestly rather than favourably. A product that overstates its own
 * posture in its own tooling is one whose next claim also gets checked.
 */
export function posture(provider: KeyProvider): {
  atRestEncryption: boolean;
  keyMaterialLeavesProcess: boolean;
  rotatable: boolean;
  satisfiesE4: boolean;
  note: string;
} {
  switch (provider.kind) {
    case "kms":
    case "hsm":
      return {
        atRestEncryption: true,
        keyMaterialLeavesProcess: false,
        rotatable: true,
        satisfiesE4: true,
        note: "key material never enters this process; encryption and decryption are delegated.",
      };
    case "vault":
      return {
        atRestEncryption: true,
        keyMaterialLeavesProcess: true,
        rotatable: true,
        satisfiesE4: true,
        note: "the secret is fetched into process memory. Better than a file on disk; not equivalent to an HSM, and a memory dump would contain it.",
      };
    case "env":
      return {
        atRestEncryption: false,
        keyMaterialLeavesProcess: true,
        rotatable: false,
        satisfiesE4: false,
        note:
          "an environment variable. It does not land in a filesystem backup and is not readable " +
          "from another container, which is better than a plaintext file — and it is NOT a KMS. " +
          "E4 is NOT satisfied by this provider, and `sutra doctor` reports so rather than passing it.",
      };
  }
}
