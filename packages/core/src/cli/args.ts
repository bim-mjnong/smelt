import { parseArgs } from 'node:util';

import { SUPPORTED_LANGUAGES } from '../detect.ts';
import { CliUsageError } from '../errors.ts';
import { isStrategy, STRATEGIES } from '../plan/planners.ts';
import type { Strategy } from '../plan/planners.ts';
import { STRUCTURAL_LANGUAGES } from '../plan/structural.ts';
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
  readonly strategy?: Strategy;
  readonly json: boolean;
}

/**
 * `smelt map <dir>` — the repo-map subcommand, parsed. A separate shape rather than
 * more optional fields on {@link SmeltInvocation}, because the two commands share
 * almost nothing: a map has a directory instead of a file/stdin, an ignore list and
 * a cache directory instead of a language and a strategy.
 */
export interface MapInvocation {
  readonly mode: 'map';
  /** The repository root to map. Always present — `map` without a directory is a usage error. */
  readonly dir: string;
  /** `undefined` means the flag was not given — the config default may apply. */
  readonly budgetBytes?: number;
  readonly focus: readonly string[];
  /** `--ignore` entries, replacing the built-in default list when non-empty. */
  readonly ignore: readonly string[];
  /** `--cache <dir>`: only when given does the map write to disk. */
  readonly cacheDir?: string;
  readonly json: boolean;
}

/**
 * `smelt retrieve <hash>` — the marker's `retrieve("hash")` as a real command, parsed.
 * A {@link MapInvocation}-style sibling: nothing but the hash, because the command's
 * whole contract is "hash in, exact bytes out" — the same contract as the
 * `smelt_retrieve` tool, reachable from a shell.
 */
export interface RetrieveInvocation {
  readonly mode: 'retrieve';
  /** The hash exactly as the marker printed it. Validated by the store, not here. */
  readonly hash: string;
}

/** `smelt stats` — the store's counters, read without touching them. */
export interface StatsInvocation {
  readonly mode: 'stats';
  readonly json: boolean;
}

/**
 * `smelt hooks install` / `smelt hooks remove` — the harness-hooks installer. Like
 * `init`, the subcommand is interactive; the only flag is `--harness`, which skips
 * the selection step. Validation of the id happens in `cli/hooks.ts`, where the
 * harness registry lives.
 */
export interface HooksInvocation {
  readonly mode: 'hooks';
  readonly action: 'install' | 'remove';
  readonly harness?: string;
}

/** Everything `parseSmeltArgs` can return. Narrow on `mode`. */
export type CliInvocation =
  SmeltInvocation | MapInvocation | RetrieveInvocation | StatsInvocation | HooksInvocation;

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
export function parseSmeltArgs(argv: readonly string[]): CliInvocation {
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
        ignore: { type: 'string', multiple: true },
        cache: { type: 'string' },
        harness: { type: 'string' },
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

  if (positionals[0] === 'map') {
    // `smelt map` is a subcommand, so a file literally named `map` needs `./map`.
    return parseMapArgs(values, positionals);
  }

  if (positionals[0] === 'retrieve') {
    // A subcommand, like map and init — a file literally named `retrieve` needs `./retrieve`.
    return parseRetrieveArgs(values, positionals);
  }

  if (positionals[0] === 'stats') {
    return parseStatsArgs(values, positionals);
  }

  if (positionals[0] === 'hooks') {
    return parseHooksArgs(values, positionals);
  }

  // These two belong to `smelt map` alone; silently ignoring a flag the user typed
  // would be a setting they believed was in force.
  if (values.ignore !== undefined || values.cache !== undefined) {
    throw new CliUsageError(
      `${CLI_NAME}: --ignore and --cache belong to \`${CLI_NAME} map\`. A single-blob ` +
        `run reads one file or stdin; there is no tree to walk and nothing to cache.`,
    );
  }
  if (values.harness !== undefined) {
    throw new CliUsageError(
      `${CLI_NAME}: --harness belongs to \`${CLI_NAME} hooks\`. A single-blob run ` +
        `has no harness to install into.`,
    );
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

/** What `smelt map` may see from the shared parse. Flags only — no file, no stdin. */
interface MapFlagValues {
  readonly budget?: string;
  readonly focus?: readonly string[];
  readonly language?: string;
  readonly strategy?: string;
  readonly ignore?: readonly string[];
  readonly cache?: string;
  readonly harness?: string;
  readonly json?: boolean;
  readonly reconstruct?: boolean;
}

/**
 * The `map` subcommand's own validation: exactly one directory, the map-only flags,
 * and the same budget rules as everything else — a missing `--budget` is not an
 * error *here* (the config may carry `defaultBudgetBytes`), a malformed one always is.
 */
function parseMapArgs(values: MapFlagValues, positionals: readonly string[]): MapInvocation {
  if (positionals.length < 2) {
    throw new CliUsageError(
      `${CLI_NAME}: map needs the directory to read.\n` +
        `  ${CLI_NAME} map <dir> --budget <bytes> [--focus <term>]...`,
    );
  }
  if (positionals.length > 2) {
    throw new CliUsageError(
      `${CLI_NAME}: map takes exactly one directory, got ` +
        `${String(positionals.length - 1)} (${positionals.slice(1).join(', ')}).`,
    );
  }
  if (values.reconstruct === true) {
    throw new CliUsageError(
      `${CLI_NAME}: --reconstruct makes no sense with map. A map elides nothing, so ` +
        `there is nothing to put back.`,
    );
  }
  if (values.language !== undefined || values.strategy !== undefined) {
    throw new CliUsageError(
      `${CLI_NAME}: --language and --strategy apply to single-blob runs. map reads a ` +
        `whole tree, detects each file's language itself, and is not a planner ` +
        `strategy — it returns a map, not an elision plan.`,
    );
  }
  if (values.harness !== undefined) {
    throw new CliUsageError(
      `${CLI_NAME}: --harness belongs to \`${CLI_NAME} hooks\`. map has no harness ` +
        `to install into.`,
    );
  }
  const budgetBytes = parseBudget(values.budget);
  return {
    mode: 'map',
    dir: positionals[1]!,
    ...(budgetBytes === undefined ? {} : { budgetBytes }),
    focus: values.focus ?? [],
    ignore: values.ignore ?? [],
    ...(values.cache === undefined ? {} : { cacheDir: values.cache }),
    json: values.json === true,
  };
}

/**
 * `retrieve` takes the hash and nothing else. Every flag is refused rather than
 * ignored — the command prints the exact original bytes on stdout and nothing more,
 * so a flag that changed the output would break the one contract it has, and a flag
 * silently dropped would be a setting the user believed was in force. In particular
 * there is no `--json`: the bytes ARE the output, and wrapping them would re-encode
 * what the command exists to hand back verbatim.
 */
function parseRetrieveArgs(
  values: Record<string, unknown>,
  positionals: readonly string[],
): RetrieveInvocation {
  const flags = Object.entries(values).filter(([, value]) => value !== undefined);
  if (flags.length > 0) {
    throw new CliUsageError(
      `${CLI_NAME}: retrieve takes no flags (got --${flags.map(([name]) => name).join(', --')}). ` +
        `It prints the exact original bytes for one hash, nothing else — even --json ` +
        `would wrap what must come back verbatim.`,
    );
  }
  if (positionals.length !== 2) {
    throw new CliUsageError(
      `${CLI_NAME}: retrieve needs exactly one hash — the one a marker printed.\n` +
        `  ${CLI_NAME} retrieve 84998967370f38bc`,
    );
  }
  return { mode: 'retrieve', hash: positionals[1]! };
}

/** `stats` reads counters; `--json` is its only flag, everything else is refused. */
function parseStatsArgs(
  values: Record<string, unknown>,
  positionals: readonly string[],
): StatsInvocation {
  if (positionals.length > 1) {
    throw new CliUsageError(
      `${CLI_NAME}: stats takes no further arguments, got ` +
        `${positionals.slice(1).join(', ')}. It reports on the one configured store.`,
    );
  }
  const flags = Object.entries(values).filter(
    ([name, value]) => value !== undefined && name !== 'json',
  );
  if (flags.length > 0) {
    throw new CliUsageError(
      `${CLI_NAME}: stats takes only --json ` +
        `(got --${flags.map(([name]) => name).join(', --')}). It reads counters; there ` +
        `is nothing to budget, focus or plan.`,
    );
  }
  return { mode: 'stats', json: values['json'] === true };
}

/**
 * `hooks` takes an action and at most `--harness`. It is interactive like `init` —
 * the wizard asks everything else — so every other flag is refused rather than
 * ignored.
 */
function parseHooksArgs(
  values: Record<string, unknown>,
  positionals: readonly string[],
): HooksInvocation {
  const action = positionals[1];
  if (action !== 'install' && action !== 'remove') {
    throw new CliUsageError(
      `${CLI_NAME}: hooks needs an action — install or remove.\n` +
        `  ${CLI_NAME} hooks install [--harness <id>]\n` +
        `  ${CLI_NAME} hooks remove [--harness <id>]`,
    );
  }
  if (positionals.length > 2) {
    throw new CliUsageError(
      `${CLI_NAME}: hooks ${action} takes no further arguments, got ` +
        `${positionals.slice(2).join(', ')}.`,
    );
  }
  const flags = Object.entries(values).filter(
    ([name, value]) => value !== undefined && name !== 'harness',
  );
  if (flags.length > 0) {
    throw new CliUsageError(
      `${CLI_NAME}: hooks takes only --harness ` +
        `(got --${flags.map(([name]) => name).join(', --')}). The wizard asks the rest.`,
    );
  }
  const harness = values['harness'];
  return {
    mode: 'hooks',
    action,
    ...(typeof harness === 'string' ? { harness } : {}),
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

/** Membership in the {@link PLANNERS} registry is the whole validation. */
function strategy(raw: string | undefined): Strategy | undefined {
  if (raw === undefined) return undefined;
  if (!isStrategy(raw)) {
    throw new CliUsageError(
      `${CLI_NAME}: unknown --strategy "${raw}". Known: ${STRATEGIES.join(', ')}.`,
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
  ${CLI_NAME} map <dir> --budget <bytes> [--focus <term>]... [--ignore <entry>]... [--cache <dir>]
  ${CLI_NAME} retrieve <hash>
  ${CLI_NAME} stats [--json]
  ${CLI_NAME} hooks install [--harness <id>]
  ${CLI_NAME} hooks remove [--harness <id>]
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

MAP
  ${CLI_NAME} map <dir> renders a ranked symbol map of a whole repository — modelled
  on Aider's repo-map (aider.chat/docs/repomap.html, design by Paul Gauthier) — to
  stdout, with a short report on stderr. Local files only: symlinks are never
  followed, binary files are skipped, and the map writes nothing to disk unless
  --cache names a directory. Every included symbol carries a receipt: its
  definition site and the measured reference counts that ranked it. Unlike a
  smelt run, map never exits
  1: a plan can come back over budget because ${CLI_NAME} refuses to cut regions you
  asked to keep, but the map fits itself to the budget by construction — symbols
  are appended in rank order until the next line would not fit.

RETRIEVE & STATS
  Every marker carries the hash of the bytes it replaced — <<smelt/v1: … —
  retrieve("hash")>> — and the marker's retrieve("hash") is this command:
  ${CLI_NAME} retrieve <hash> prints the exact original bytes on stdout, byte for
  byte, nothing else. That closes the loop from pure shell: an agent that got a
  marker asks for the bytes back with a command instead of a tool call, and the
  retrieval is counted — asking for material back is exactly what the expansion
  rate measures. An unknown hash and damaged bytes are distinct refusals (exit 3):
  "never elided" and "the store was corrupted" call for different responses.

  ${CLI_NAME} stats prints the same store's counters, one \`name value\` per line —
  elisionsStored, bytesStored, retrieveCalls, uniqueRetrieved, expansionRate,
  allElisionsRetrieved — and reading them is NOT counted as a retrieval. --json
  emits the RetrieveStats verbatim in its own versioned envelope.

  Both need somewhere for elisions to outlive the run that made them: a
  smelt.config.json with a directory store (\`${CLI_NAME} init\` writes one). With a
  memory store — or no config — every run's store dies with its process, so there
  is nothing to retrieve across runs, and that is a usage error rather than a
  quiet empty answer.

HOOKS
  ${CLI_NAME} hooks install wires the smelt guard into agent-harness hooks: a
  PreToolUse size-guard that refuses oversized raw reads with the exact ${CLI_NAME}
  replacement command (default on), \`${CLI_NAME} stats\` at session end (default
  on), and an opening \`${CLI_NAME} map\` at session start (opt-in) — plus an
  instruction-file snippet that teaches \`${CLI_NAME} retrieve\` after a deny.
  Harnesses are tiered honestly: verified (Claude Code, Codex), experimental
  (Gemini, Grok, Hermes, Cursor, opencode, Cline — schemas from the capability
  matrix, not yet smoke-tested), advisory (KiloCode, Aider — instructions only,
  nothing enforced). Same discipline as init: every file listed before a final
  confirm, no existing file overwritten without a per-file yes, re-runs edit
  toggles. ${CLI_NAME} hooks remove takes it back out. Guard settings live in
  smelt.config.json ("hooks": {"thresholdBytes", "enforcement": "deny"|"rewrite"});
  deny is the default — rewrite substitutes commands in-flight only where a
  harness supports it, and never silently.

OPTIONS
  --budget <bytes>     Required, unless smelt.config.json sets defaultBudgetBytes.
                       Soft ceiling for the output, in UTF-8 bytes (for map: a hard
                       ceiling, met by construction). No built-in default: a budget
                       ${CLI_NAME} invented would decide for you.
  --focus <term>       What you were looking for. Repeatable. Matching regions and
                       their context survive; the runs between them collapse. For
                       map: symbols matching a term (by name or path) are promoted
                       to the front of the fill order, ranks unchanged.
  --language <id>      Override detection. One of: ${[...SUPPORTED_LANGUAGES, 'unknown'].join(', ')}.
  --strategy <id>      ${STRATEGIES.join(' or ')}. Defaults to lexical, unless
                       smelt.config.json says otherwise. structural parses
                       ${STRUCTURAL_LANGUAGES.join(', ')};
                       any other language is refused, never approximated.
  --ignore <entry>     map only. Repeatable. Replaces the default ignore list
                       (.git, node_modules): a bare name matches any path segment,
                       an entry containing / is a root-relative prefix.
  --cache <dir>        map only. Directory for the tags cache, keyed by content
                       hash. Only when given does the map write to disk at all.
  --harness <id>       hooks only. Skip harness detection and target one id:
                       claude-code, codex, gemini, grok, hermes, cursor, opencode,
                       cline, kilocode, aider.
  --json               Print a JSON envelope on stdout instead of the text:
                       { format, result, elided } for a smelt run — \`result\` is
                       the SmeltResult verbatim, \`elided\` carries the bytes, so
                       the envelope can be reconstructed; feed it back with
                       --reconstruct. For map: { format, map }, the RepoMap
                       structure verbatim.
  --reconstruct        Read a --json envelope and print the original text, byte for
                       byte. This is Law 3 you can run from a shell.
  -h, --help           This text.
  --version            The package version.

EXIT CODES
  0  under budget (map is always under budget by construction)
  1  over budget — the plan did not fit, and the report says so. Never silent.
     map never exits 1; see MAP above.
  2  usage error
  3  smelt refused (a SmeltError: an unbuilt planner, an unknown hash, a corrupt store)
  4  unexpected internal error
`;
}
