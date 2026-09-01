import { describe, expect, it } from 'vitest';

import { HashCollisionError } from '../src/errors.ts';
import { contentHash, HASH_LENGTH } from '../src/hash.ts';
import { createSmelter, defaultMarker } from '../src/index.ts';
import { MemoryElisionStore } from '../src/store.ts';

describe('the store', () => {
  it('hashes deterministically, and to the advertised length', () => {
    expect(contentHash('smelt')).toBe(contentHash('smelt'));
    expect(contentHash('smelt')).toHaveLength(HASH_LENGTH);
    expect(contentHash('smelt')).not.toBe(contentHash('smelt '));
  });

  it('deduplicates identical content instead of storing it twice', () => {
    const store = new MemoryElisionStore();
    const a = store.put('the same bytes');
    const b = store.put('the same bytes');
    expect(a).toBe(b);
    expect(store.stats().elisionsStored).toBe(1);
  });

  it('counts bytes, not characters', () => {
    const store = new MemoryElisionStore();
    store.put('🔥');
    expect(store.stats().bytesStored).toBe(4);
  });

  it('refuses to store a colliding hash rather than serving the wrong bytes later', () => {
    // sha256 will not collide for us, so inject a hash that always does. The branch is
    // real, so it gets a real test.
    const store = new MemoryElisionStore({ hash: () => 'collide0collide0' });
    expect(store.put('original')).toBe('collide0collide0');
    expect(() => store.put('something else entirely')).toThrow(HashCollisionError);
    expect(store.peek('collide0collide0')).toBe('original');
  });

  it('is idempotent for identical content even under a colliding hash', () => {
    const store = new MemoryElisionStore({ hash: () => 'collide0collide0' });
    store.put('same');
    expect(() => store.put('same')).not.toThrow();
    expect(store.stats().elisionsStored).toBe(1);
  });
});

describe('createSmelter', () => {
  const text = Array.from(
    { length: 300 },
    (_, i) => `line ${String(i)}: some tool output, padded to a realistic width`,
  ).join('\n');

  it('shrinks its input and reports both sizes', async () => {
    const smelter = createSmelter();
    const result = await smelter.smelt(text, { budgetBytes: 1_500 });
    expect(result.inputBytes).toBe(Buffer.byteLength(text, 'utf8'));
    expect(result.outputBytes).toBe(Buffer.byteLength(result.text, 'utf8'));
    expect(result.outputBytes).toBeLessThan(result.inputBytes);
  });

  it('never mutates its input', async () => {
    const before = text;
    await createSmelter().smelt(text, { budgetBytes: 500 });
    expect(text).toBe(before);
  });

  it('detects the language from the path, and reports it', async () => {
    const smelter = createSmelter();
    const result = await smelter.smelt(text, { budgetBytes: 500, path: 'src/server.rs' });
    expect(result.language).toBe('rust');
  });

  it('takes a default budget from the smelter when the call omits one', async () => {
    const smelter = createSmelter({ defaultBudgetBytes: 800 });
    const result = await smelter.smelt(text);
    expect(result.outputBytes).toBeLessThan(result.inputBytes);
  });

  it('honours a custom marker builder', async () => {
    const smelter = createSmelter({ marker: ({ hash }) => `[[${hash}]]` });
    const result = await smelter.smelt(text, { budgetBytes: 600 });
    expect(result.elisions[0]!.marker).toBe(`[[${result.elisions[0]!.hash}]]`);
    expect(result.text).toContain(`[[${result.elisions[0]!.hash}]]`);
    expect(smelter.reconstruct(result)).toBe(text);
  });

  it('shares a store when one is passed in, so counters aggregate across calls', async () => {
    const store = new MemoryElisionStore();
    const a = createSmelter({ store });
    const b = createSmelter({ store });
    await a.smelt(text, { budgetBytes: 500 });
    await b.smelt(`${text}\nand a different tail line for a different hash`, {
      budgetBytes: 500,
    });
    expect(store.stats().elisionsStored).toBeGreaterThanOrEqual(2);
    expect(a.stats().elisionsStored).toBe(b.stats().elisionsStored);
  });

  it('leaves text alone when it already fits the budget', async () => {
    const smelter = createSmelter();
    const small = 'a short line\nand another\n';
    const result = await smelter.smelt(small, { budgetBytes: 10_000 });
    expect(result.text).toBe(small);
    expect(result.elisions).toEqual([]);
  });
});

describe('the default marker', () => {
  it('says what went, how much, and how to get it back', () => {
    expect(
      defaultMarker({
        hash: 'abcdef0123456789',
        bytes: 412,
        rule: 'r',
        explanation: 'collapsed 3 sibling functions',
      }),
    ).toBe('<<smelt: collapsed 3 sibling functions (412B) — retrieve("abcdef0123456789")>>');
  });
});
