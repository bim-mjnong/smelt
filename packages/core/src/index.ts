import { applyPlan, markerForLanguage, reconstruct } from './apply.ts';
import type { ApplyOptions, MarkerBuilder, MarkerInfo } from './apply.ts';
import { detectLanguage } from './detect.ts';
import { SmeltError } from './errors.ts';
import type { LexicalPlannerOptions } from './plan/lexical.ts';
import { PLANNERS } from './plan/planners.ts';
import type { Strategy } from './plan/planners.ts';
import type { StructuralPlannerOptions } from './plan/structural.ts';
import { createRetrieveTool } from './retrieve.ts';
import { MemoryElisionStore } from './store.ts';
import type {
  DetectedLanguage,
  ElisionStore,
  Measure,
  PlanInput,
  Planner,
  RetrieveStats,
  RetrieveTool,
  SmeltResult,
} from './types.ts';

export type { ApplyOptions, MarkerBuilder, MarkerInfo };
export { applyPlan, defaultMarker, MARKER_FORMAT_VERSION, reconstruct } from './apply.ts';
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
export { clearGrammarCache, grammarPath, loadGrammar, WASM_BY_LANGUAGE } from './plan/grammar.ts';
export { LEXICAL_PLANNER_ID, LexicalPlanner, planLexical } from './plan/lexical.ts';
export type { LexicalPlannerOptions } from './plan/lexical.ts';
export { isStrategy, PLANNERS, STRATEGIES } from './plan/planners.ts';
export type { PlannerFactoryOptions } from './plan/planners.ts';
export {
  planStructural,
  STRUCTURAL_LANGUAGES,
  STRUCTURAL_PLANNER_ID,
  StructuralPlanner,
} from './plan/structural.ts';
export type { StructuralLanguage, StructuralPlannerOptions } from './plan/structural.ts';
export { createRetrieveTool, RETRIEVE_TOOL_NAME } from './retrieve.ts';
export { unconfiguredDistillStage, unconfiguredRerankStage } from './stages.ts';
export { MemoryElisionStore } from './store.ts';
export {
  DIRECTORY_STORE_FORMAT,
  DIRECTORY_STORE_VERSION,
  DirectoryElisionStore,
} from './store-dir.ts';
export type { DirectoryElisionStoreOptions } from './store-dir.ts';
export * from './types.ts';
export {
  CLI_JSON_FORMAT,
  CLI_NAME,
  cliUsage,
  EXIT,
  formatReport,
  parseSmeltArgs,
  runCli,
} from './cli/run.ts';
export type { CliIo, CliJsonEnvelope, SmeltInvocation } from './cli/run.ts';
export {
  ANTHROPIC_PROMPT_CACHE_FACTS,
  CACHE_BREAKER_RULES,
  detectCacheBreakers,
  findPrefixDivergence,
} from './cache/prefix.ts';
export type {
  CacheWarning,
  PrefixDivergence,
  PromptStructure,
  PromptTool,
} from './cache/prefix.ts';
export { MARKER_LINE_COMMENT_LEADERS, markerForLanguage } from './apply.ts';
export {
  buildRepoMap,
  DEFAULT_REPO_IGNORE,
  REPO_MAP_CACHE_CORRUPT_RULE,
  REPO_MAP_ID,
  REPO_MAP_PATH_ONLY_RULE,
  REPO_MAP_RANKED_RULE,
  REPO_MAP_UNREFERENCED_RULE,
} from './repomap/map.ts';
export type {
  RepoMap,
  RepoMapCacheCounts,
  RepoMapEntry,
  RepoMapOptions,
  RepoMapPathEntry,
  RepoMapReason,
  RepoMapWarning,
} from './repomap/map.ts';
export { PAGERANK_DAMPING, PAGERANK_ITERATIONS, rankDefinitions } from './repomap/rank.ts';
export type { FileTagsEntry, RankedDefinition } from './repomap/rank.ts';
export { extractTags } from './repomap/tags.ts';
export type { DefinitionTag, FileTags, ReferenceTag } from './repomap/tags.ts';
export { TAGS_CACHE_FORMAT, TAGS_CACHE_VERSION, tagsCacheKey } from './repomap/cache.ts';
export {
  CONFIG_FILE_NAME,
  CONFIG_VERSION,
  findConfigFile,
  loadNearestConfig,
  parseConfig,
  resolveStorePath,
} from './cli/config.ts';
export type { LoadedConfig, SmeltConfig, SmeltConfigStore } from './cli/config.ts';
export {
  MEASURE_STUB_FILE,
  measureStubSource,
  renderConfig,
  RERANK_STUB_FILE,
  rerankStubSource,
  runInit,
} from './cli/init.ts';
export type { InitIo } from './cli/init.ts';
export { retrieveStats } from './stats.ts';
export type { RawRetrieveCounters } from './stats.ts';
export {
  LANGUAGE_PROFILES,
  profileFor,
  profileForPath,
  structuralLanguages,
} from './lang/registry.ts';
export type { LanguageProfile, LanguageStructure, RepoMapFacts } from './lang/profile.ts';
export { resolveRun } from './cli/resolve.ts';
export type { ResolvedRun } from './cli/resolve.ts';

/**
 * Which planner a smelter uses, named by string. The names, their factories, and this
 * type all come from the one {@link PLANNERS} registry in `src/plan/planners.ts`, so
 * the CLI's validation and help text cannot drift from what `createSmelter` builds.
 */
export type { Strategy } from './plan/planners.ts';

export interface SmelterConfig {
  /** Where elided bytes live. Defaults to a fresh {@link MemoryElisionStore}. */
  readonly store?: ElisionStore;
  /** Used when a `smelt()` call omits `budgetBytes`. No global default is assumed. */
  readonly defaultBudgetBytes?: number;
  /**
   * A constructed planner instance. Wins over `strategy`: the registry is a
   * convenience for the shipped planners, and an instance you built yourself is
   * always more specific than a name.
   */
  readonly planner?: Planner;
  readonly strategy?: Strategy;
  readonly marker?: MarkerBuilder;
  /**
   * Your own counter, so results carry a number in your unit as well as in bytes.
   * The budget stays in bytes — see {@link Measure} and `docs/HANDOFF.md` § "Decision 1".
   */
  readonly measure?: Measure;
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
  // A constructed instance wins over a strategy name; the registry serves the names.
  const planner: Planner = config.planner ?? PLANNERS[config.strategy ?? 'lexical'](config);
  const applyOptions: ApplyOptions = {
    ...(config.marker === undefined ? {} : { marker: config.marker }),
    ...(config.measure === undefined ? {} : { measure: config.measure }),
  };

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
      // The marker follows the *result's* language: it lands behind the language's
      // line-comment leader (see MARKER_LINE_COMMENT_LEADERS), because a bare marker
      // line breaks the survivor's syntax in every grammar tested. A caller-supplied
      // marker builder always wins.
      const marker = config.marker ?? markerForLanguage(plan.language);
      return applyPlan(text, plan, store, { ...applyOptions, marker });
    },
  };
}
