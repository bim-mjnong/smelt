import { readFileSync } from 'node:fs';
import process from 'node:process';

import { reconstruct } from '../apply.ts';
import { CliUsageError, SmeltError } from '../errors.ts';
import { createSmelter } from '../index.ts';
import type { SmeltCallOptions } from '../index.ts';
import { MemoryElisionStore } from '../store.ts';
import { DirectoryElisionStore } from '../store-dir.ts';
import type { ElisionStore, SmeltResult } from '../types.ts';

import { CLI_NAME, cliUsage, parseSmeltArgs } from './args.ts';
import type { SmeltInvocation } from './args.ts';
import { CONFIG_FILE_NAME, loadNearestConfig, resolveStorePath } from './config.ts';
import type { LoadedConfig } from './config.ts';
import { runInit } from './init.ts';
import { formatReport } from './report.ts';

export { CLI_NAME, cliUsage, parseSmeltArgs } from './args.ts';
export type { SmeltInvocation } from './args.ts';
export { formatReport } from './report.ts';
export type { ReportInput } from './report.ts';

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

/**
 * The `--json` envelope format, versioned like the marker for the same reason: this is
 * a surface other programs parse, so a change to it has to be identifiable rather than
 * silent.
 */
export const CLI_JSON_FORMAT = 'smelt-cli/v1';

/**
 * What `--json` prints, and what `--reconstruct` reads back.
 *
 * `result` is the {@link SmeltResult} **verbatim** — nothing renamed, nothing dropped —
 * so it can be diffed in a test. `elided` is the other half, and it is here because a
 * result on its own is *not* reconstructible: Law 3 is a property of the result plus
 * the store that holds its bytes, and a file claiming to prove the round trip while
 * carrying only half of it would prove nothing.
 */
export interface CliJsonEnvelope {
  readonly format: string;
  readonly result: SmeltResult;
  /** hash → the exact elided bytes. Keys match `result.elisions[].hash`. */
  readonly elided: Readonly<Record<string, string>>;
}

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

/**
 * The whole CLI, as a function that returns an exit code instead of calling `exit`.
 *
 * Smelted text goes to stdout and the report goes to stderr, so `smelt big.log
 * --budget 4000 > small.log` leaves the human-readable part on the terminal and the
 * payload in the file.
 */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    const invocation = parseSmeltArgs(argv);

    switch (invocation.mode) {
      case 'help':
        io.stdout(cliUsage());
        return EXIT.ok;
      case 'version':
        io.stdout(`${io.version}\n`);
        return EXIT.ok;
      case 'reconstruct':
        return runReconstruct(readInput(invocation.file, io), io);
      case 'init': {
        if (io.initInput === undefined) {
          throw new CliUsageError(
            `${CLI_NAME}: init is interactive, and this invocation has no interactive ` +
              `input stream. Run \`${CLI_NAME} init\` from a terminal.`,
          );
        }
        return await runInit({
          input: io.initInput,
          output: io.stdout,
          cwd: io.cwd ?? process.cwd(),
        });
      }
      case 'smelt':
        return await runSmelt(invocation, io);
    }
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.stderr(`${error.message}\n`);
      return EXIT.usage;
    }
    if (error instanceof SmeltError) {
      io.stderr(`${error.name}: ${error.message}\n`);
      return EXIT.refused;
    }
    throw error;
  }
}

/**
 * One smelt run, with `smelt.config.json` supplying DEFAULTS and nothing more.
 *
 * The precedence is strict and one-directional: an explicit flag always wins over the
 * config, and the config only fills what the flags left unsaid. A malformed config is
 * a usage error even when every flag was given — a config smelt silently skipped
 * would be a setting the user *believed* was in force.
 */
async function runSmelt(invocation: SmeltInvocation, io: CliIo): Promise<number> {
  const loaded = loadNearestConfig(io.cwd ?? process.cwd());

  const budgetBytes = invocation.budgetBytes ?? loaded?.config.defaultBudgetBytes;
  if (budgetBytes === undefined) {
    throw new CliUsageError(
      `${CLI_NAME}: --budget is required, in UTF-8 bytes. There is no default, because ` +
        `a budget smelt invented would silently decide how much of your context to ` +
        `throw away. Pass --budget, or set defaultBudgetBytes in ${CONFIG_FILE_NAME} ` +
        `(\`${CLI_NAME} init\` writes one).\n` +
        `  ${CLI_NAME} src/server.ts --budget 4000 --focus handleRequest`,
    );
  }

  const inputText = readInput(invocation.file, io);
  const source = invocation.file ?? '<stdin>';

  const strategy = invocation.strategy ?? loaded?.config.strategy ?? 'lexical';
  const store = storeFromConfig(loaded);
  const smelter = createSmelter({ strategy, ...(store === undefined ? {} : { store }) });
  const options: SmeltCallOptions = {
    budgetBytes,
    ...(invocation.file === undefined ? {} : { path: invocation.file }),
    ...(invocation.language === undefined ? {} : { language: invocation.language }),
    ...(invocation.focus.length === 0 ? {} : { focus: invocation.focus }),
  };
  const result = await smelter.smelt(inputText, options);

  if (invocation.json) {
    io.stdout(`${JSON.stringify(envelope(result, smelter.store), null, 2)}\n`);
  } else {
    io.stdout(result.text);
  }
  io.stderr(formatReport({ result, source, budgetBytes, inputText }));

  return result.outputBytes > budgetBytes ? EXIT.overBudget : EXIT.ok;
}

/**
 * The store the config asks for, or `undefined` for the library's own default
 * (a fresh in-memory store). `store.path` resolves relative to the config file, so
 * one config serves every subdirectory it covers without scattering store roots.
 */
function storeFromConfig(loaded: LoadedConfig | undefined): ElisionStore | undefined {
  if (loaded?.config.store === undefined || loaded.config.store.kind === 'memory') {
    return undefined;
  }
  return new DirectoryElisionStore(resolveStorePath(loaded, loaded.config.store.path));
}

/**
 * Law 3, from a shell.
 *
 * This is deliberately not "print the text and hope": it rebuilds the store from the
 * envelope, checks every hash against the bytes it claims to key, and checks the
 * reconstructed length against the `inputBytes` the result recorded at the time of the
 * cut. A round trip that quietly returns almost-right text is the failure this whole
 * repository is arranged against.
 */
function runReconstruct(text: string, io: CliIo): number {
  const { result, elided } = parseEnvelope(text);
  const store = new MemoryElisionStore();

  for (const [hash, content] of Object.entries(elided)) {
    const actual = store.put(content);
    if (actual !== hash) {
      throw new CliUsageError(
        `${CLI_NAME}: envelope is not self-consistent — it stores bytes under ` +
          `"${hash}" that actually hash to "${actual}". Refusing to reconstruct from it.`,
      );
    }
  }
  for (const elision of result.elisions) {
    if (!store.has(elision.hash)) {
      throw new CliUsageError(
        `${CLI_NAME}: envelope is missing the bytes for "${elision.hash}". A result ` +
          `without its elided bytes cannot be reconstructed; re-run with --json.`,
      );
    }
  }

  const original = reconstruct(result, store);
  const bytes = Buffer.byteLength(original, 'utf8');
  if (bytes !== result.inputBytes) {
    throw new SmeltError(
      `${CLI_NAME}: reconstruction produced ${String(bytes)} bytes but the result ` +
        `recorded ${String(result.inputBytes)}. The round trip did not close.`,
    );
  }

  io.stdout(original);
  io.stderr(
    `${CLI_NAME}  reconstructed ${String(result.inputBytes)} B from ` +
      `${String(result.elisions.length)} elisions — byte for byte\n`,
  );
  return EXIT.ok;
}

/** `peek`, not `retrieve`: writing a file is not the model asking for anything back. */
function envelope(result: SmeltResult, store: ElisionStore): CliJsonEnvelope {
  const elided: Record<string, string> = {};
  for (const elision of result.elisions) {
    const content = store.peek(elision.hash);
    if (content === undefined) {
      throw new SmeltError(
        `${CLI_NAME}: the store does not hold "${elision.hash}", which its own result ` +
          `says it elided. Refusing to write an envelope that cannot round-trip.`,
      );
    }
    elided[elision.hash] = content;
  }
  return { format: CLI_JSON_FORMAT, result, elided };
}

function parseEnvelope(text: string): CliJsonEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new CliUsageError(
      `${CLI_NAME}: --reconstruct expected a --json envelope, and this is not JSON: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  if (typeof value !== 'object' || value === null) {
    throw new CliUsageError(`${CLI_NAME}: --reconstruct expected a JSON object.`);
  }
  const fields = value as Record<string, unknown>;

  if (fields['format'] !== CLI_JSON_FORMAT) {
    throw new CliUsageError(
      `${CLI_NAME}: this envelope says format "${String(fields['format'])}"; this build ` +
        `reads "${CLI_JSON_FORMAT}". Formats are versioned so a mismatch is visible ` +
        `instead of being half-understood.`,
    );
  }

  const result = fields['result'];
  if (typeof result !== 'object' || result === null) {
    throw new CliUsageError(`${CLI_NAME}: envelope has no \`result\` object.`);
  }
  const resultFields = result as Record<string, unknown>;
  if (
    typeof resultFields['text'] !== 'string' ||
    typeof resultFields['inputBytes'] !== 'number' ||
    !Array.isArray(resultFields['elisions'])
  ) {
    throw new CliUsageError(
      `${CLI_NAME}: envelope's \`result\` is missing text, inputBytes or elisions.`,
    );
  }

  const elided = fields['elided'];
  if (typeof elided !== 'object' || elided === null) {
    throw new CliUsageError(`${CLI_NAME}: envelope has no \`elided\` map.`);
  }
  for (const [hash, content] of Object.entries(elided)) {
    if (typeof content !== 'string') {
      throw new CliUsageError(`${CLI_NAME}: envelope's \`elided["${hash}"]\` is not a string.`);
    }
  }

  return {
    format: CLI_JSON_FORMAT,
    result: result as unknown as SmeltResult,
    elided: elided as Record<string, string>,
  };
}

function readInput(file: string | undefined, io: CliIo): string {
  if (file === undefined) return io.stdin();
  try {
    return readFileSync(file, 'utf8');
  } catch (cause) {
    throw new CliUsageError(
      `${CLI_NAME}: cannot read "${file}": ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}
