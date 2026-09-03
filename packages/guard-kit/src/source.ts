import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Source-walking helpers, shared by every guard in the workspace.
 *
 * These moved here wholesale from `packages/core/test/guards/_source.ts`. Each package
 * keeps that file as its anchor, but the anchor is now one call: `guardAnchor(
 * import.meta.url)` derives the package's root from the anchor's own location and
 * returns the helpers bound to it. Nothing in the anchor is package-local except the
 * `import.meta.url` it passes in — the two anchors used to carry a byte-identical
 * `packageRoot()` each, which is how "only the roots are package-local" stayed true
 * in prose after it had stopped being true in the files.
 *
 * The two environment variables keep exactly the semantics `scripts/mutate.mjs`
 * depends on — the mutation runner sets them, and a guard that stopped honouring them
 * would run against the pristine tree and pass while its mutation went uncaught.
 */

/** The helpers a package's guards read, bound to that package's root. */
export interface GuardAnchor {
  /** This package's real root, regardless of where the guard source is pointed. */
  readonly packageRoot: () => string;
  /** The repository root. */
  readonly repoRoot: () => string;
  /**
   * The tree the guards are pointed at — this package's `src`, or the broken copy the
   * mutation runner names in `SMELT_GUARD_SRC`.
   */
  readonly guardSrcRoot: () => string;
  /**
   * The tree a *file-level* guard reads its committed artefacts from — this package's
   * root, or the scratch root the mutation runner names in `SMELT_GUARD_ROOT`.
   */
  readonly guardRoot: () => string;
  /** Every `.ts` file under the guard source root, as paths relative to that root. */
  readonly allSourceFiles: (root?: string) => readonly string[];
  readonly readSource: (relativePath: string, root?: string) => string;
}

/**
 * Bind the helpers to the package whose `test/guards/_source.ts` calls this — the
 * anchor passes its own `import.meta.url`, and the package root is two directories
 * above it, the repo root two above that (`packages/<name>/test/guards`). The bound
 * spellings keep every call site (`guardSrcRoot()`, `readSource(file)`) reading
 * exactly as it did when each anchor wrote them out by hand.
 */
export function guardAnchor(anchorUrl: string): GuardAnchor {
  const packageRoot = (): string => resolve(dirname(fileURLToPath(anchorUrl)), '../..');
  const repoRoot = (): string => resolve(packageRoot(), '../..');
  const boundSrcRoot = (): string => guardSrcRoot(packageRoot());
  return {
    packageRoot,
    repoRoot,
    guardSrcRoot: boundSrcRoot,
    guardRoot: () => guardRoot(packageRoot()),
    allSourceFiles: (root = boundSrcRoot()) => allSourceFiles(root),
    readSource: (relativePath, root = boundSrcRoot()) => readSource(relativePath, root),
  };
}

/**
 * The tree the guards are pointed at. Defaults to the package's own `src`; the
 * mutation runner overrides it with a broken copy to prove the guards can go red.
 */
export function guardSrcRoot(packageRoot: string): string {
  const override = process.env['SMELT_GUARD_SRC'];
  if (override !== undefined && override !== '') return resolve(override);
  return resolve(packageRoot, 'src');
}

/**
 * The tree a *file-level* guard reads its committed artefacts from — `THIRD-PARTY.md`,
 * for instance. Defaults to the package's real root; the mutation runner overrides it
 * with a directory holding a deliberately stale copy, so a freshness guard can be
 * watched going red without anything touching the working tree.
 */
export function guardRoot(packageRoot: string): string {
  const override = process.env['SMELT_GUARD_ROOT'];
  if (override !== undefined && override !== '') return resolve(override);
  return packageRoot;
}

/** Every `.ts` file under the given root, as paths relative to that root. */
export function allSourceFiles(root: string): readonly string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).toSorted()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts')) found.push(relative(root, full));
    }
  };
  walk(root);
  return found;
}

export function readSource(relativePath: string, root: string): string {
  return readFileSync(join(root, relativePath), 'utf8');
}

/** Every module specifier a file imports, however it spells the import. */
export function importSpecifiers(source: string): readonly string[] {
  const patterns = [
    /\bimport\s+(?:type\s+)?[^'"()]*?from\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bexport\s+(?:type\s+)?[^'"()]*?from\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  const found = new Set<string>();
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.add(match[1]!);
  }
  return [...found];
}

/**
 * Blank out string literals, template literals and comments, keeping the file's length
 * and line structure. The forbidden-global scan runs on this, so that
 * `FORBIDDEN_GLOBALS = ['fetch', …]` in `net/policy.ts` — a list of the very words
 * being looked for — does not report itself.
 */
const blank = (character: string): string => (character === '\n' ? '\n' : ' ');

export function stripStringsAndComments(source: string): string {
  const out: string[] = [];
  let i = 0;

  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      while (i < source.length && source[i] !== '\n') {
        out.push(' ');
        i += 1;
      }
      continue;
    }
    if (two === '/*') {
      while (i < source.length && source.slice(i, i + 2) !== '*/') {
        out.push(blank(source[i]!));
        i += 1;
      }
      for (let k = 0; k < 2 && i < source.length; k += 1) {
        out.push(' ');
        i += 1;
      }
      continue;
    }
    const quote = source[i]!;
    if (quote === "'" || quote === '"' || quote === '`') {
      out.push(' ');
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') {
          out.push(' ', ' ');
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          out.push(' ');
          i += 1;
          break;
        }
        out.push(blank(source[i]!));
        i += 1;
      }
      continue;
    }
    out.push(quote);
    i += 1;
  }
  return out.join('');
}
