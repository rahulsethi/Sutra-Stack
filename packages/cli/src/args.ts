// SPDX-License-Identifier: Apache-2.0
/**
 * A small argument parser.
 *
 * Deliberately hand-rolled rather than taking a dependency: the CLI's whole
 * dependency set is `@sutra/aatma-core` and `@sutra/hermes-mcp`, and a governance tool whose
 * install pulls in forty transitive packages undercuts its own pitch. This is
 * eighty lines and it does exactly what the documented surface needs.
 *
 * ── §9.7 · ARGUMENTS MUST ACTUALLY ARRIVE ──────────────────────────────────
 * A runner invoked as `<tool> -- run <skill> -- args` silently dropped the arguments across
 * THIRTEEN skills. Nothing errored; the skills just ran with no input.
 *
 * So `--` is handled explicitly and its tail is preserved verbatim as
 * `passthrough`, and `args.test.ts` asserts a round trip through the exact
 * `sutra run <skill> -- --flag "value with spaces"` shape that broke upstream.
 */

export interface ParsedArgs {
  /** The command path, e.g. `["graph", "export"]`. */
  command: string[];
  /** Positional arguments after the command. */
  positional: string[];
  /** `--key value` and `--flag`. */
  flags: Map<string, string | true>;
  /** Everything after a bare `--`, verbatim. */
  passthrough: string[];
}

/** Flags that take a value. Anything else is boolean. */
const VALUE_FLAGS = new Set([
  "tier", "title", "section", "harness", "exposure", "profile", "since",
  "k", "limit", "vault", "config", "tags", "reason", "expires", "note",
  "format", "out", "shrink-tolerance", "max-age", "column",
  // `sutra provider`
  "id", "base-url", "key-env", "model", "kind",
]);

/**
 * The flags that are DELIBERATELY boolean. Anything not here and not in
 * VALUE_FLAGS is unknown, and `flagString` refuses to read it silently.
 *
 * ── WHY THIS LIST EXISTS ───────────────────────────────────────────────────
 * Forgetting to add a flag to VALUE_FLAGS does not produce an error. It parses
 * `--id my-llm` as `id: true` and leaves `my-llm` sitting in `positional`, where
 * nothing looks for it. The command then reports "--id is required" while the
 * user is staring at the `--id` they just typed.
 *
 * That is the same shape as the argument-dropping defect this CLI's own header
 * documents: a runner invoked as `<tool> -- run <skill> -- args` silently
 * discarded the args. Silent argument loss is the most confusing possible
 * failure, because the evidence contradicts the message.
 *
 * So the two sets together are exhaustive, and `flagString` throws on anything
 * outside them rather than returning `undefined`.
 */
const BOOLEAN_FLAGS = new Set([
  "json", "quiet", "help", "version", "hybrid", "semantic", "apply", "force",
  "resolve", "local", "reasoning", "enable", "prune", "dry-run", "verbose",
  "no-color", "whatif", "what-if", "all", "yes",
]);

/**
 * Commands whose SECOND word is a subcommand rather than a positional. Listed
 * explicitly so `sutra search graph export` searches for "graph export" rather
 * than being mistaken for a subcommand — an implicit rule here would make
 * search silently drop the user's query.
 */
const TWO_WORD_COMMANDS = new Set([
  "graph", "publish", "skills", "schedule", "vault", "help", "config",
]);

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags = new Map<string, string | true>();
  const rest: string[] = [];
  const passthrough: string[] = [];

  let i = 0;
  let seenDoubleDash = false;
  for (; i < argv.length; i++) {
    const a = argv[i]!;

    if (a === "--") {
      seenDoubleDash = true;
      passthrough.push(...argv.slice(i + 1));
      break;
    }

    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        flags.set(a.slice(2, eq), a.slice(eq + 1));
        continue;
      }
      const name = a.slice(2);
      if (VALUE_FLAGS.has(name)) {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags.set(name, next);
          i++;
          continue;
        }
      }
      flags.set(name, true);
      continue;
    }

    if (a.startsWith("-") && a.length > 1 && !/^-\d/.test(a)) {
      // Short flags: -j = --json, -q = --quiet, -h = --help, -v = --version.
      const map: Record<string, string> = { j: "json", q: "quiet", h: "help", v: "version" };
      for (const ch of a.slice(1)) if (map[ch]) flags.set(map[ch]!, true);
      continue;
    }

    rest.push(a);
  }
  void seenDoubleDash;

  const command: string[] = [];
  if (rest.length > 0) {
    command.push(rest[0]!);
    if (rest.length > 1 && TWO_WORD_COMMANDS.has(rest[0]!)) command.push(rest[1]!);
  }

  return { command, positional: rest.slice(command.length), flags, passthrough };
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags.get(name);
  if (typeof v === "string") return v;

  // PRESENT, BUT WITH NO VALUE. The user typed `--name something` and the parser
  // did not know `name` takes a value, so `something` went to `positional` and is
  // now invisible to this caller. Returning `undefined` here reports "--name is
  // required" to somebody looking straight at the flag they typed.
  //
  // Throwing costs one confusing minute for whoever adds the next flag. Not
  // throwing costs an unbounded amount of time for every user who hits it.
  // Only for a flag in NEITHER set. A DECLARED boolean read as a string is a
  // caller mistake, not lost user input — and `--json` is passed on nearly every
  // invocation, so throwing there would break commands that work correctly.
  if (v === true && !VALUE_FLAGS.has(name) && !BOOLEAN_FLAGS.has(name)) {
    throw new Error(
      `--${name} takes a value, but the argument parser does not know that, so the value you passed ` +
      `was DISCARDED.

  Fix: add "${name}" to VALUE_FLAGS in packages/cli/src/args.ts.

  ` +
      `This is reported loudly rather than as "--${name} is required" because the second message ` +
      `sends you looking at your own command line, where nothing is wrong.`,
    );
  }
  return undefined;
}

/** Every flag name the parser knows about. Exported for the args test. */
export function knownFlags(): { value: readonly string[]; boolean: readonly string[] } {
  return { value: [...VALUE_FLAGS].sort(), boolean: [...BOOLEAN_FLAGS].sort() };
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true || args.flags.get(name) === "true";
}

export function flagNumber(args: ParsedArgs, name: string, fallback: number): number {
  const v = flagString(args, name);
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
