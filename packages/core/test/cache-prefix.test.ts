import { describe, expect, it } from 'vitest';

import {
  ANTHROPIC_PROMPT_CACHE_FACTS,
  CACHE_BREAKER_RULES,
  detectCacheBreakers,
  findPrefixDivergence,
} from '../src/cache/prefix.ts';

describe('findPrefixDivergence', () => {
  it('reports nothing for identical prefixes', () => {
    expect(findPrefixDivergence('tools then system', 'tools then system')).toBeUndefined();
  });

  it('reports nothing for a pure append — the cached prefix is intact', () => {
    expect(findPrefixDivergence('system prompt', 'system prompt plus a new message')).toBe(
      undefined,
    );
  });

  it('reports the first divergent byte, with excerpts of both sides', () => {
    const divergence = findPrefixDivergence('prefix ALPHA suffix', 'prefix OMEGA suffix');
    expect(divergence).toBeDefined();
    expect(divergence!.byteOffset).toBe(7);
    expect(divergence!.invalidatedBytes).toBe('prefix ALPHA suffix'.length - 7);
    expect(divergence!.description).toContain('byte 7');
    expect(divergence!.description).toContain('ALPHA');
    expect(divergence!.description).toContain('OMEGA');
  });

  it('reports a truncation as a divergence at the shorter end', () => {
    const divergence = findPrefixDivergence('shared prefix and then more', 'shared prefix');
    expect(divergence).toBeDefined();
    expect(divergence!.byteOffset).toBe('shared prefix'.length);
    expect(divergence!.invalidatedBytes).toBe(' and then more'.length);
    expect(divergence!.description).toContain('next ends');
  });

  it('counts UTF-8 bytes, not code units', () => {
    // 'héllo w' is 8 bytes ('é' is 2) but 7 code units — the two must not be conflated.
    const divergence = findPrefixDivergence('héllo world', 'héllo würld');
    expect(divergence!.byteOffset).toBe(8);
  });

  it('never splits a multi-byte character in the excerpt', () => {
    // The two emoji differ in their final UTF-8 byte, so the divergence lands
    // mid-character; the excerpt must still carry whole code points.
    const divergence = findPrefixDivergence('a\u{1F642}b', 'a\u{1F643}b');
    expect(divergence!.byteOffset).toBe(4);
    expect(divergence!.description).toContain('\u{1F642}');
    expect(divergence!.description).toContain('\u{1F643}');
    expect(divergence!.description).not.toContain('�');
  });

  it('bounds the excerpt instead of echoing the whole prompt back', () => {
    const previous = `${'a'.repeat(5_000)}X${'b'.repeat(5_000)}`;
    const next = `${'a'.repeat(5_000)}Y${'b'.repeat(5_000)}`;
    const divergence = findPrefixDivergence(previous, next);
    expect(divergence!.byteOffset).toBe(5_000);
    expect(divergence!.description.length).toBeLessThan(300);
  });
});

describe('detectCacheBreakers', () => {
  const cleanTool = {
    description: 'returns elided bytes',
    input_schema: { properties: {}, type: 'object' },
    name: 'smelt_retrieve',
  };

  it('finds nothing to warn about in a stable, sorted, static structure', () => {
    const structure = { system: 'You are a helpful assistant', tools: [cleanTool] };
    expect(detectCacheBreakers(structure, structure)).toEqual([]);
  });

  it('detects a timestamp in the system prompt, with its byte offset', () => {
    const warnings = detectCacheBreakers({
      system: 'Today is 2026-09-01T08:30:00Z. Be concise.',
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.rule).toBe(CACHE_BREAKER_RULES.systemTimestamp);
    expect(warnings[0]!.explanation).toContain('2026-09-01T08:30:00Z');
    expect(warnings[0]!.explanation).toContain('at byte 9');
  });

  it('detects a bare date too — a date alone changes bytes daily', () => {
    const warnings = detectCacheBreakers({ system: 'Knowledge cutoff note: 2026-09-01' });
    expect(warnings.map((w) => w.rule)).toEqual([CACHE_BREAKER_RULES.systemTimestamp]);
  });

  it('detects a UUID in the system prompt, with its byte offset', () => {
    const warnings = detectCacheBreakers({
      system: 'Session 550e8400-e29b-41d4-a716-446655440000 in progress',
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.rule).toBe(CACHE_BREAKER_RULES.systemUuid);
    expect(warnings[0]!.explanation).toContain('550e8400-e29b-41d4-a716-446655440000');
    expect(warnings[0]!.explanation).toContain('at byte 8');
  });

  it('counts repeats instead of emitting one warning per match', () => {
    const warnings = detectCacheBreakers({
      system: 'Started 2026-09-01 10:00, refreshed 2026-09-01 10:05',
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.explanation).toContain('2 timestamp-shaped values');
  });

  it('detects unsorted JSON keys in a tool definition, naming the offending pair', () => {
    const warnings = detectCacheBreakers({
      tools: [{ name: 'search', description: 'finds things' }],
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.rule).toBe(CACHE_BREAKER_RULES.unsortedJsonKeys);
    expect(warnings[0]!.explanation).toContain('"name" before "description"');
    expect(warnings[0]!.explanation).toContain('tool "search"');
  });

  it('detects unsorted keys in nested objects, with the path', () => {
    const warnings = detectCacheBreakers({
      tools: [
        {
          input_schema: { properties: { q: { type: 'string', minLength: 1 } }, type: 'object' },
          name: 'search',
        },
      ],
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.rule).toBe(CACHE_BREAKER_RULES.unsortedJsonKeys);
    expect(warnings[0]!.explanation).toContain('input_schema.properties.q');
    expect(warnings[0]!.explanation).toContain('"type" before "minLength"');
  });

  it('detects a tool added between calls', () => {
    const warnings = detectCacheBreakers(
      { tools: [cleanTool, { ...cleanTool, name: 'extra_tool' }] },
      { tools: [cleanTool] },
    );
    expect(warnings.map((w) => w.rule)).toContain(CACHE_BREAKER_RULES.toolSetVaries);
    const varies = warnings.find((w) => w.rule === CACHE_BREAKER_RULES.toolSetVaries)!;
    expect(varies.explanation).toContain('added "extra_tool"');
  });

  it('detects a tool removed between calls', () => {
    const warnings = detectCacheBreakers({ tools: [] }, { tools: [cleanTool] });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.explanation).toContain('removed "smelt_retrieve"');
  });

  it('detects a reorder between calls — same tools, different bytes', () => {
    const other = { ...cleanTool, name: 'other_tool' };
    const warnings = detectCacheBreakers(
      { tools: [other, cleanTool] },
      { tools: [cleanTool, other] },
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.rule).toBe(CACHE_BREAKER_RULES.toolSetVaries);
    expect(warnings[0]!.explanation).toContain('same tools, different order');
  });

  it('detects a definition change under an unchanged name — content, not names', () => {
    const edited = { ...cleanTool, description: 'returns the exact elided bytes' };
    const warnings = detectCacheBreakers({ tools: [edited] }, { tools: [cleanTool] });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.rule).toBe(CACHE_BREAKER_RULES.toolSetVaries);
    expect(warnings[0]!.explanation).toContain('definition of "smelt_retrieve" changed');
    expect(warnings[0]!.explanation).toContain('name unchanged');
  });

  it('compares content canonically — key enumeration order alone is not a change', () => {
    // Same content, keys written in a different order: the canonical comparison
    // must treat these as equal. Whether either call's own keys are unsorted is
    // unsorted-json-keys' concern, checked per call, not a tool-set change.
    const sortedKeys = { description: 'finds things', name: 'search' };
    const sameContent = { name: 'search', description: 'finds things' };
    const warnings = detectCacheBreakers({ tools: [sameContent] }, { tools: [sortedKeys] });
    expect(warnings.map((w) => w.rule)).not.toContain(CACHE_BREAKER_RULES.toolSetVaries);
  });

  it('describes a removed duplicate truthfully, never as "same tools, different order"', () => {
    const warnings = detectCacheBreakers({ tools: [cleanTool] }, { tools: [cleanTool, cleanTool] });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.rule).toBe(CACHE_BREAKER_RULES.toolSetVaries);
    expect(warnings[0]!.explanation).toContain('removed a duplicate of "smelt_retrieve"');
    expect(warnings[0]!.explanation).not.toContain('different order');
  });

  it('describes an added duplicate truthfully', () => {
    const warnings = detectCacheBreakers({ tools: [cleanTool, cleanTool] }, { tools: [cleanTool] });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.explanation).toContain('added a duplicate of "smelt_retrieve"');
  });

  it('states the serialization order from the cited constant, not a hardcoded string', () => {
    const warnings = detectCacheBreakers({ tools: [] }, { tools: [cleanTool] });
    expect(warnings[0]!.explanation).toContain(
      ANTHROPIC_PROMPT_CACHE_FACTS.prefixOrder.join(' → '),
    );
  });

  it('does not flag integer-like keys, whose order JavaScript fixes numerically', () => {
    // {"2": …, "10": …} enumerates as "2","10" no matter how it is written — no
    // serializer can emit these differently between calls, and "2" > "10"
    // lexicographically, so a naive sorted-order check would flag an order the
    // caller cannot change.
    const warnings = detectCacheBreakers({
      tools: [{ input_schema: { 10: 'ten', 2: 'two' }, name: 'lookup' }],
    });
    expect(warnings).toEqual([]);
  });

  it('still flags unsorted string keys sitting after integer-like keys', () => {
    const warnings = detectCacheBreakers({
      tools: [{ input_schema: { 10: 'ten', 2: 'two', b: 1, a: 2 }, name: 'lookup' }],
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.rule).toBe(CACHE_BREAKER_RULES.unsortedJsonKeys);
    expect(warnings[0]!.explanation).toContain('"b" before "a"');
  });

  it('still recurses into values held under integer-like keys', () => {
    const warnings = detectCacheBreakers({
      tools: [{ input_schema: { 1: { b: 1, a: 2 } }, name: 'lookup' }],
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.rule).toBe(CACHE_BREAKER_RULES.unsortedJsonKeys);
    expect(warnings[0]!.explanation).toContain('input_schema.1');
  });

  it('emits no tool-set warning without a previous call to compare against', () => {
    const warnings = detectCacheBreakers({ tools: [cleanTool] });
    expect(warnings).toEqual([]);
  });

  it('names every rule stably', () => {
    expect(CACHE_BREAKER_RULES).toEqual({
      systemTimestamp: 'system-timestamp',
      systemUuid: 'system-uuid',
      unsortedJsonKeys: 'unsorted-json-keys',
      toolSetVaries: 'tool-set-varies',
    });
  });
});

describe('the cited provider facts', () => {
  it('name their source and the date they were verified', () => {
    expect(ANTHROPIC_PROMPT_CACHE_FACTS.source).toContain('docs.anthropic.com');
    expect(ANTHROPIC_PROMPT_CACHE_FACTS.source).toContain('2026-09-01');
  });

  it('carry the documented cache facts, byte-matched in tools → system → messages order', () => {
    expect(ANTHROPIC_PROMPT_CACHE_FACTS.prefixOrder).toEqual(['tools', 'system', 'messages']);
    expect(ANTHROPIC_PROMPT_CACHE_FACTS.minCacheablePrefixTokensApprox).toBe(1024);
    expect(ANTHROPIC_PROMPT_CACHE_FACTS.maxCacheBreakpoints).toBe(4);
    expect(ANTHROPIC_PROMPT_CACHE_FACTS.defaultTtlMinutes).toBe(5);
    expect(ANTHROPIC_PROMPT_CACHE_FACTS.extendedTtlMinutes).toBe(60);
    expect(ANTHROPIC_PROMPT_CACHE_FACTS.writeCostMultiplier5m).toBe(1.25);
    expect(ANTHROPIC_PROMPT_CACHE_FACTS.writeCostMultiplier1h).toBe(2);
    expect(ANTHROPIC_PROMPT_CACHE_FACTS.readCostMultiplierApprox).toBe(0.1);
  });
});
