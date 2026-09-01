import { HashCollisionError, UnknownHashError } from './errors.ts';
import { contentHash } from './hash.ts';
import type { ElisionStore, RetrieveStats } from './types.ts';

/**
 * The default store: in-process, content-addressed, no eviction.
 *
 * In-process is the right default because it is the only one with no failure modes to
 * explain. A consumer that needs elisions to survive a process restart (a long-lived
 * agent session, say) implements {@link ElisionStore} over SQLite or a directory of
 * files — the interface is four methods wide for exactly that reason.
 *
 * There is no `clear()` and no LRU. A store that can forget turns Law 3 into
 * "reversible, usually", and a `retrieve()` that fails after an eviction is
 * indistinguishable to the model from a hallucinated hash.
 */
export interface MemoryElisionStoreOptions {
  /**
   * Override the hash function. The only reason this exists: the collision branch in
   * {@link MemoryElisionStore.put} is unreachable with sha256, and an untestable branch
   * is a branch nobody knows works. A test injects a colliding hash and watches it
   * throw. Production has no reason to pass this.
   */
  readonly hash?: (content: string) => string;
}

export class MemoryElisionStore implements ElisionStore {
  readonly #blobs = new Map<string, string>();
  readonly #hash: (content: string) => string;
  #bytesStored = 0;
  #retrieveCalls = 0;
  #misses = 0;
  readonly #retrievedHashes = new Set<string>();

  constructor(options: MemoryElisionStoreOptions = {}) {
    this.#hash = options.hash ?? contentHash;
  }

  put(content: string): string {
    const hash = this.#hash(content);
    const existing = this.#blobs.get(hash);
    if (existing !== undefined) {
      if (existing !== content) throw new HashCollisionError(hash);
      return hash;
    }
    this.#blobs.set(hash, content);
    this.#bytesStored += Buffer.byteLength(content, 'utf8');
    return hash;
  }

  peek(hash: string): string | undefined {
    return this.#blobs.get(hash);
  }

  retrieve(hash: string): string {
    this.#retrieveCalls += 1;
    const content = this.#blobs.get(hash);
    if (content === undefined) {
      this.#misses += 1;
      throw new UnknownHashError(hash);
    }
    this.#retrievedHashes.add(hash);
    return content;
  }

  has(hash: string): boolean {
    return this.#blobs.has(hash);
  }

  stats(): RetrieveStats {
    const elisionsStored = this.#blobs.size;
    const uniqueRetrieved = this.#retrievedHashes.size;
    return {
      elisionsStored,
      bytesStored: this.#bytesStored,
      retrieveCalls: this.#retrieveCalls,
      uniqueRetrieved,
      misses: this.#misses,
      expansionRate: elisionsStored === 0 ? 0 : uniqueRetrieved / elisionsStored,
      allElisionsRetrieved: elisionsStored > 0 && uniqueRetrieved === elisionsStored,
    };
  }
}
