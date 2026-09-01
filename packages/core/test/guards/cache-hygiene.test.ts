import { describe, expect, it } from 'vitest';

import * as cachePrefix from '@guard/cache/prefix';

import { allSourceFiles, guardSrcRoot, readSource } from './_source.ts';

const { detectCacheBreakers, findPrefixDivergence } = cachePrefix;

/**
 * CACHE-HYGIENE GUARD — Slice 6's promise: detect and warn, NEVER rewrite.
 *
 * Provider prompt caches match the prefix byte for byte, so the tempting "fix" is
 * to reorder or rewrite the caller's prompt into a cache-friendlier shape. That fix
 * is exactly the class of magic this library refuses: a reordering that changes
 * model behaviour is an unexplainable elision wearing a different hat, and it fails
 * as worse output with no error anywhere. Headroom's CacheAligner made the same
 * call — warn, never rewrite — and this guard pins smelt to it.
 *
 * Three guarantees are enforced, each with a mutation in `pnpm mutate`:
 *
 *  1. Inputs are never mutated and no function returns a "fixed" prompt. Checked
 *     on deep-frozen inputs, so an in-place edit throws instead of passing quietly.
 *  2. No cache-hit-rate claim exists anywhere in the source. Law 4's specific
 *     target: the original pitch's unsupported figure conflated a cached read's
 *     price with a frequency, and neither this module nor any other gets to
 *     reintroduce it.
 *  3. Every warning carries the two-field discipline — a stable rule id and a
 *     human explanation — like every ElisionReason in the library.
 */

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

const makeStructure = () => ({
  system: 'Session 550e8400-e29b-41d4-a716-446655440000 started 2026-09-01T08:00:00Z',
  tools: [{ name: 'smelt_retrieve', input_schema: { type: 'object', properties: {} } }],
});

describe('cache-prefix hygiene: detect and warn, never rewrite', () => {
  it('never mutates its inputs — asserted on frozen structures', () => {
    const current = deepFreeze(makeStructure());
    const previous = deepFreeze({ tools: [{ name: 'an_earlier_tool' }] });

    // Both breaker detection and divergence run on inputs that would throw on any
    // in-place "fix". If either function tried to sort, splice or rewrite, this
    // call would blow up — and the deep equality below catches a clever copy-back.
    const warnings = detectCacheBreakers(current, previous);
    findPrefixDivergence('prefix one', 'prefix two');

    expect(warnings.length).toBeGreaterThan(0);
    expect(current).toEqual(makeStructure());
    expect(previous).toEqual({ tools: [{ name: 'an_earlier_tool' }] });
  });

  it('returns warnings only — never a corrected prompt, from any export', () => {
    const warnings = detectCacheBreakers(deepFreeze(makeStructure()));
    for (const warning of warnings) {
      expect(Object.keys(warning).toSorted()).toEqual(['explanation', 'rule']);
    }

    const divergence = findPrefixDivergence('shared then OLD', 'shared then NEW');
    expect(divergence).toBeDefined();
    expect(Object.keys(divergence!).toSorted()).toEqual([
      'byteOffset',
      'description',
      'invalidatedBytes',
    ]);

    // No export is shaped like a repair. A `rewritePrefix` or `alignPrompt`
    // appearing here is the decision being reversed, and it should fail loudly.
    for (const name of Object.keys(cachePrefix)) {
      expect(name).not.toMatch(/rewrite|repair|align|correct|fixed/i);
    }
  });

  it('claims no cache-hit-rate figure anywhere in the source (Law 4)', () => {
    const files = allSourceFiles(guardSrcRoot());
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(
        readSource(file),
        `${file} mentions a cache hit rate. No such figure has been measured, and a ` +
          `cached read's price is not a frequency — see docs/HANDOFF.md § Law 4.`,
      ).not.toMatch(/hit[\s-]*rate/i);
    }
  });

  it('reports divergence as a UTF-8 byte offset, never a code-unit index', () => {
    // 'héllo w' is 8 bytes but 7 code units; a code-unit index here would be a lie
    // about where the provider's byte-matched cache stops matching.
    expect(findPrefixDivergence('héllo world', 'héllo würld')!.byteOffset).toBe(8);
  });

  it('carries the two-field discipline on every warning, for every rule', () => {
    const warnings = detectCacheBreakers(deepFreeze(makeStructure()), deepFreeze({ tools: [] }));
    const rules = warnings.map((warning) => warning.rule);
    expect(rules).toContain('system-timestamp');
    expect(rules).toContain('system-uuid');
    expect(rules).toContain('unsorted-json-keys');
    expect(rules).toContain('tool-set-varies');

    for (const warning of warnings) {
      expect(warning.rule).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(warning.explanation.length).toBeGreaterThan(20);
      expect(warning.explanation.endsWith('.')).toBe(false);
    }
  });
});
