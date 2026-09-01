/**
 * Cache-prefix hygiene — Slice 6. **Detect and warn, never rewrite.**
 *
 * Provider prompt caches match the request prefix byte for byte, so a context
 * optimizer that reorders or rewrites a prompt prefix to "help" a cache can cost
 * more than it saves — and worse, a reordering that changes model behaviour is an
 * unexplainable elision wearing a different hat. Headroom's CacheAligner made the
 * same call: it detects prefix volatility and warns; it never edits the prompt.
 * Neither does this module. Every function here is a pure read over its inputs:
 * nothing is mutated, and nothing "fixed" is ever returned. That is not a comment,
 * it is a guarantee — `test/guards/cache-hygiene.test.ts` asserts it on frozen
 * inputs, and `pnpm mutate` proves the guard goes red when a helpful in-place fix
 * appears.
 *
 * Warnings follow the `ElisionReason` two-field discipline from `types.ts`:
 * a stable `rule` id for counters, and an `explanation` a human reads. A warning
 * that cannot be written as a sentence is a rule nobody understands.
 */

/**
 * Facts about Anthropic's prompt cache, as published in Anthropic's prompt-caching
 * documentation (docs.anthropic.com), verified 2026-09-01.
 *
 * These are *cited provider facts*, not smelt measurements — the only numbers Law 4
 * permits are someone else's, with their source and date named. In particular this
 * module claims nothing about how often anyone's cache hits: the price multipliers
 * below are prices, and a price is not a frequency.
 */
export const ANTHROPIC_PROMPT_CACHE_FACTS = {
  /** Where every number in this object comes from, and when it was checked. */
  source: 'Anthropic prompt-caching documentation (docs.anthropic.com), verified 2026-09-01',
  /**
   * The cached prefix is matched byte for byte over the request in this order.
   * A byte change in `tools` therefore invalidates `system` and `messages` too.
   */
  prefixOrder: ['tools', 'system', 'messages'],
  /** Any byte change invalidates the cache from that byte to the end of the prefix. */
  invalidation: 'byte-exact; any change invalidates everything after it',
  /** Minimum cacheable prefix, in tokens — approximately 1024 for most models. */
  minCacheablePrefixTokensApprox: 1024,
  /** Maximum number of cache breakpoints per request. */
  maxCacheBreakpoints: 4,
  /** Default time-to-live of a cache entry, in minutes. */
  defaultTtlMinutes: 5,
  /** Optional extended time-to-live, in minutes (one hour). */
  extendedTtlMinutes: 60,
  /** Writing a 5-minute cache entry costs 1.25x the base input-token price. */
  writeCostMultiplier5m: 1.25,
  /** Writing a 1-hour cache entry costs 2x the base input-token price. */
  writeCostMultiplier1h: 2,
  /** Reading a cached prefix costs approximately 0.1x the base input-token price. */
  readCostMultiplierApprox: 0.1,
} as const;

/**
 * A cache-hygiene warning. Deliberately the same two-field shape as
 * `ElisionReason` in `types.ts`, and for the same reason: a stable id for counters, a
 * sentence for humans, and nothing else — no patch, no replacement text, no
 * "fixed" prompt. Warning is all this module does.
 */
export interface CacheWarning {
  /** Stable machine id, e.g. `'system-timestamp'`. */
  readonly rule: string;
  /** Present tense, no trailing period, names the evidence. */
  readonly explanation: string;
}

/** The stable rule ids this module can emit. Additive over time, never renamed. */
export const CACHE_BREAKER_RULES = {
  /** A timestamp-shaped value in the system prompt. */
  systemTimestamp: 'system-timestamp',
  /** A UUID in the system prompt. */
  systemUuid: 'system-uuid',
  /** An object in a tool definition whose keys are not in sorted order. */
  unsortedJsonKeys: 'unsorted-json-keys',
  /** The tool set changed between two successive calls. */
  toolSetVaries: 'tool-set-varies',
} as const;

/**
 * The first byte where two successive prompt prefixes diverge, with a description
 * of what changed around it. Offsets are UTF-8 **byte** offsets, because that is
 * the unit the provider's cache matches in — a code-unit index would be a lie for
 * any prompt containing a multi-byte character.
 */
export interface PrefixDivergence {
  /** UTF-8 byte offset of the first byte at which the two prefixes differ. */
  readonly byteOffset: number;
  /** Bytes of `previous` from the divergence to its end — the span a cache no longer matches. */
  readonly invalidatedBytes: number;
  /** What changed around the divergence. Excerpts never split a multi-byte character. */
  readonly description: string;
}

/** Code points around the code point containing `byteOffset` — never a split character. */
function excerptAroundByte(text: string, byteOffset: number, radius = 16): string {
  const points = [...text];
  let index = points.length;
  let bytes = 0;
  for (const [i, point] of points.entries()) {
    const width = Buffer.byteLength(point, 'utf8');
    if (byteOffset < bytes + width) {
      index = i;
      break;
    }
    bytes += width;
  }
  const start = Math.max(0, index - radius);
  const end = Math.min(points.length, index + radius);
  const head = start > 0 ? '…' : '';
  const tail = end < points.length ? '…' : '';
  return head + points.slice(start, end).join('') + tail;
}

/**
 * Compare two successive prompt prefixes the way the provider's cache does: byte
 * for byte, in UTF-8.
 *
 * Returns `undefined` when `next` starts with every byte of `previous` — identical
 * prefixes, or a pure append, both of which leave a cached prefix intact. Anything
 * else returns the first divergent byte offset and a description of what changed
 * around it. This function reports; it does not repair.
 */
export function findPrefixDivergence(previous: string, next: string): PrefixDivergence | undefined {
  const previousBytes = Buffer.from(previous, 'utf8');
  const nextBytes = Buffer.from(next, 'utf8');
  const limit = Math.min(previousBytes.length, nextBytes.length);

  let byteOffset = 0;
  while (byteOffset < limit && previousBytes[byteOffset] === nextBytes[byteOffset]) {
    byteOffset += 1;
  }
  if (byteOffset === previousBytes.length) return undefined;

  const invalidatedBytes = previousBytes.length - byteOffset;
  const previousExcerpt = JSON.stringify(excerptAroundByte(previous, byteOffset));
  const description =
    byteOffset === nextBytes.length
      ? `next ends at byte ${String(byteOffset)}, where previous continued with ` +
        `${previousExcerpt}; the ${String(invalidatedBytes)} bytes previous carried from ` +
        `there are gone from the prefix`
      : `first divergence at byte ${String(byteOffset)}: previous has ${previousExcerpt} ` +
        `where next has ${JSON.stringify(excerptAroundByte(next, byteOffset))}; a byte-matched ` +
        `cache stops matching here, so the ${String(invalidatedBytes)} bytes after this ` +
        `point are re-sent cold`;
  return { byteOffset, invalidatedBytes, description };
}

/**
 * One tool definition as the caller sends it. Only `name` is required here —
 * the rest of the definition is scanned structurally, whatever shape it has.
 */
export interface PromptTool {
  readonly name: string;
  readonly [key: string]: unknown;
}

/**
 * The prompt structure smelt is shown for hygiene checks — the two parts that
 * serialize ahead of the messages in the cached prefix. smelt never sees, holds,
 * or edits the real request; the caller hands in a description and gets warnings
 * back.
 */
export interface PromptStructure {
  /** Tool definitions, in the order they are sent. */
  readonly tools?: readonly PromptTool[];
  /** The system prompt text. */
  readonly system?: string;
}

/** ISO-8601-shaped dates and datetimes — the values that move with the clock. */
const TIMESTAMP_PATTERN =
  /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g;

/** RFC 4122 textual UUIDs — the values that are fresh per process or per call. */
const UUID_PATTERN =
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;

function byteOffsetOf(text: string, index: number): number {
  return Buffer.byteLength(text.slice(0, index), 'utf8');
}

function scanSystemPrompt(system: string): readonly CacheWarning[] {
  const warnings: CacheWarning[] = [];

  const timestamps = [...system.matchAll(TIMESTAMP_PATTERN)];
  const firstTimestamp = timestamps[0];
  if (firstTimestamp !== undefined) {
    warnings.push({
      rule: CACHE_BREAKER_RULES.systemTimestamp,
      explanation:
        `system prompt contains ${String(timestamps.length)} timestamp-shaped ` +
        `value${timestamps.length === 1 ? '' : 's'}, first "${firstTimestamp[0]}" at byte ` +
        `${String(byteOffsetOf(system, firstTimestamp.index))}; a value that moves with ` +
        `the clock changes bytes between calls and silently invalidates the cached ` +
        `prefix from that byte`,
    });
  }

  const uuids = [...system.matchAll(UUID_PATTERN)];
  const firstUuid = uuids[0];
  if (firstUuid !== undefined) {
    warnings.push({
      rule: CACHE_BREAKER_RULES.systemUuid,
      explanation:
        `system prompt contains ${String(uuids.length)} UUID${uuids.length === 1 ? '' : 's'}, ` +
        `first "${firstUuid[0]}" at byte ${String(byteOffsetOf(system, firstUuid.index))}; ` +
        `an id minted per session or per call changes bytes between calls and silently ` +
        `invalidates the cached prefix from that byte`,
    });
  }

  return warnings;
}

interface UnsortedKeys {
  readonly path: string;
  readonly before: string;
  readonly after: string;
}

/** The first object (depth-first) whose own keys are not in sorted order. Read-only walk. */
function findUnsortedKeys(value: unknown, path: string): UnsortedKeys | undefined {
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) {
      const found = findUnsortedKeys(item, `${path}[${String(i)}]`);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  for (let i = 1; i < keys.length; i += 1) {
    if (keys[i - 1]! > keys[i]!) return { path, before: keys[i - 1]!, after: keys[i]! };
  }
  for (const key of keys) {
    const found = findUnsortedKeys(record[key], `${path}.${key}`);
    if (found !== undefined) return found;
  }
  return undefined;
}

function scanToolKeyOrder(tools: readonly PromptTool[]): readonly CacheWarning[] {
  const warnings: CacheWarning[] = [];
  for (const tool of tools) {
    const found = findUnsortedKeys(tool, `tool "${tool.name}"`);
    if (found !== undefined) {
      warnings.push({
        rule: CACHE_BREAKER_RULES.unsortedJsonKeys,
        explanation:
          `${found.path} has JSON keys out of sorted order ("${found.before}" before ` +
          `"${found.after}"); a serializer with no canonical key order can emit them ` +
          `differently between calls, changing bytes in the cached prefix with the ` +
          `content unchanged`,
      });
    }
  }
  return warnings;
}

const quoteNames = (names: readonly string[]): string =>
  names.map((name) => `"${name}"`).join(', ');

function compareToolSets(
  previous: readonly PromptTool[],
  current: readonly PromptTool[],
): CacheWarning | undefined {
  const previousNames = previous.map((tool) => tool.name);
  const currentNames = current.map((tool) => tool.name);
  const sameOrder =
    previousNames.length === currentNames.length &&
    previousNames.every((name, i) => name === currentNames[i]);
  if (sameOrder) return undefined;

  const added = currentNames.filter((name) => !previousNames.includes(name));
  const removed = previousNames.filter((name) => !currentNames.includes(name));
  const changes: string[] = [];
  if (added.length > 0) changes.push(`added ${quoteNames(added)}`);
  if (removed.length > 0) changes.push(`removed ${quoteNames(removed)}`);
  if (changes.length === 0) changes.push('same tools, different order');

  return {
    rule: CACHE_BREAKER_RULES.toolSetVaries,
    explanation:
      `tool set changed between calls (${changes.join('; ')}); tools serialize first in ` +
      `the cached prefix (tools → system → messages), so this invalidates the entire ` +
      `cache including the system prompt and every message`,
  };
}

/**
 * Detect the named silent cache-breakers in a prompt structure.
 *
 * Three rules over `current` and, when `previous` is supplied, one across the pair:
 *
 * - `system-timestamp` — a timestamp-shaped value in the system prompt
 * - `system-uuid` — a UUID in the system prompt
 * - `unsorted-json-keys` — a tool-definition object whose keys are not sorted
 * - `tool-set-varies` — the tool set differs from the previous call's
 *
 * Pure and read-only: inputs are never mutated, and the return value is warnings
 * only — never a corrected prompt. Deciding what to do about a warning is the
 * caller's call, in the caller's code.
 */
export function detectCacheBreakers(
  current: PromptStructure,
  previous?: PromptStructure,
): readonly CacheWarning[] {
  const warnings: CacheWarning[] = [];
  if (current.system !== undefined) warnings.push(...scanSystemPrompt(current.system));
  if (current.tools !== undefined) warnings.push(...scanToolKeyOrder(current.tools));
  if (previous !== undefined) {
    const varies = compareToolSets(previous.tools ?? [], current.tools ?? []);
    if (varies !== undefined) warnings.push(varies);
  }
  return warnings;
}
