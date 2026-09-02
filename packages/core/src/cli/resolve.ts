import { CliUsageError } from '../errors.ts';
import type { Strategy } from '../plan/planners.ts';
import type { DetectedLanguage } from '../types.ts';

import { CLI_NAME } from './args.ts';
import type { SmeltInvocation } from './args.ts';
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
