// SPDX-License-Identifier: Apache-2.0
/**
 * @sutra/core — the governance core.
 *
 * A governed personal knowledge substrate: notes are plain markdown in a git
 * repo, every note carries a sensitivity tier, a deterministic pipeline turns
 * captures into durable linked knowledge, and a GATE sits between that
 * knowledge and every AI model — which the model can never lift.
 *
 * One runtime dependency (`gray-matter`). Node, Bun and Deno all run it
 * unchanged; `npm run check:no-bun` asserts that stays true.
 */
export * from "./gate/index.js";
export * from "./vault/index.js";
export * from "./retrieval/index.js";
export * from "./run/index.js";
export * from "./persona/index.js";
export * from "./config.js";
export * from "./audit/log.js";
export * from "./exec/pwsh.js";
export { listSkills, getSkill, type SkillRef, type SkillDetail } from "./skills/enumerate.js";
