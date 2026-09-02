import {
  CONFIG_FILE_NAME,
  DirectoryElisionStore,
  loadNearestConfig,
  MemoryElisionStore,
  resolveStorePath,
} from '@smeltjs/core';
import type { ElisionStore, Strategy } from '@smeltjs/core';

/**
 * The store this server serves its four tools from, decided once at startup.
 *
 * The decision is the CLI's decision, made by the CLI's own exported machinery —
 * `loadNearestConfig` walks up from `cwd` exactly as `smelt` does, `resolveStorePath`
 * resolves `store.path` against the config file exactly as `smelt` does — so a
 * `smelt.config.json` with a directory store gives the CLI and this server **one**
 * persistent store: a marker minted by either can be retrieved by the other, and both
 * move the same counters. Nothing here is a fork of that logic; a malformed config
 * throws the CLI's own `CliUsageError` and the server refuses to start, because a
 * config silently skipped would be a setting the user believed was in force.
 */
export interface ResolvedMcpStore {
  readonly store: ElisionStore;
  readonly kind: 'memory' | 'directory';
  /** One sentence naming the store, for the startup line on stderr. */
  readonly description: string;
  /** The config's default planner strategy, when it names one. */
  readonly defaultStrategy?: Strategy;
  /**
   * Present only on a memory store: how to get persistence, phrased the way the CLI's
   * `smelt retrieve` refusal phrases it. Appended to an unknown-hash tool error,
   * because that is the moment the missing directory store actually bites — a hash
   * from an earlier session names bytes this process never held.
   */
  readonly persistenceHint?: string;
}

/**
 * Decide the store from the nearest `smelt.config.json`, or fall back to memory.
 *
 * The fallback is deliberate and bounded: with no config (or a memory-store config),
 * `smelt_file` → `smelt_retrieve` works within this server's lifetime — the SDK server
 * is a resident process, so in-session retrieval is real — but nothing survives a
 * restart. The {@link ResolvedMcpStore.persistenceHint} says so at the moment it
 * matters instead of failing startup: a memory store is a fine state, not an error,
 * exactly as it is for the `smelt` command itself.
 *
 * @throws {CliUsageError} when a `smelt.config.json` exists and is malformed.
 */
export function resolveMcpStore(cwd: string): ResolvedMcpStore {
  const loaded = loadNearestConfig(cwd);
  const strategy = loaded?.config.strategy;
  const withStrategy = strategy === undefined ? {} : { defaultStrategy: strategy };

  if (loaded !== undefined && loaded.config.store?.kind === 'directory') {
    const path = resolveStorePath(loaded, loaded.config.store.path);
    return {
      store: new DirectoryElisionStore(path),
      kind: 'directory',
      description: `directory store at ${path} (from ${loaded.path}) — shared with the smelt CLI`,
      ...withStrategy,
    };
  }

  const state =
    loaded === undefined
      ? `there is no ${CONFIG_FILE_NAME} at or above ${cwd}`
      : `the ${CONFIG_FILE_NAME} at ${loaded.path} uses a memory store`;
  return {
    store: new MemoryElisionStore(),
    kind: 'memory',
    description: `in-memory store (${state}) — retrieval works within this session only`,
    persistenceHint:
      `This server is running on a memory store, and ${state}. Cross-session ` +
      `retrieval needs a persistent store: a memory store dies with the process that ` +
      `made it, so a marker's hash from an earlier session names bytes this process ` +
      `never held. Configure {"store": {"kind": "directory", "path": …}} in ` +
      `${CONFIG_FILE_NAME} — \`smelt init\` writes one — and the smelt CLI and this ` +
      `server will share one store.`,
    ...withStrategy,
  };
}
