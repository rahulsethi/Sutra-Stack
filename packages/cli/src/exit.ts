// SPDX-License-Identifier: Apache-2.0
/**
 * EXIT CODES ARE A GOVERNANCE SIGNAL — lifted verbatim from
 * the CLI's contract with every caller.
 *
 * 00-MASTER-BUILD-BRIEF.md §5 is explicit: "Exit codes are a governance signal
 * — lift them verbatim." They are, byte for byte, because scripts and
 * schedulers on the user's machine already branch on these numbers and a
 * renumbering would silently change what those branches do.
 *
 * The distinctions matter more than the numbers. D11's defect was five
 * different outcomes sharing one counter and one exit code; these are five
 * different refusals with five different remedies:
 *
 *   4 (sensitivity block)   the gate said no        → the CONTENT is the issue
 *   5 (hosted containment)  the CONTEXT said no     → run it locally instead
 *   7 (local-only floor)    the FLOOR said no       → nothing will fix this
 *
 * A caller that cannot tell 4 from 7 will retry the one that can never succeed.
 */

export const EXIT = {
  /** Success. */
  OK: 0,
  /** A generic failure that has no more specific code. */
  ERROR: 1,
  /** Not found — no such note, skill, workflow, or command. */
  NOT_FOUND: 2,
  /** The destination accepts nothing at all (provider mode `skip`). */
  DESTINATION_ACCEPTS_NOTHING: 3,
  /** The sensitivity gate refused this content for this destination. */
  SENSITIVITY_BLOCK: 4,
  /** Refused because this process is running in a hosted context (SUTRA_HOSTED=1). */
  HOSTED_CONTAINMENT: 5,
  /** A required runner is missing — `pwsh`, `uv`, a model. Install it and retry. */
  RUNNER_MISSING: 6,
  /**
   * The secret floor was violated. NOT retryable, NOT configurable, and not a
   * bug: `local_only` content cannot reach a model, ever.
   */
  LOCAL_ONLY_FLOOR: 7,
  /** Usage error — bad arguments. */
  USAGE: 64,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** What each code means, printed by `sutra help exit-codes`. */
export const EXIT_MEANING: Record<number, string> = {
  0: "ok",
  1: "error",
  2: "not found — no such note, skill, or command",
  3: "the destination accepts no content (provider mode `skip`)",
  4: "sensitivity block — the gate refused this content for this destination",
  5: "hosted containment — refused because SUTRA_HOSTED=1; run it locally",
  6: "runner missing — a required tool (`pwsh`, `uv`) is not installed",
  7: "secret floor — local_only content cannot reach a model. Not retryable, by design",
  64: "usage error",
};

/** An error carrying a governance exit code. */
export class SutraError extends Error {
  constructor(
    message: string,
    readonly code: ExitCode,
    /** What the user should actually DO. A refusal without a remedy is a dead end. */
    readonly remedy?: string,
  ) {
    super(message);
    this.name = "SutraError";
  }
}
