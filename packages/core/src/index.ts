import { applyPlan, markerForLanguage, reconstruct } from './apply.ts';
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
export { planStructural, STRUCTURAL_PLANNER_ID, StructuralPlanner } from './plan/structural.ts';
export type { StructuralPlannerOptions } from './plan/structural.ts';
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

/**
 * Which planner a smelter uses. `'structural'` parses TypeScript, TSX, Rust, Python
 * and Go with a bundled grammar and throws {@link GrammarUnavailableError} for
 * anything else — never a silent lexical fallback. See {@link StructuralPlanner}.
 */
export type Strategy = 'lexical' | 'structural';

export interface SmelterConfig {
  /** Where elided bytes live. Defaults to a fresh {@link MemoryElisionStore}. */
  readonly store?: ElisionStore;
  /** Used when a `smelt()` call omits `budgetBytes`. No global default is assumed. */
  readonly defaultBudgetBytes?: number;
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
  const strategy = config.strategy ?? 'lexical';
  const planner: Planner =
    strategy === 'structural'
      ? new StructuralPlanner(config.structural ?? {})
      : new LexicalPlanner(config.lexical ?? {});
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
