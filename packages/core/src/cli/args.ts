import { parseArgs } from 'node:util';

import { SUPPORTED_LANGUAGES } from '../detect.ts';
import { CliUsageError } from '../errors.ts';
import type { DetectedLanguage } from '../types.ts';

/** The command people type. Independent of the package name. */
export const CLI_NAME = 'smelt';

/** What the CLI was asked to do. Pure data, so the parse is testable on its own. */
export interface SmeltInvocation {
  readonly mode: 'smelt' | 'reconstruct' | 'help' | 'version' | 'init';
  /** Path to read. `undefined` means stdin. */
  readonly file?: string;
  /**
   * UTF-8 bytes. `undefined` in `'smelt'` mode means the flag was not given; the
   * runner then consults `smelt.config.json` and errors if that has no default either.
   */
  readonly budgetBytes?: number;
  readonly focus: readonly string[];
  readonly language?: DetectedLanguage;
  /** `undefined` means the flag was not given — the config default may apply. */
  readonly strategy?: 'lexical' | 'structural';
  readonly json: boolean;
}

/**
 * Argument parsing on `node:util.parseArgs` — stable since Node 20, which `engines`
 * already requires.
 *
 * The CLI ships as a `bin` on the library rather than as a second package, and this
 * import is the reason that is free: it adds no dependency, so the argument the second
 * package existed to win — keeping the library's dependency tree small — is already won.
 *
 * @throws {CliUsageError} on anything the user got wrong. Never guesses.
 */
export function parseSmeltArgs(argv: readonly string[]): SmeltInvocation {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        budget: { type: 'string' },
        focus: { type: 'string', multiple: true },
        language: { type: 'string' },
        strategy: { type: 'string' },
        json: { type: 'boolean' },
        reconstruct: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean' },
      },
    });
  } catch (cause) {
    throw new CliUsageError(
      `${CLI_NAME}: ${cause instanceof Error ? cause.message : String(cause)}\n` +
        `Run \`${CLI_NAME} --help\`.`,
    );
  }

  const { values, positionals } = parsed;

  if (values.help === true) return { mode: 'help', focus: [], json: false };
  if (values.version === true) {
    return { mode: 'version', focus: [], json: false };
  }

  if (positionals[0] === 'init') {
    // `smelt init` is a subcommand, so a file literally named `init` needs `./init`.
    if (positionals.length > 1) {
      throw new CliUsageError(`${CLI_NAME}: init takes no further arguments.`);
    }
    const flags = Object.entries(values).filter(([, value]) => value !== undefined);
    if (flags.length > 0) {
      throw new CliUsageError(
        `${CLI_NAME}: init is interactive and takes no flags ` +
          `(got --${flags.map(([name]) => name).join(', --')}). It asks instead.`,
      );
    }
    return { mode: 'init', focus: [], json: false };
  }

  if (positionals.length > 1) {
    throw new CliUsageError(
      `${CLI_NAME}: expected at most one file, got ${String(positionals.length)} ` +
        `(${positionals.join(', ')}). smelt reads one blob at a time.`,
    );
  }
  const file = positionals[0];

  if (values.reconstruct === true) {
    if (values.budget !== undefined) {
      throw new CliUsageError(
        `${CLI_NAME}: --budget makes no sense with --reconstruct. Reconstruction puts ` +
          `every byte back; there is nothing to fit.`,
      );
    }
    return {
      mode: 'reconstruct',
      ...(file === undefined ? {} : { file }),
      focus: [],
      json: false,
    };
  }

  const budgetBytes = parseBudget(values.budget);
  const chosenStrategy = strategy(values.strategy);
  return {
    mode: 'smelt',
    ...(file === undefined ? {} : { file }),
    ...(budgetBytes === undefined ? {} : { budgetBytes }),
    focus: values.focus ?? [],
    ...(values.language === undefined ? {} : { language: language(values.language) }),
    ...(chosenStrategy === undefined ? {} : { strategy: chosenStrategy }),
    json: values.json === true,
  };
}

/**
 * `--budget` has no built-in default, for the same reason `smelt()` has none: a budget
 * smelt invented would be smelt deciding how much of the caller's context to throw
 * away, silently, at a number nobody chose. A *missing* flag is not an error here,
 * though — `smelt.config.json` may carry a `defaultBudgetBytes` the user chose
 * explicitly, and the runner errors only when neither exists. A malformed value is
 * always an error.
 */
function parseBudget(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) {
    throw new CliUsageError(`${CLI_NAME}: --budget must be a whole number of bytes, got "${raw}".`);
  }
  const value = Number(raw);
  if (value <= 0) {
    throw new CliUsageError(`${CLI_NAME}: --budget must be greater than zero, got "${raw}".`);
  }
  return value;
}

function language(raw: string): DetectedLanguage {
  const known: readonly string[] = [...SUPPORTED_LANGUAGES, 'unknown'];
  if (!known.includes(raw)) {
    throw new CliUsageError(
      `${CLI_NAME}: unknown --language "${raw}". Known: ${known.join(', ')}.`,
    );
  }
  return raw as DetectedLanguage;
}

function strategy(raw: string | undefined): 'lexical' | 'structural' | undefined {
  if (raw === undefined) return undefined;
  if (raw !== 'lexical' && raw !== 'structural') {
    throw new CliUsageError(
      `${CLI_NAME}: unknown --strategy "${raw}". Known: lexical, structural.`,
    );
  }
  return raw;
}

/** The help text. Also the closest thing the CLI has to documentation. */
export function cliUsage(): string {
  return `${CLI_NAME} — shrink text for a model, without lying about what was removed.

USAGE
  ${CLI_NAME} <file> --budget <bytes> [--focus <term>]...
  ${CLI_NAME} --budget <bytes> [--focus <term>]... < input
  ${CLI_NAME} --reconstruct <result.json>
  ${CLI_NAME} --reconstruct < result.json
  ${CLI_NAME} init

Smelted text goes to stdout and the report goes to stderr, so the two can be piped
apart:  ${CLI_NAME} big.log --budget 4000 > small.log

CONFIG
  ${CLI_NAME} init walks you through writing a smelt.config.json (and optional typed
  stubs), one question at a time; nothing is written until a final confirm. Runs read
  the nearest smelt.config.json, walking up from the working directory, for DEFAULTS
  only — budget, strategy, store. An explicit flag always wins, and a malformed config
  is a usage error, never silently ignored.

OPTIONS
  --budget <bytes>     Required, unless smelt.config.json sets defaultBudgetBytes.
                       Soft ceiling for the output, in UTF-8 bytes. No built-in
                       default: a budget smelt invented would decide for you.
  --focus <term>       What you were looking for. Repeatable. Matching regions and
                       their context survive; the runs between them collapse.
  --language <id>      Override detection. One of: ${[...SUPPORTED_LANGUAGES, 'unknown'].join(', ')}.
  --strategy <id>      lexical or structural. Defaults to lexical, unless
                       smelt.config.json says otherwise. structural parses typescript,
                       tsx, rust, python and go; any other language is refused, never
                       approximated.
  --json               Print a JSON envelope on stdout instead of the smelted text:
                       { format, result, elided }. \`result\` is the SmeltResult
                       verbatim; \`elided\` carries the bytes, so the envelope can be
                       reconstructed. Feed it back with --reconstruct.
  --reconstruct        Read a --json envelope and print the original text, byte for
                       byte. This is Law 3 you can run from a shell.
  -h, --help           This text.
  --version            The package version.

EXIT CODES
  0  under budget
  1  over budget — the plan did not fit, and the report says so. Never silent.
  2  usage error
  3  smelt refused (a SmeltError: an unbuilt planner, a missing hash)
  4  unexpected internal error
`;
}
