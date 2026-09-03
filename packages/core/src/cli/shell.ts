/**
 * The CLI's edge, in one module: the name people type, where its bytes come from and
 * go, and the codes it hands back to the shell.
 *
 * These three used to live in `args.ts` and `run.ts` — the two modules that now read
 * the subcommand registry. A verb file needs all three, so leaving them there would
 * make `args.ts → subcommands/* → args.ts` a cycle, which is exactly the shape that
 * once forced the `--harness` help list to be hand-typed (see
 * `src/harness/registry.ts`). **This file imports nothing**, so every module under
 * `cli/` can read it and nothing has to be written twice to avoid a loop.
 */

/** The command people type. Independent of the package name. */
export const CLI_NAME = 'smelt';

/**
 * Where a wizard's answers come from: lines of text arriving over time, and nothing
 * more. `process.stdin` is one, a scripted `Readable.from([...])` in a test is
 * another, an async generator is a third.
 *
 * **Stated structurally, never as `NodeJS.ReadableStream`.** A `.d.ts` that names an
 * ambient namespace only typechecks inside a compilation that pulled `@types/node`
 * into its *global* scope, and a consumer building with `skipLibCheck: false` and a
 * narrowed `types` array (or no `@types/node` at its own root — the ordinary case
 * under pnpm) fails on smelt's declarations rather than on their own code. Naming the
 * node type by import does not help: TypeScript resolves `node:stream` — and bare
 * `stream` — only through the same globally-included `@types/node`. So the published
 * surface describes the shape smelt actually consumes, which needs no node types at
 * all, and the wizards adapt it internally with `Readable.from`.
 * `test/guards/packaging.test.ts` holds the shipped declarations to it.
 */
export type AnswerStream = AsyncIterable<string | Uint8Array>;

/**
 * Exit codes, and why there are five of them.
 *
 * A CLI that returns 0 whatever happens is the shell-level version of a stub that
 * returns `[]`: the caller cannot tell success from failure, so a pipeline built on it
 * fails silently. **`overBudget` is the load-bearing one.** A plan that did not fit is
 * not an error — smelt refused to cut the regions the caller asked to keep, which is
 * correct — but it is also not success, and a script must be able to see the
 * difference without parsing prose.
 */
export const EXIT = {
  ok: 0,
  overBudget: 1,
  usage: 2,
  refused: 3,
  unexpected: 4,
} as const;

/** Where the CLI's bytes come from and go. Injected so `runCli` is testable in-process. */
export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** All of stdin, as UTF-8. @throws {CliUsageError} when nothing is piped. */
  readonly stdin: () => string;
  /** The package version, for `--version`. */
  readonly version: string;
  /**
   * Where `smelt.config.json` discovery starts, and where `init` writes. Defaults to
   * the process working directory; tests pass a temp directory to stay hermetic.
   */
  readonly cwd?: string;
  /**
   * Interactive input for `smelt init` — the wizard reads answers line by line, which
   * the one-shot `stdin()` above cannot provide. `bin.ts` passes the real stdin
   * stream; tests pass a scripted one. Absent means `init` is a usage error.
   * See {@link AnswerStream} for why the type is structural.
   */
  readonly initInput?: AnswerStream;
}
