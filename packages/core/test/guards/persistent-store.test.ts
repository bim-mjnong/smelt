import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { DirectoryElisionStore } from '@guard/store-dir';
import { contentHash } from '@guard/hash';

/**
 * PERSISTENT-STORE GUARD — Law 3, across a process boundary.
 *
 * A persistent store earns its keep on exactly the promises that are easiest to fake:
 * that a damaged blob is *refused* rather than returned (a torn write handed back as a
 * retrieval is the silent wrong answer this library exists to refuse), that the
 * retrieval counters survive a restart (an expansion rate that resets to a flattering
 * zero every process is no rate at all), and that "we hold damaged bytes" is
 * distinguishable from "never existed".
 *
 * The store keeps no state in memory — every read comes off the disk — so a second
 * instance over the same directory *is* the restart case, byte for byte. The real
 * two-process concurrency test lives in `test/store-dir.test.ts`; this guard stays
 * cheap because `pnpm mutate` runs it repeatedly.
 *
 * Mutations: `pnpm mutate` disables the verify-on-read branch and drops the journal
 * append in `store-dir.ts`; this file must go red both times.
 */

const roots: string[] = [];

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'smelt-persistent-guard-'));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** The name of what a call threw — errors here are distinguished by class, so by name. */
function errorName(fn: () => unknown): string {
  try {
    fn();
    return '(did not throw)';
  } catch (error) {
    return (error as Error).name;
  }
}

/** A deliberately colliding "hash": the collision branch is unreachable with sha256. */
const collide = (): string => 'aaaaaaaaaaaaaaaa';

describe('the persistent store keeps Law 3 across restarts', () => {
  it('retrieval counters survive a restart, so the expansion rate stays meaningful', () => {
    const root = newRoot();
    const before = new DirectoryElisionStore(root);
    const kept = before.put('alpha content that was elided');
    before.put('beta content that was elided');
    before.retrieve(kept);
    expect(() => before.retrieve('deadbeefdeadbeef')).toThrow(/no stored content/);

    // A fresh instance over the same directory reads the same disk state — the store
    // holds nothing in memory, so this is exactly what a process restart sees.
    const after = new DirectoryElisionStore(root);
    expect(after.stats()).toMatchObject({
      elisionsStored: 2,
      retrieveCalls: 2,
      uniqueRetrieved: 1,
      misses: 1,
      expansionRate: 0.5,
      allElisionsRetrieved: false,
    });
    expect(after.retrieve(kept)).toBe('alpha content that was elided');
    expect(after.stats().retrieveCalls).toBe(3);
  });

  it('verifies bytes against the hash on read: a damaged blob is refused, loudly', () => {
    const root = newRoot();
    const store = new DirectoryElisionStore(root);
    const hash = store.put('the original bytes, exactly as elided');

    // Damage the blob behind the store's back — what a torn or tampered write leaves.
    writeFileSync(join(root, 'blobs', hash), 'not the original bytes at all');

    expect(() => store.retrieve(hash)).toThrow(/do not hash to/);
    expect(() => store.peek(hash)).toThrow(/do not hash to/);
  });

  it('distinguishes "we hold damaged bytes" from "never existed"', () => {
    const root = newRoot();
    const store = new DirectoryElisionStore(root);
    const hash = store.put('content that will be damaged');
    writeFileSync(join(root, 'blobs', hash), 'damaged');

    expect(errorName(() => store.retrieve(hash))).toBe('StoreCorruptionError');
    expect(errorName(() => store.retrieve('feedfacefeedface'))).toBe('UnknownHashError');
    // A re-put of the original content sees damaged bytes under its hash: that is
    // corruption, and must never be misreported as a hash collision.
    expect(errorName(() => store.put('content that will be damaged'))).toBe('StoreCorruptionError');
  });

  it('a torn journal tail costs only its own record, never the next one', () => {
    const root = newRoot();
    const store = new DirectoryElisionStore(root);
    const hash = store.put('content whose retrieval must still be counted');
    store.retrieve(hash);
    // What a crash mid-append leaves: a partial record with no trailing newline.
    appendFileSync(join(root, 'retrievals.log'), 'hit "aaaa');

    store.retrieve(hash);
    expect(store.stats()).toMatchObject({ retrieveCalls: 2, uniqueRetrieved: 1, misses: 0 });
  });

  it('refuses a hash collision, including one discovered only after a restart', () => {
    const root = newRoot();
    const first = new DirectoryElisionStore(root, { hash: collide });
    first.put('one blob');
    expect(() => first.put('a different blob')).toThrow(/hash collision/);

    const second = new DirectoryElisionStore(root, { hash: collide });
    expect(() => second.put('yet another different blob')).toThrow(/hash collision/);
    expect(second.put('one blob')).toBe('aaaaaaaaaaaaaaaa'); // identical bytes dedupe
  });

  it('refuses a store directory whose format it does not understand', () => {
    const root = mkdtempSync(join(tmpdir(), 'smelt-persistent-guard-'));
    roots.push(root);
    writeFileSync(
      join(root, 'format.json'),
      JSON.stringify({ format: 'smelt-elision-store', version: 999 }),
    );
    expect(() => new DirectoryElisionStore(root)).toThrow(/version 999/);
    // Refused before mutated: the unrecognized directory gains no blobs/ or tmp/.
    expect(existsSync(join(root, 'blobs'))).toBe(false);
    expect(existsSync(join(root, 'tmp'))).toBe(false);
  });

  it('ignores what is not a blob: staging leftovers and finder droppings', () => {
    const root = newRoot();
    const store = new DirectoryElisionStore(root);
    store.put('the one real blob');
    // A torn write dies in tmp/; a .DS_Store is not content. Neither is an elision.
    writeFileSync(join(root, 'tmp', '12345-deadbeef'), 'torn write remnant');
    writeFileSync(join(root, 'blobs', '.DS_Store'), 'finder dropping');
    expect(store.stats().elisionsStored).toBe(1);
    expect(store.stats().bytesStored).toBe(Buffer.byteLength('the one real blob', 'utf8'));
  });

  it('never treats a hash as a path: traversal-shaped hashes are simply unknown', () => {
    const root = newRoot();
    const store = new DirectoryElisionStore(root);
    mkdirSync(join(root, 'outside'), { recursive: true });
    writeFileSync(join(root, 'outside', 'secret'), 'bytes outside the store');
    expect(store.has('../outside/secret')).toBe(false);
    expect(store.peek('../outside/secret')).toBeUndefined();
    expect(() => store.retrieve('../outside/secret')).toThrow(/no stored content/);
  });

  it('still holds everything ever put — there is no eviction to survive', () => {
    const root = newRoot();
    const store = new DirectoryElisionStore(root);
    const hashes = Array.from({ length: 50 }, (_, i) =>
      store.put(`elided blob number ${String(i)}`),
    );
    const reopened = new DirectoryElisionStore(root);
    for (const [i, hash] of hashes.entries()) {
      expect(reopened.retrieve(hash)).toBe(`elided blob number ${String(i)}`);
      expect(hash).toBe(contentHash(`elided blob number ${String(i)}`));
    }
    expect(reopened.stats().elisionsStored).toBe(50);
  });
});
