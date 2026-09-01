import { applyPlan, reconstruct } from './apply.ts';
import type { ApplyOptions, MarkerBuilder, MarkerInfo } from './apply.ts';
import { detectLanguage } from './detect.ts';
import { SmeltError } from './errors.ts';
import { LexicalPlanner } from './plan/lexical.ts';
import type { LexicalPlannerOptions } from './plan/lexical.ts';
import { StructuralPlanner } from './plan/structural.ts';
import type { StructuralPlannerOptions } from './plan/structural.ts';
import { createRetrieveTool } from './retrieve.ts';
import { MemoryElisionStore } from './store.ts';
import type {
  DetectedLanguage,
  ElisionStore,
  PlanInput,
  Planner,
  RetrieveStats,
  RetrieveTool,
  SmeltResult,
} from './types.ts';

export type { ApplyOptions, MarkerBuilder, MarkerInfo };
export { applyPlan, defaultMarker, reconstruct } from './apply.ts';
export { detectLanguage, SUPPORTED_LANGUAGES } from './detect.ts';
export * from './errors.ts';
export { contentHash, HASH_LENGTH } from './hash.ts';
export {
  ALLOWED_NODE_BUILTINS,
  ALLOWED_PACKAGES,
  ALLOWED_URL_SCHEMES,
  assertLocalResource,
  FORBIDDEN_GLOBALS,
  FORBIDDEN_NODE_MODULES,
  FORBIDDEN_PACKAGES,
} from './net/policy.ts';
export { clearGrammarCache, grammarPath, loadGrammar } from './plan/grammar.ts';
export { LEXICAL_PLANNER_ID, LexicalPlanner, planLexical } from './plan/lexical.ts';
export type { LexicalPlannerOptions } from './plan/lexical.ts';
export { STRUCTURAL_PLANNER_ID, StructuralPlanner } from './plan/structural.ts';
export type { StructuralPlannerOptions } from './plan/structural.ts';
export { createRetrieveTool, RETRIEVE_TOOL_NAME } from './retrieve.ts';
export { unconfiguredDistillStage, unconfiguredRerankStage } from './stages.ts';
export { MemoryElisionStore } from './store.ts';
export * from './types.ts';

/** Which planner a smelter uses. `'structural'` throws in v1 — see {@link StructuralPlanner}. */
export type Strategy = 'lexical' | 'structural';

export interface SmelterConfig {
  /** Where elided bytes live. Defaults to a fresh {@link MemoryElisionStore}. */
  readonly store?: ElisionStore;
  /** Used when a `smelt()` call omits `budgetBytes`. No global default is assumed. */
  readonly defaultBudgetBytes?: number;
  readonly strategy?: Strategy;
  readonly marker?: MarkerBuilder;
  readonly lexical?: LexicalPlannerOptions;
  readonly structural?: StructuralPlannerOptions;
}

/** Options for one `smelt()` call. `budgetBytes` may come from the smelter instead. */
export interface SmeltCallOptions {
  readonly budgetBytes?: number;
  readonly path?: string;
  readonly language?: DetectedLanguage;
  readonly focus?: readonly string[];
}

/**
 * One smelter, one store, one set of counters. The store is the reason this is an
 * object rather than a free function: elisions are only reversible for as long as
 * something holds them, so the thing that cuts and the thing that remembers have the
 * same lifetime by construction.
 */
export interface Smelter {
  /** Shrink one blob of text. Never mutates its input. */
  smelt(text: string, options?: SmeltCallOptions): Promise<SmeltResult>;
  /** The exact original text of a previous result. @throws {UnknownHashError} */
  reconstruct(result: SmeltResult): string;
  /** One elided run, counted as a retrieval. @throws {UnknownHashError} */
  retrieve(hash: string): string;
  /** The tool to expose to your model. See {@link RetrieveTool}. */
  readonly tool: RetrieveTool;
  /** Live counters, including the expansion rate. See {@link RetrieveStats}. */
  stats(): RetrieveStats;
  /** The underlying store, for consumers that persist or inspect it. */
  readonly store: ElisionStore;
}

/**
 * Build a smelter.
 *
 * ```ts
 * const smelter = createSmelter();
 * const result = await smelter.smelt(toolOutput, {
 *   path: 'src/server.ts',
 *   budgetBytes: 4_000,
 *   focus: ['handleRequest'],
 * });
 * // result.text goes to the model; smelter.tool lets it ask for the rest back.
 * // smelter.stats().expansionRate tells you whether you cut too much.
 * ```
 */
export function createSmelter(config: SmelterConfig = {}): Smelter {
  const store = config.store ?? new MemoryElisionStore();
  const strategy = config.strategy ?? 'lexical';
  const planner: Planner =
    strategy === 'structural'
      ? new StructuralPlanner(config.structural ?? {})
      : new LexicalPlanner(config.lexical ?? {});
  const applyOptions: ApplyOptions = config.marker === undefined ? {} : { marker: config.marker };

  return {
    store,
    tool: createRetrieveTool(store),
    stats: () => store.stats(),
    retrieve: (hash) => store.retrieve(hash),
    reconstruct: (result) => reconstruct(result, store),
    async smelt(text, options = {}) {
      const budgetBytes = options.budgetBytes ?? config.defaultBudgetBytes;
      if (budgetBytes === undefined) {
        throw new SmeltError(
          'smelt: no budget. Pass `budgetBytes` to smelt() or `defaultBudgetBytes` to ' +
            'createSmelter(). There is no built-in default, because a budget smelt ' +
            'invented would silently decide how much of your context to throw away.',
        );
      }
      const language = options.language ?? detectLanguage(options.path);
      const input: PlanInput = {
        text,
        language,
        budgetBytes,
        ...(options.focus === undefined ? {} : { focus: options.focus }),
      };
      const plan = await planner.plan(input);
      return applyPlan(text, plan, store, applyOptions);
    },
  };
}
