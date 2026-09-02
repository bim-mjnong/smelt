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
   */
  readonly initInput?: NodeJS.ReadableStream;
}
