import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { CliUsageError } from '../errors.ts';

import { CLI_NAME } from './args.ts';

/**
 * `smelt.config.json` — CLI defaults, and nothing more.
 *
 * This file exists so `smelt` can be run without retyping the same flags, and it is
 * deliberately a *CLI* concern: the programmatic API never reads it. A library that
 * reads config files off the caller's disk is a library whose behaviour depends on
 * where it was invoked from, which is exactly the class of invisible input smelt
 * refuses. `createSmelter()` takes explicit arguments; the CLI translates this file
 * into those arguments, and explicit flags always win over it.
 *
 * The schema is versioned (`"smeltConfig": 1`) for the same reason the marker and the
 * `--json` envelope are: files outlive the binaries that wrote them, and a mismatch
 * must be identifiable rather than half-understood. Parsing is strict — an unknown
 * key, a wrong type, or an unknown version is a {@link CliUsageError}, never a shrug.
 * A config the CLI silently ignored would be a budget the user *thought* they set.
 */

/** The file name looked for, from the working directory upward. */
export const CONFIG_FILE_NAME = 'smelt.config.json';

/** The schema version this build reads and writes. */
export const CONFIG_VERSION = 1;

/** Where the CLI's elision store lives between runs. */
export type SmeltConfigStore =
  | { readonly kind: 'memory' }
  | {
      readonly kind: 'directory';
      /** Resolved relative to the directory holding the config file, not the cwd. */
      readonly path: string;
    };

/** The parsed shape of `smelt.config.json`. Every field beyond the version is optional. */
export interface SmeltConfig {
  readonly smeltConfig: typeof CONFIG_VERSION;
  /** Used when a `smelt` run omits `--budget`. UTF-8 bytes, like every smelt budget. */
  readonly defaultBudgetBytes?: number;
  /** Used when a run omits `--strategy`. */
  readonly strategy?: 'lexical' | 'structural';
  /** Used for every run; there is no store flag. Defaults to memory when absent. */
  readonly store?: SmeltConfigStore;
}

/** A config plus where it was found — the path matters for resolving `store.path`. */
export interface LoadedConfig {
  readonly path: string;
  readonly config: SmeltConfig;
}

/**
 * The nearest `smelt.config.json`, walking up from `cwd` to the filesystem root —
 * the same discovery shape as `package.json`, so a config at a repo root covers the
 * whole tree. `undefined` when there is none, which is not an error: flags alone are
 * a complete interface.
 */
export function findConfigFile(cwd: string): string | undefined {
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, CONFIG_FILE_NAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Find and parse the nearest config. `undefined` when no file exists; a file that
 * exists but is malformed **throws** — see {@link parseConfig}. The distinction is the
 * point: "no config" is a fine state, "a config you cannot have meant" is not.
 *
 * @throws {CliUsageError} when a config file exists and is malformed.
 */
export function loadNearestConfig(cwd: string): LoadedConfig | undefined {
  const path = findConfigFile(cwd);
  if (path === undefined) return undefined;
  return { path, config: parseConfig(readFileSync(path, 'utf8'), path) };
}

/**
 * Parse and validate one config file, strictly.
 *
 * Strict means: unknown keys are refused, not skipped. A typo'd `defaultBudgetByte`
 * that parsed cleanly would leave the user believing a default was set while every
 * run ignored it — a config error whose failure mode is *silence*, which is the one
 * failure shape this project refuses everywhere else too.
 *
 * @throws {CliUsageError} naming the file and the exact problem.
 */
export function parseConfig(text: string, path: string): SmeltConfig {
  const bad = (why: string): CliUsageError =>
    new CliUsageError(
      `${CLI_NAME}: malformed ${CONFIG_FILE_NAME} at ${path}: ${why}\n` +
        `Fix it or delete it — a config smelt cannot read is never silently ignored. ` +
        `\`${CLI_NAME} init\` can rewrite it.`,
    );

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw bad(`not JSON (${cause instanceof Error ? cause.message : String(cause)}).`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw bad('expected a JSON object at the top level.');
  }
  const fields = value as Record<string, unknown>;

  if (fields['smeltConfig'] !== CONFIG_VERSION) {
    throw bad(
      `"smeltConfig" is ${JSON.stringify(fields['smeltConfig'])}; this build reads version ` +
        `${String(CONFIG_VERSION)}. The schema is versioned so a mismatch is visible ` +
        `instead of half-understood.`,
    );
  }

  const known = ['smeltConfig', 'defaultBudgetBytes', 'strategy', 'store'];
  const unknown = Object.keys(fields).filter((key) => !known.includes(key));
  if (unknown.length > 0) {
    throw bad(
      `unknown key${unknown.length === 1 ? '' : 's'} ${unknown.map((k) => `"${k}"`).join(', ')}. ` +
        `Known keys: ${known.join(', ')}. Unknown keys are refused because a typo that ` +
        `parsed cleanly would be a setting you believed was set.`,
    );
  }

  const budget = fields['defaultBudgetBytes'];
  if (budget !== undefined && (typeof budget !== 'number' || !Number.isInteger(budget))) {
    throw bad(`"defaultBudgetBytes" must be a whole number of UTF-8 bytes.`);
  }
  if (typeof budget === 'number' && budget <= 0) {
    throw bad(`"defaultBudgetBytes" must be greater than zero, got ${String(budget)}.`);
  }

  const strategy = fields['strategy'];
  if (strategy !== undefined && strategy !== 'lexical' && strategy !== 'structural') {
    throw bad(`"strategy" must be "lexical" or "structural", got ${JSON.stringify(strategy)}.`);
  }

  const store = parseStore(fields['store'], bad);

  return {
    smeltConfig: CONFIG_VERSION,
    ...(budget === undefined ? {} : { defaultBudgetBytes: budget }),
    ...(strategy === undefined ? {} : { strategy }),
    ...(store === undefined ? {} : { store }),
  };
}

function parseStore(
  value: unknown,
  bad: (why: string) => CliUsageError,
): SmeltConfigStore | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw bad(`"store" must be an object like {"kind":"memory"} or {"kind":"directory","path":…}.`);
  }
  const fields = value as Record<string, unknown>;
  const kind = fields['kind'];
  if (kind === 'memory') {
    const extra = Object.keys(fields).filter((key) => key !== 'kind');
    if (extra.length > 0) throw bad(`"store" of kind "memory" takes no other keys.`);
    return { kind: 'memory' };
  }
  if (kind === 'directory') {
    const path = fields['path'];
    if (typeof path !== 'string' || path === '') {
      throw bad(`"store" of kind "directory" needs a non-empty "path".`);
    }
    const extra = Object.keys(fields).filter((key) => key !== 'kind' && key !== 'path');
    if (extra.length > 0) throw bad(`"store" of kind "directory" takes only "kind" and "path".`);
    return { kind: 'directory', path };
  }
  throw bad(`"store".kind must be "memory" or "directory", got ${JSON.stringify(kind)}.`);
}

/** `store.path` is relative to the config file, so the config works from any cwd. */
export function resolveStorePath(loaded: LoadedConfig, path: string): string {
  return resolve(dirname(loaded.path), path);
}
