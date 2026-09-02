import type { RetrieveStats } from './types.ts';

/**
 * The directly-observed half of {@link RetrieveStats}: the five counts a store reads
 * off its own records — a map size, a directory scan, a journal fold. Nothing in here
 * is derived; every field is a fact the store witnessed. The derived half —
 * `expansionRate` and `allElisionsRetrieved`, the honesty arithmetic of Law 3 — is
 * computed from these by {@link retrieveStats}, in exactly one place.
 */
export type RawRetrieveCounters = Omit<RetrieveStats, 'expansionRate' | 'allElisionsRetrieved'>;

/**
 * The one derivation of the honesty arithmetic, shared by every store.
 *
 * `expansionRate` is the number this project exists to keep honest, and
 * `allElisionsRetrieved` is the one degenerate outcome it names (HANDOFF Decision 4).
 * When each store derived them privately, the two copies could drift — and a store
 * whose arithmetic drifted flattering-ward would be the exact silent failure Law 3's
 * counters exist to refuse. So the seam between a store and its stats is narrowed to
 * raw counters: an {@link ElisionStore} adapter *supplies counts*
 * ({@link RawRetrieveCounters}) and never derives the metric.
 *
 * **Contract for adapter authors.** A custom store implements a
 * `rawCounters(): RawRetrieveCounters` method (or any equivalent that gathers the five
 * counts from its own records) and delegates its public `stats()` to this function:
 *
 * ```ts
 * stats(): RetrieveStats {
 *   return retrieveStats(this.rawCounters());
 * }
 * ```
 *
 * This is a free wrapper function rather than an abstract base class, deliberately —
 * it is the least-breaking shape. The stores share no storage machinery (one is a
 * `Map`, one is a directory), so a base class would couple every adapter's inheritance
 * chain to smelt's for the sake of two lines of arithmetic; an existing `ElisionStore`
 * implementation keeps its own hierarchy and adopts this contract by changing only its
 * `stats()` body. The {@link ElisionStore} interface itself is unchanged: consumers
 * still call `stats()` and never see this seam.
 */
export function retrieveStats(raw: RawRetrieveCounters): RetrieveStats {
  return {
    ...raw,
    expansionRate: raw.elisionsStored === 0 ? 0 : raw.uniqueRetrieved / raw.elisionsStored,
    allElisionsRetrieved: raw.elisionsStored > 0 && raw.uniqueRetrieved === raw.elisionsStored,
  };
}
