import { lstatSync, readdirSync, readFileSync } from 'node:fs';

/**
 * The repo map's view of the filesystem — the seam `buildRepoMap` reads a tree
 * through.
 *
 * The map used to call `node:fs` in-line, so every claim about the *walk* — symlinks
 * refused, binary files skipped, nothing read that the ignore list excluded — could
 * only be checked by materialising a real tree on disk and inspecting the map that
 * came back. That makes the cheap cases expensive to write and the awkward ones
 * (an unreadable file, a symlink whose stat resolves its target) impossible to
 * express portably. `decide(request, settings, cwd, statFile?)` in
 * `src/hooks/guard-core.ts` is the counter-example this interface copies: one
 * injectable stat turned seven shims into table-driven tests over a four-line stub.
 *
 * Three methods, all read-only, and that is the point: this is smelt's whole door to
 * the tree it maps, and **there is no writer on it**. The only bytes `buildRepoMap`
 * ever writes are the tags cache, which exists only when the caller hands in a
 * `cacheDir` (Law 1's sibling ruling: smelt never writes outside a store or cache it
 * was explicitly given).
 *
 * The interface is deliberately small and deliberately optional —
 * {@link RepoMapOptions.reader} defaults to {@link nodeFsReader}, so the map's
 * interface is unchanged for every caller that does not care.
 */
export interface RepoReader {
  /** One directory's entries, in whatever order the backing store returns them. */
  list(dir: string): readonly DirEntry[];
  /**
   * One file's bytes. Throws what the backing store throws; nothing is swallowed.
   *
   * `Uint8Array`, not `Buffer`, and for the same reason `AnswerStream` is not
   * `NodeJS.ReadableStream`: `Buffer` is a global only a compilation that included
   * `@types/node` has, so naming it here put an error into the shipped `.d.ts` for
   * every consumer who builds with `skipLibCheck: false` and no node types of their
   * own. A `Buffer` *is* a `Uint8Array`, so `nodeFsReader` and every reader that
   * returns `readFileSync(path)` satisfies this unchanged.
   */
  read(path: string): Uint8Array;
  /**
   * What `path` is, **without following it**: a symlink reports `isSymlink`, and a
   * reader whose backing store has nothing at `path` reports `undefined`.
   */
  stat(path: string): FileStat | undefined;
}

/** One entry of a directory listing. Only the name — {@link RepoReader.stat} says what it is. */
export interface DirEntry {
  readonly name: string;
}

/**
 * What the reader knows about one path.
 *
 * `isDirectory` sits beside `isFile` rather than being inferred from it, because the
 * walk must tell a directory from a fifo, a socket or a device node: "not a file"
 * would send the walk into one, where the map has always simply skipped it.
 */
export interface FileStat {
  /** The file's size in bytes, as the reader sees it. */
  readonly size: number;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  /** True for the link itself. A reader must never resolve a link to answer this. */
  readonly isSymlink: boolean;
}

/**
 * The default reader: `node:fs`, exactly the calls `buildRepoMap` used to make
 * in-line — `readdirSync`, `lstatSync` (never `statSync`: the link, never its
 * target), `readFileSync`.
 *
 * It never returns `undefined` from `stat`: an entry that vanished between the
 * listing and the stat throws, as `lstatSync` has always done here. `undefined` is
 * for readers whose backing store can honestly say "nothing there".
 */
export function nodeFsReader(): RepoReader {
  return {
    list(dir) {
      return readdirSync(dir).map((name) => ({ name }));
    },
    read(path) {
      return readFileSync(path);
    },
    stat(path) {
      const stat = lstatSync(path);
      return {
        size: stat.size,
        isFile: stat.isFile(),
        isDirectory: stat.isDirectory(),
        isSymlink: stat.isSymbolicLink(),
      };
    },
  };
}
