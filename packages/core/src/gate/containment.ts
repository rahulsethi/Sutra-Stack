// SPDX-License-Identifier: Apache-2.0
/**
 * Hosted containment — lifted from `aatma/src/capabilities/containment.ts`.
 *
 * A skill marked `inference.hosted_allowed: false` must never run in a hosted
 * context. A hosted caller (a gateway relaying to a cloud model) carries
 * `SUTRA_HOSTED=1` in its environment, which child processes inherit. Trusted
 * local runs carry no flag and are unaffected.
 *
 * ONLY AN EXPLICIT `false` BLOCKS. An absent flag does not — and that asymmetry
 * is deliberate rather than lax: the tier gate is what protects *content*, and
 * it is always on. This flag protects *capability execution*, where the safe
 * default has to be "runnable", or every third-party skill would need to opt in
 * to working at all. A skill that handles secrets sets the flag; a skill that
 * formats a list does not have to think about it.
 */

export interface ContainmentSubject {
  id: string;
  frontmatter?: {
    inference?: {
      hosted_allowed?: boolean;
    };
  } | undefined;
}

/** Returns a refusal reason, or `null` if the capability may run. */
export function hostedContainmentBlock(
  cap: ContainmentSubject,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const hostedAllowed = cap.frontmatter?.inference?.hosted_allowed;
  if (hostedAllowed === false && env["SUTRA_HOSTED"] === "1") {
    return (
      `capability ${cap.id} is local-only (inference.hosted_allowed: false) and cannot run in a ` +
      `hosted context (SUTRA_HOSTED=1)`
    );
  }
  return null;
}

/** True iff this process believes it is relaying to a hosted model. */
export function isHostedContext(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["SUTRA_HOSTED"] === "1";
}
