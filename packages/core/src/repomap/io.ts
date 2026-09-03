import { RepoMapIoError, SmeltError } from '../errors.ts';

/**
 * The one place the repo map touches a filesystem call that can throw.
 *
 * The consumer contract makes exactly one promise about errors — every error smelt
 * throws is an `instanceof SmeltError` — and the repo map is the module most able to
 * break it, because it walks a whole tree the caller named. `buildRepoMap({ root:
 * '/nonexistent' })` threw the raw Node `ENOENT` from `readdirSync`: not a
 * `SmeltError`, past the documented `catch`, with the path only in a stack trace. The
 * same escape was one `EACCES` away in the tags cache, in `stat`, and in `read`.
 *
 * So every such call is written as `fsCall(operation, path, () => …)`. It adds no
 * behaviour — the call still fails, at the same moment, for the same reason — it only
 * puts the failure inside the contract and names the path in the message.
 *
 * A {@link SmeltError} passes through untouched. A caller's own {@link RepoReader} may
 * refuse in smelt's own currency (a store that will not serve a path, say); that
 * refusal is already inside the contract, and rewrapping it would bury a sentence its
 * author wrote deliberately under a generic one.
 *
 * `operation` is a verb phrase that reads as `could not <operation> "<path>"` —
 * `list the directory`, `read the file`, `write the cache entry`.
 */
export function fsCall<T>(operation: string, path: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof SmeltError) throw error;
    throw new RepoMapIoError(operation, path, error);
  }
}
