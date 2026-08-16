// SPDX-License-Identifier: Apache-2.0
/**
 * PERSONA PROMPT ASSEMBLY — lifted from `aatma/src/parvo/persona.ts`.
 *
 * A pure function: given the identity bundle that `Brain.identityBundle()`
 * already gate-filtered, compose the system prompt that gives a chat model the
 * user's chosen assistant voice.
 *
 * ── THIS MODULE NEVER READS THE VAULT ──────────────────────────────────────
 * Identity is authored ONCE, in the vault, and read through the gate. This file
 * only shapes whatever the gate cleared. That separation is the point: if this
 * module read files itself it would be a second read path, and a second read
 * path is one the gate does not cover.
 *
 * ── WITHHELD IDENTITY IS ACKNOWLEDGED, NOT LEAKED ──────────────────────────
 * When the gate withholds an identity file, the prompt says *that some identity
 * is unavailable at this ceiling* — never what it was. The model is told enough
 * to stop guessing and not enough to reconstruct.
 *
 * Saying nothing at all would be worse: a model that does not know it is
 * missing context confabulates to fill the gap, which is the exact failure the
 * whole product exists to prevent.
 *
 * ── DE-PERSONALISED ────────────────────────────────────────────────────────
 * The upstream version hardcoded one person's name and one assistant's name
 * into the header. Sutra ships a generic frame; the *voice* comes entirely from
 * the user's own `persona.md`, and the default below is a restrained fallback
 * used only when that note is absent or gated out — never a substitute for it.
 */

import type { IdentityBundle } from "../vault/brain.js";

/** Structurally the gate's `IdentityBundle`. Named so the dependency is one-way. */
export type PersonaBundle = IdentityBundle;

const HEADER =
  "You are this person's assistant. You speak in one consistent voice across the whole " +
  "conversation. You are grounded by their personal knowledge base, reached only through a " +
  "sensitivity gate: you see just what the gate clears, you never invent facts about them, and " +
  "you cite note paths when you rely on retrieved material.";

/**
 * Used ONLY when `persona.md` is absent or gated out.
 *
 * Deliberately restrained. A florid default would be a personality the user did
 * not choose, wearing their assistant's position — and they would have to
 * discover it and then write a note to undo it.
 */
const DEFAULT_VOICE =
  "Voice (default — no persona note is loaded): concise, warm, direct. Lead with the answer. " +
  "No preamble, no flattery, no filler. Admit uncertainty plainly.";

/**
 * Belt and braces.
 *
 * The REAL enforcement is the routing decision plus the gate — this sentence
 * enforces nothing. It is here because a model that has been told the rule
 * stops *volunteering* to bypass it: without it, an assistant that hits a
 * withheld note helpfully proposes reading it another way, and the user has to
 * decline. Restating the floor in-prompt removes that whole exchange.
 */
const FLOOR =
  "Hard rule: never reveal or restate content the gate withheld, and never ask to send secret or " +
  "private material to a hosted model. If something is unavailable at this sensitivity ceiling, " +
  "say so plainly and move on — do not look for another route to it.";

/**
 * Assemble the system prompt from an already gate-filtered identity bundle.
 *
 * Deterministic and side-effect-free, so it is unit-testable with a fixture
 * bundle and produces byte-identical output for identical input.
 */
export function assemblePersonaPrompt(bundle: PersonaBundle): string {
  const sections: string[] = [HEADER];

  sections.push(
    bundle.persona && bundle.persona.trim()
      ? `## Your voice\n\n${bundle.persona.trim()}`
      : `## Your voice\n\n${DEFAULT_VOICE}`,
  );

  if (bundle.principal && bundle.principal.trim()) {
    sections.push(`## Who you are speaking to\n\n${bundle.principal.trim()}`);
  }

  if (bundle.telos && bundle.telos.trim()) {
    sections.push(`## What they are pointing at\n\n${bundle.telos.trim()}`);
  }

  if (bundle.withheld && bundle.withheld.length > 0) {
    // The NAMES and TIERS of the withheld files, never their content — the same
    // rule every other surface follows.
    sections.push(
      `_Some identity content is withheld at this sensitivity ceiling: ${bundle.withheld.join(", ")}. ` +
      `Work with what is present; do not guess the rest._`,
    );
  }

  sections.push(FLOOR);
  return sections.join("\n\n");
}
