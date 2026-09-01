/**
 * Every error smelt throws is one of these. Consumers can `instanceof SmeltError`
 * to tell "the library said no" apart from "something else blew up".
 */
export class SmeltError extends Error {
  override readonly name: string = 'SmeltError';
}

/**
 * A scaffold stub. It throws instead of returning a plausible-looking wrong answer,
 * because a context optimizer that quietly returns bad output is indistinguishable
 * from one that works. See CONTRIBUTING.md § "Silence is the enemy".
 */
export class NotImplementedError extends SmeltError {
  override readonly name = 'NotImplementedError';

  constructor(what: string, seeAlso: string) {
    super(
      `smelt: ${what} is not implemented yet. This is a scaffold stub — it throws rather ` +
        `than returning a plausible wrong answer. See ${seeAlso}.`,
    );
  }
}

/**
 * Thrown when something in the elision path tried to reach a non-local resource.
 * v1 has no network. See docs/HANDOFF.md § "Law 1 — zero network".
 */
export class NetworkPolicyError extends SmeltError {
  override readonly name = 'NetworkPolicyError';

  constructor(message: string) {
    super(`smelt: ${message}`);
  }
}

/** A plan asked to elide two overlapping ranges. Applying it would corrupt the output. */
export class OverlappingElisionError extends SmeltError {
  override readonly name = 'OverlappingElisionError';
}

/** A plan referenced a byte range that is not inside the input. */
export class RangeOutOfBoundsError extends SmeltError {
  override readonly name = 'RangeOutOfBoundsError';
}

/** A grammar was requested that is not installed or not registered. */
export class GrammarUnavailableError extends SmeltError {
  override readonly name = 'GrammarUnavailableError';
}

/** `retrieve(hash)` was called with a hash the store does not hold. */
export class UnknownHashError extends SmeltError {
  override readonly name = 'UnknownHashError';

  constructor(hash: string) {
    super(
      `smelt: no stored content for hash "${hash}". It was never elided, or the store was reset.`,
    );
  }
}

/**
 * The CLI was invoked wrongly — a missing `--budget`, an unknown flag, a budget that
 * is not a number. Distinct from every other `SmeltError` so the CLI can exit with a
 * usage code rather than pretending the library refused.
 */
export class CliUsageError extends SmeltError {
  override readonly name = 'CliUsageError';
}

/**
 * Two different blobs hashed to the same key. Astronomically unlikely, and yet: the
 * alternative to throwing is handing the model the wrong bytes and calling it a
 * retrieval, which is precisely the silent failure this library exists to avoid.
 */
export class HashCollisionError extends SmeltError {
  override readonly name = 'HashCollisionError';

  constructor(hash: string) {
    super(
      `smelt: hash collision on "${hash}" — two different blobs share a key. Refusing to ` +
        `store, because retrieving would return the wrong bytes. Please report this.`,
    );
  }
}
