/** Languages smelt can parse structurally. Everything else falls back to the lexical planner. */
export type LanguageId = 'typescript' | 'tsx' | 'javascript' | 'rust' | 'python' | 'go';

/** `'unknown'` is a first-class outcome, not a failure: it selects the lexical planner. */
export type DetectedLanguage = LanguageId | 'unknown';

/** A half-open byte range `[start, end)` into the UTF-8 bytes of the input. */
export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Why a range was elided, in two registers: a stable id for counters, and a sentence
 * a human can read in a diff. Law 2 — every elision is explainable — lives here:
 * if you cannot write the sentence, the rule does not ship.
 */
export interface ElisionReason {
  /** Stable machine id, e.g. `'sibling-collapse'`, `'line-window'`. */
  readonly rule: string;
  /** e.g. `'collapsed 3 sibling functions'`. Present tense, no trailing period. */
  readonly explanation: string;
}

/** One range a planner proposes to remove. Plans are pure data — inspectable and testable. */
export interface PlannedElision {
  readonly range: ByteRange;
  readonly reason: ElisionReason;
}

/**
 * The complete output of a planner: the whole decision, before anything is mutated.
 * A plan can be logged, diffed, snapshot-tested, and rejected without touching the text.
 */
export interface ElisionPlan {
  readonly planner: string;
  readonly language: DetectedLanguage;
  readonly elisions: readonly PlannedElision[];
}

/** What the caller hands a planner. */
export interface PlanInput {
  readonly text: string;
  readonly language: DetectedLanguage;
  /** Soft ceiling for the emitted output, in UTF-8 bytes. Planners aim under it. */
  readonly budgetBytes: number;
  /**
   * What the caller was actually looking for — grep pattern, symbol name, error string.
   * Planners keep matching regions and collapse around them.
   */
  readonly focus?: readonly string[];
}

/**
 * A planner decides *what* to remove. It never removes anything itself; `applyPlan`
 * does that. Keeping the decision and the mutation apart is what makes the decision
 * testable in isolation.
 */
export interface Planner {
  readonly id: string;
  plan(input: PlanInput): Promise<ElisionPlan>;
}

/** One elision that actually happened, with the receipt needed to undo it. */
export interface AppliedElision {
  /** Content hash of the removed bytes — the key `retrieve()` takes. */
  readonly hash: string;
  /** Where the removed bytes were in the *input*. */
  readonly range: ByteRange;
  /**
   * Where the marker sits in the *output*. Law 3 — every elision is reversible — needs
   * this: {@link Reconstructor} splices stored bytes back over these ranges. Without it,
   * "reversible" would mean parsing markers back out of the text, which is a guess.
   * This is a fact recorded at the moment of the cut.
   */
  readonly outputRange: ByteRange;
  /** Size of the removed content, in UTF-8 bytes. */
  readonly bytes: number;
  readonly reason: ElisionReason;
  /** The exact marker text substituted into the output. */
  readonly marker: string;
}

/** The result of smelting one blob of text. */
export interface SmeltResult {
  readonly text: string;
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly planner: string;
  readonly language: DetectedLanguage;
  readonly elisions: readonly AppliedElision[];
}

/** Options for a single `smelt()` call. */
export interface SmeltOptions {
  /** Soft ceiling for the emitted output, in UTF-8 bytes. */
  readonly budgetBytes: number;
  /** Filename or path, used to detect the language. Optional; detection falls back to `'unknown'`. */
  readonly path?: string;
  /** Override language detection entirely. */
  readonly language?: DetectedLanguage;
  /** What the caller was looking for. See {@link PlanInput.focus}. */
  readonly focus?: readonly string[];
}

/**
 * Reversibility, as a callable. Takes a {@link SmeltResult} and the store that holds its
 * elided bytes, and returns the original text — byte for byte.
 */
export type Reconstructor = (result: SmeltResult, store: ElisionStore) => string;

// ---------------------------------------------------------------------------
// The store, and the counters that make over-pruning visible
// ---------------------------------------------------------------------------

/**
 * The numbers that keep smelt honest about itself.
 *
 * Law 3 says elisions are reversible. That is cheap to satisfy and easy to abuse: a
 * compressor that cuts everything is "reversible" and useless. The *retrieve rate* is
 * the tell. If the model keeps calling `smelt_retrieve`, smelt cut material the task
 * needed, and the round trip cost more tokens than the elision saved.
 *
 * So: `expansionRate` is not telemetry. It is the metric a caller tunes budgets
 * against, and the only number smelt is willing to have an opinion about — because it
 * measures it locally, per session, on the caller's own traffic.
 */
export interface RetrieveStats {
  /** Distinct blobs put into the store. */
  readonly elisionsStored: number;
  /** Total bytes held by the store. */
  readonly bytesStored: number;
  /** Every `retrieve()` call, including repeats and misses. */
  readonly retrieveCalls: number;
  /** Distinct hashes successfully retrieved at least once. */
  readonly uniqueRetrieved: number;
  /** Calls for a hash the store does not hold. Non-zero means a bug, not over-pruning. */
  readonly misses: number;
  /**
   * `uniqueRetrieved / elisionsStored`, or `0` when nothing has been stored.
   *
   * Read it as: *what fraction of what smelt hid did the model have to ask for back?*
   * There is no universally right value, and smelt does not ship a threshold it has
   * not measured. Rising across a workload is the signal.
   */
  readonly expansionRate: number;
}

/**
 * Local, content-addressed storage for elided bytes. No network, no eviction in v1 —
 * evicting is how "reversible" quietly becomes "reversible for a while".
 */
export interface ElisionStore {
  /** Store content, returning its hash. Idempotent for identical content. */
  put(content: string): string;
  /** The stored content, or `undefined` if this store never held that hash. */
  peek(hash: string): string | undefined;
  /**
   * The stored content, *counted* as a retrieval. This is what the model's tool calls.
   * @throws {UnknownHashError} when the hash is unknown.
   */
  retrieve(hash: string): string;
  has(hash: string): boolean;
  /** A snapshot of the counters. See {@link RetrieveStats}. */
  stats(): RetrieveStats;
}

/**
 * The retrieval tool a consumer exposes to its model. Deliberately not an MCP or
 * provider-specific shape — smelt does not know which SDK you use. The consumer adapts
 * this into its own tool schema; the contract is `hash in, exact bytes out`.
 */
export interface RetrieveTool {
  /** `'smelt_retrieve'`. Stable — consumers hard-code it in prompts. */
  readonly name: string;
  /** Prose the consumer can put straight into a tool description. */
  readonly description: string;
  /** JSON-Schema-shaped parameter description, for consumers that want one. */
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: { readonly hash: { readonly type: 'string' } };
    readonly required: readonly ['hash'];
  };
  /** @throws {UnknownHashError} when the hash is unknown. */
  invoke(input: { readonly hash: string }): string;
}

// ---------------------------------------------------------------------------
// Pluggable stages — interfaces in v1, nothing more
// ---------------------------------------------------------------------------

/** A candidate handed to a {@link RerankStage}: an opaque id plus the text to judge. */
export interface RerankCandidate {
  readonly id: string;
  readonly text: string;
}

/** A reranked candidate, most relevant first. `score` is the stage's own scale. */
export interface RerankedCandidate extends RerankCandidate {
  readonly score: number;
}

/**
 * Relevance reranking — a *seam*, not a feature.
 *
 * Hosted rerankers are good and smelt will never bundle one, because bundling would
 * break Law 1: the moment smelt ships a default reranker, `smelt()` can make a network
 * call that the caller did not ask for and cannot see. A consumer that wants one
 * implements this interface, wires its own key, and owns the fact that its context now
 * leaves the machine. That decision must be legible in the consumer's own source.
 */
export interface RerankStage {
  readonly id: string;
  /** May make network calls — that is the consumer's choice, made in the consumer's code. */
  rerank(
    candidates: readonly RerankCandidate[],
    query: string,
  ): Promise<readonly RerankedCandidate[]>;
}

/**
 * Learned distillation — rewriting content with a model instead of cutting it.
 *
 * Out of v1 for a reason beyond the network: a distilled paragraph cannot satisfy
 * Law 2. "The model summarised this" is not an explanation of what was removed, and
 * the removed material is no longer recoverable from the output. If this ever ships,
 * it ships as a stage that stores the original and explains itself in the same terms
 * every other rule does.
 */
export interface DistillStage {
  readonly id: string;
  distill(text: string, budgetBytes: number): Promise<string>;
}
