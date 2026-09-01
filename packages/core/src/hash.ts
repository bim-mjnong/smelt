import { createHash } from 'node:crypto';

/**
 * Length of the hex digest smelt uses as a retrieval key.
 *
 * The hash goes into every marker, so the model pays for it in tokens on every
 * elision. 16 hex characters is 64 bits — plenty for the number of elisions one
 * session produces, and cheap enough to inline. The store still verifies content on
 * collision rather than trusting the digest, so shortening it is a token decision,
 * not a correctness one.
 */
export const HASH_LENGTH = 16;

/** Content hash of a string, over its UTF-8 bytes. Stable across runs and platforms. */
export function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, HASH_LENGTH);
}
