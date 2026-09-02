import { CliUsageError } from '../errors.ts';
import type { Strategy } from '../plan/planners.ts';
import type { DetectedLanguage } from '../types.ts';

import { CLI_NAME } from './args.ts';
import type { MapInvocation, SmeltInvocation } from './args.ts';
import { CONFIG_FILE_NAME, resolveStorePath } from './config.ts';
import type { LoadedConfig } from './config.ts';

/**
 * Everything one smelt run needs, fully merged — with a receipt for where each
 * merged value came from.
 *
 * This is the CLI's single merge of flags + config + built-ins. Precedence lives
 * here and nowhere else: `resolveRun` is the only code that may look at a flag and a
 * config default side by side, so a precedence question is always answered by one
 * function instead of by reading two files. `runSmelt` executes this object
 * straight-line, without a `??` of its own.
 */
export interface ResolvedRun {
  readonly budgetBytes: number;
  /** Where the budget came from. A missing budget never gets here — it throws. */
  readonly budgetSource: 'flag' | 'config';
  readonly strategy: Strategy;
  readonly strategySource: 'flag' | 'config' | 'builtin';
  /**
   * The store decision, with `path` already resolved against the config file's
   * directory. `'memory'` is the built-in default — a fresh in-memory store per run.
   */
  readonly store:
    { readonly kind: 'memory' } | { readonly kind: 'directory'; readonly path: string };
  /** Path to read. `undefined` means stdin. Flags only; the config has no say. */
  readonly file?: string;
  readonly focus: readonly string[];
  readonly language?: DetectedLanguage;
  readonly json: boolean;
}

/**
 * Merge one `'smelt'`-mode invocation with the loaded config (or `undefined` when no
 * `smelt.config.json` exists) and the built-in defaults.
 *
 * The precedence is strict and one-directional: an explicit flag always wins over the
 * config, and the config only fills what the flags left unsaid. Built-ins fill last,
 * and only where a built-in exists at all — the budget deliberately has none, so a run
 * with no budget from either source is refused here, in the one module that owns that
 * error.
 *
 * @throws {CliUsageError} when neither `--budget` nor the config names a budget.
 */
export function resolveRun(
  invocation: SmeltInvocation,
  config: LoadedConfig | undefined,
): ResolvedRun {
  const budgetBytes = invocation.budgetBytes ?? config?.config.defaultBudgetBytes;
  if (budgetBytes === undefined) {
    throw new CliUsageError(
      `${CLI_NAME}: --budget is required, in UTF-8 bytes. There is no default, because ` +
        `a budget smelt invented would silently decide how much of your context to ` +
        `throw away. Pass --budget, or set defaultBudgetBytes in ${CONFIG_FILE_NAME} ` +
        `(\`${CLI_NAME} init\` writes one).\n` +
        `  ${CLI_NAME} src/server.ts --budget 4000 --focus handleRequest`,
    );
  }

  const strategy = invocation.strategy ?? config?.config.strategy ?? 'lexical';

  return {
    budgetBytes,
    budgetSource: invocation.budgetBytes !== undefined ? 'flag' : 'config',
    strategy,
    strategySource:
      invocation.strategy !== undefined
        ? 'flag'
        : config?.config.strategy !== undefined
          ? 'config'
          : 'builtin',
    store: resolveStore(config),
    ...(invocation.file === undefined ? {} : { file: invocation.file }),
    focus: invocation.focus,
    ...(invocation.language === undefined ? {} : { language: invocation.language }),
    json: invocation.json,
  };
}

/**
 * The store the config asks for, with `path` resolved relative to the config file —
 * one config serves every subdirectory it covers without scattering store roots.
 * There is no store flag, so this leg of the merge is config-or-built-in only.
 */
function resolveStore(config: LoadedConfig | undefined): ResolvedRun['store'] {
  if (config?.config.store === undefined || config.config.store.kind === 'memory') {
    return { kind: 'memory' };
  }
  return { kind: 'directory', path: resolveStorePath(config, config.config.store.path) };
}

/**
 * Everything one `smelt map` run needs, fully merged — {@link ResolvedRun}'s sibling,
 * not a contortion of it. The two commands share exactly one merged value (the
 * budget), so they share the *module* that owns precedence and the budget-required
 * refusal, not a struct whose fields would mostly be lies for one of them: a map has
 * no store, no strategy, no stdin, and its ignore/cache legs mean nothing to a
 * single-blob run.
 */
export interface ResolvedMapRun {
  readonly budgetBytes: number;
  /** Where the budget came from. A missing budget never gets here — it throws. */
  readonly budgetSource: 'flag' | 'config';
  readonly dir: string;
  readonly focus: readonly string[];
  /** `undefined` means "use the library's default ignore list". Flags only. */
  readonly ignore?: readonly string[];
  /** Only when present does the map write to disk. Flags only; the config has no say. */
  readonly cacheDir?: string;
  readonly json: boolean;
}

/**
 * Merge one `'map'`-mode invocation with the loaded config and the built-ins. The
 * config contributes exactly what it contributes to a smelt run — `defaultBudgetBytes`,
 * a default the user chose explicitly — and nothing else: the store and strategy legs
 * are single-blob concerns, and the map ignores them rather than reinterpreting them.
 *
 * @throws {CliUsageError} when neither `--budget` nor the config names a budget.
 */
export function resolveMapRun(
  invocation: MapInvocation,
  config: LoadedConfig | undefined,
): ResolvedMapRun {
  const budgetBytes = invocation.budgetBytes ?? config?.config.defaultBudgetBytes;
  if (budgetBytes === undefined) {
    throw new CliUsageError(
      `${CLI_NAME}: --budget is required, in UTF-8 bytes. There is no default, because ` +
        `a budget ${CLI_NAME} invented would silently decide how much of the map to ` +
        `leave out. Pass --budget, or set defaultBudgetBytes in ${CONFIG_FILE_NAME} ` +
        `(\`${CLI_NAME} init\` writes one).\n` +
        `  ${CLI_NAME} map src --budget 4000 --focus handleRequest`,
    );
  }

  return {
    budgetBytes,
    budgetSource: invocation.budgetBytes !== undefined ? 'flag' : 'config',
    dir: invocation.dir,
    focus: invocation.focus,
    ...(invocation.ignore.length === 0 ? {} : { ignore: invocation.ignore }),
    ...(invocation.cacheDir === undefined ? {} : { cacheDir: invocation.cacheDir }),
    json: invocation.json,
  };
}
