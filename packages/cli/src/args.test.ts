// SPDX-License-Identifier: Apache-2.0
/**
 * SILENT ARGUMENT LOSS.
 *
 * The CLI's own header records the defect: a runner invoked as
 * `<tool> -- run <skill> -- args` discarded the arguments and reported success.
 * This file is about the same failure one layer down, and it was live.
 *
 * `--id my-llm` on a flag that is not in `VALUE_FLAGS` parses as `id: true` and
 * leaves `my-llm` in `positional`, where the command does not look. The command
 * then reports **"--id is required"** while the user stares at the `--id` they
 * just typed. The evidence contradicts the message, which is the most expensive
 * kind of error there is.
 *
 * Found by running `sutra provider add --id my-llm ...` the first time.
 *
 * The fix is not "remember to add the flag". It is that `flagString` REFUSES to
 * return `undefined` for a flag that was passed with a value it could not see.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, flagString, flagBool, flagNumber, knownFlags } from "./args.js";

// ─────────────────────────────────────────────────────────────────────────────

test("a value flag takes the following token", () => {
  const a = parseArgs(["capture", "a note", "--tier", "secret"]);
  assert.equal(flagString(a, "tier"), "secret");
  assert.deepEqual(a.positional, ["a note"]);
});

test("`--flag=value` works for ANY flag, known or not", () => {
  // The escape hatch. Even a flag the parser has never heard of carries its
  // value in this form, which is why the throw below points at it.
  const a = parseArgs(["provider", "add", "--brand-new-flag=hello"]);
  assert.equal(flagString(a, "brand-new-flag"), "hello");
});

test("A FLAG THAT TAKES A VALUE BUT IS NOT DECLARED THROWS, LOUDLY", () => {
  // The regression. Before this, `flagString` returned `undefined` and the
  // command said "--undeclared-flag is required".
  const a = parseArgs(["provider", "add", "--undeclared-flag", "some-value"]);

  // The value went to `positional`, invisible to the caller — that is the defect.
  assert.deepEqual(a.positional, ["add", "some-value"]);

  assert.throws(
    () => flagString(a, "undeclared-flag"),
    (e: Error) => {
      assert.match(e.message, /DISCARDED/, "the error must say the value was lost");
      assert.match(e.message, /VALUE_FLAGS/, "and must name the one-line fix");
      assert.match(e.message, /args\.ts/, "and where to make it");
      return true;
    },
    "an undeclared value flag silently returned undefined — THIS IS THE DEFECT",
  );
});

test("an ABSENT flag is still undefined, not a throw", () => {
  // The counter-test. A guard that throws on absence would break every optional
  // flag in the CLI, which is most of them.
  const a = parseArgs(["search", "kafka"]);
  assert.equal(flagString(a, "tier"), undefined);
  assert.equal(flagString(a, "never-mentioned"), undefined);
});

test("a BOOLEAN flag read as a string is undefined, not a throw", () => {
  // `--json` is genuinely boolean. Reading it with `flagString` is a caller bug,
  // but it must not throw — `--json` is passed on nearly every invocation and a
  // throw here would take down commands that are working correctly.
  const a = parseArgs(["search", "kafka", "--json"]);
  assert.equal(flagBool(a, "json"), true);
  assert.equal(flagString(a, "json"), undefined);
});

test("every provider flag that takes a value is DECLARED", () => {
  // Positive coverage on the fix. The guard above turns the trap into a loud
  // error; this asserts the flags that exist today do not hit it at all.
  const a = parseArgs([
    "provider", "add",
    "--id", "my-llm",
    "--base-url", "https://api.example.com/v1",
    "--key-env", "MY_LLM_API_KEY",
    "--model", "my-model-v1",
    "--kind", "openai-compatible",
    "--local", "--reasoning", "--enable",
  ]);

  assert.equal(flagString(a, "id"), "my-llm");
  assert.equal(flagString(a, "base-url"), "https://api.example.com/v1");
  assert.equal(flagString(a, "key-env"), "MY_LLM_API_KEY");
  assert.equal(flagString(a, "model"), "my-model-v1");
  assert.equal(flagString(a, "kind"), "openai-compatible");
  assert.equal(flagBool(a, "local"), true);
  assert.equal(flagBool(a, "reasoning"), true);
  assert.equal(flagBool(a, "enable"), true);

  // …and nothing leaked into positionals except the subcommand.
  assert.deepEqual(a.positional, ["add"]);
});

test("the two flag sets are DISJOINT — a flag cannot be both", () => {
  // A name in both sets is ambiguous: the parser would consume a following token
  // as its value while callers read it as a boolean, silently eating whatever
  // came next.
  const { value, boolean } = knownFlags();
  const both = value.filter((v) => boolean.includes(v));
  assert.deepEqual(both, [], `flag(s) declared as BOTH value and boolean: ${both.join(", ")}`);
  assert.ok(value.length > 10 && boolean.length > 5, "a set is suspiciously small — has one been emptied?");
});

test("a value flag does not swallow the NEXT flag", () => {
  // `sutra capture --tier --json` must not set tier to "--json".
  const a = parseArgs(["capture", "text", "--tier", "--json"]);
  assert.equal(flagBool(a, "json"), true);
  assert.equal(flagString(a, "tier"), undefined, "the following flag was consumed as a value");
});

test("`--` passes everything after it through untouched", () => {
  // The original defect's own shape: `sutra run <skill> -- --flag value`. The
  // args after `--` belong to the skill and must arrive intact.
  const a = parseArgs(["run", "my-skill", "--json", "--", "--inner-flag", "value", "-x"]);
  assert.deepEqual(a.passthrough, ["--inner-flag", "value", "-x"]);
  assert.equal(flagBool(a, "json"), true);
  assert.equal(flagBool(a, "inner-flag"), false, "a passthrough arg leaked into the CLI's own flags");
});

test("a negative number is a positional, not a short flag", () => {
  const a = parseArgs(["logs", "-7"]);
  assert.deepEqual(a.positional, ["-7"]);
});

test("short flags expand, and combine", () => {
  const a = parseArgs(["gate", "-jq"]);
  assert.equal(flagBool(a, "json"), true);
  assert.equal(flagBool(a, "quiet"), true);
});

test("flagNumber falls back rather than yielding NaN", () => {
  const a = parseArgs(["search", "x", "--limit", "not-a-number"]);
  assert.equal(flagNumber(a, "limit", 10), 10, "a NaN limit would silently return zero results");
  assert.equal(flagNumber(parseArgs(["search", "x", "--limit", "25"]), "limit", 10), 25);
});

test("a two-word command is not mistaken for a query", () => {
  // `sutra search graph export` searches for "graph export"; `sutra graph export`
  // is a subcommand. Getting this wrong makes search silently drop the query.
  const sub = parseArgs(["graph", "export"]);
  assert.deepEqual(sub.command, ["graph", "export"]);
  assert.deepEqual(sub.positional, []);

  const query = parseArgs(["search", "graph", "export"]);
  assert.deepEqual(query.command, ["search"]);
  assert.deepEqual(query.positional, ["graph", "export"], "the search query was eaten as a subcommand");
});
