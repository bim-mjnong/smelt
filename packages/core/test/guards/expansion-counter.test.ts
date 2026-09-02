import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createSmelter } from '@guard/index';
import { MemoryElisionStore } from '@guard/store';
import { DirectoryElisionStore } from '@guard/store-dir';
import type { ElisionStore } from '@guard/types';

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
 * Every case runs against both stores, because the counter contract is the *store*
 * contract: a persistent store whose counters drifted from the in-memory one would make
 * `expansionRate` mean different things depending on where the bytes happen to live.
 *
 * Mutation: `pnpm mutate` deletes the increment in `store.ts`, and this must go red.
 * A second mutation nails the degenerate-outcome flag flat to `false`, because a flag
 * that can never fire is the same silence in a different shape.
 */

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const STORES: readonly (readonly [string, () => ElisionStore])[] = [
  ['MemoryElisionStore', () => new MemoryElisionStore()],
  [
    'DirectoryElisionStore',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'smelt-expansion-guard-'));
      roots.push(root);
      return new DirectoryElisionStore(root);
    },
  ],
];

describe.each(STORES)('the expansion rate is actually counted — %s', (_name, makeStore) => {
  it('starts at zero, and says so honestly for an empty store', () => {
    const stats = makeStore().stats();
    expect(stats).toEqual({
      elisionsStored: 0,
      bytesStored: 0,
      retrieveCalls: 0,
      uniqueRetrieved: 0,
      misses: 0,
      expansionRate: 0,
      allElisionsRetrieved: false,
    });
  });

  it('counts every retrieve call, and distinguishes unique hashes from repeats', () => {
    const store = makeStore();
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
    const store = makeStore();
    const hash = store.put('content');
    store.peek(hash);
    store.has(hash);
    expect(store.stats().retrieveCalls).toBe(0);
    expect(store.stats().expansionRate).toBe(0);
  });

  it('counts a miss, and a miss is a bug rather than over-pruning', () => {
    const store = makeStore();
    store.put('content');
    expect(() => store.retrieve('deadbeefdeadbeef')).toThrow(/no stored content/);
    expect(store.stats()).toMatchObject({ retrieveCalls: 1, misses: 1, uniqueRetrieved: 0 });
  });

  it('surfaces the rate through the tool the model actually calls', async () => {
    const smelter = createSmelter({ store: makeStore() });
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

  /**
   * The one degenerate outcome smelt names, and the reason it is a *fact* and not a
   * threshold: at `uniqueRetrieved === elisionsStored` every distinct blob smelt hid was
   * asked for again, so the elision saved nothing and cost a round trip. smelt still
   * ships no warning and no default rate to warn at — that would be a policy claim it
   * has not measured — but a flag that can never fire is exactly as useless as a
   * counter that never increments.
   */
  it('names the degenerate outcome: everything hidden was pulled back', () => {
    const store = makeStore();
    const a = store.put('alpha content');
    const b = store.put('beta content');

    expect(store.stats().allElisionsRetrieved).toBe(false);

    store.retrieve(a);
    expect(store.stats()).toMatchObject({ expansionRate: 0.5, allElisionsRetrieved: false });

    store.retrieve(b);
    expect(store.stats()).toMatchObject({ expansionRate: 1, allElisionsRetrieved: true });

    // A repeat cannot un-set it, and a new elision nobody asked for does.
    store.retrieve(a);
    expect(store.stats().allElisionsRetrieved).toBe(true);
    store.put('gamma content');
    expect(store.stats().allElisionsRetrieved).toBe(false);
  });

  it('is false for an empty store — nothing was hidden, so nothing was defeated', () => {
    expect(makeStore().stats().allElisionsRetrieved).toBe(false);
  });

  /**
   * The other direction of honesty: the counters must not *inflate* either.
   * `reconstruct()` reassembles the original for the caller — a diff, a round-trip
   * check, a write to disk — which is not the model asking for hidden material back.
   * If reconstruction were counted, one verification pass would push the expansion
   * rate to 1.0 and the honest signal this project sells would read as its own worst
   * case. Mutation: `pnpm mutate` reverts reconstruct() to the counted retrieve()
   * path, and this must go red.
   */
  it('does not count reconstruction as retrieval — reassembly is not the model asking', async () => {
    const smelter = createSmelter({ store: makeStore() });
    const text = Array.from({ length: 300 }, (_, i) => `line ${String(i)} padding padding`).join(
      '\n',
    );
    const result = await smelter.smelt(text, { budgetBytes: 700 });
    expect(result.elisions.length).toBeGreaterThan(0);

    const before = smelter.stats();
    expect(smelter.reconstruct(result)).toBe(text);
    const after = smelter.stats();

    expect(after.retrieveCalls, 'reconstruct() inflated retrieveCalls').toBe(before.retrieveCalls);
    expect(after.uniqueRetrieved).toBe(before.uniqueRetrieved);
    expect(after.expansionRate, 'reconstruct() inflated the expansion rate').toBe(
      before.expansionRate,
    );
    expect(after.allElisionsRetrieved).toBe(false);
  });
});
