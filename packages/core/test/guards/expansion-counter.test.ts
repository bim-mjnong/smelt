import { describe, expect, it } from 'vitest';

import { createSmelter } from '@guard/index';
import { MemoryElisionStore } from '@guard/store';

/**
 * EXPANSION-COUNTER GUARD — the honest half of Law 3.
 *
 * Reversibility without counting is a trap. A library that hides 90% of a file and
 * hands the model a retrieval tool can report a magnificent "token reduction" while the
 * model quietly asks for all of it back, one round trip at a time — costing *more* than
 * sending the file. The retrieve counter is what makes that visible, so the counter
 * itself has to be guarded: an increment silently lost would leave `expansionRate`
 * pinned at a flattering zero forever, which is exactly the shape of failure this
 * project exists to refuse.
 *
 * Mutation: `pnpm mutate` deletes the increment in `store.ts`, and this must go red.
 */

describe('the expansion rate is actually counted', () => {
  it('starts at zero, and says so honestly for an empty store', () => {
    const stats = new MemoryElisionStore().stats();
    expect(stats).toEqual({
      elisionsStored: 0,
      bytesStored: 0,
      retrieveCalls: 0,
      uniqueRetrieved: 0,
      misses: 0,
      expansionRate: 0,
    });
  });

  it('counts every retrieve call, and distinguishes unique hashes from repeats', () => {
    const store = new MemoryElisionStore();
    const a = store.put('alpha content');
    const b = store.put('beta content');

    expect(store.stats().elisionsStored).toBe(2);
    expect(store.stats().retrieveCalls).toBe(0);
    expect(store.stats().expansionRate).toBe(0);

    store.retrieve(a);
    expect(store.stats()).toMatchObject({
      retrieveCalls: 1,
      uniqueRetrieved: 1,
      expansionRate: 0.5,
    });

    store.retrieve(a);
    expect(store.stats()).toMatchObject({
      retrieveCalls: 2,
      uniqueRetrieved: 1,
      expansionRate: 0.5,
    });

    store.retrieve(b);
    expect(store.stats()).toMatchObject({
      retrieveCalls: 3,
      uniqueRetrieved: 2,
      expansionRate: 1,
    });
  });

  it('does not count a peek as a retrieval — inspection is not the model asking', () => {
    const store = new MemoryElisionStore();
    const hash = store.put('content');
    store.peek(hash);
    store.has(hash);
    expect(store.stats().retrieveCalls).toBe(0);
    expect(store.stats().expansionRate).toBe(0);
  });

  it('counts a miss, and a miss is a bug rather than over-pruning', () => {
    const store = new MemoryElisionStore();
    store.put('content');
    expect(() => store.retrieve('deadbeefdeadbeef')).toThrow(/no stored content/);
    expect(store.stats()).toMatchObject({ retrieveCalls: 1, misses: 1, uniqueRetrieved: 0 });
  });

  it('surfaces the rate through the tool the model actually calls', async () => {
    const smelter = createSmelter();
    const text = Array.from({ length: 300 }, (_, i) => `line ${String(i)} padding padding`).join(
      '\n',
    );
    const result = await smelter.smelt(text, { budgetBytes: 700 });
    expect(result.elisions.length).toBeGreaterThan(0);
    expect(smelter.stats().expansionRate).toBe(0);

    const first = result.elisions[0]!;
    const returned = smelter.tool.invoke({ hash: first.hash });
    expect(returned).toBe(smelter.store.peek(first.hash));
    expect(smelter.stats().retrieveCalls).toBe(1);
    expect(smelter.stats().expansionRate).toBeGreaterThan(0);
    expect(smelter.tool.name).toBe('smelt_retrieve');
  });
});
