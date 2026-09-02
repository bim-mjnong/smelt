import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * Source-walking helpers, shared by every guard in the workspace.
 *
 * These moved here wholesale from `packages/core/test/guards/_source.ts`, which is now
 * the per-package anchor: only `packageRoot()` and `repoRoot()` are genuinely
 * package-local (they are derived from the guard file's own location), so the package
 * passes its root in and everything else lives once.
 *
 * The two environment variables keep exactly the semantics `scripts/mutate.mjs`
 * depends on — the mutation runner sets them, and a guard that stopped honouring them
 * would run against the pristine tree and pass while its mutation went uncaught.
 */

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
