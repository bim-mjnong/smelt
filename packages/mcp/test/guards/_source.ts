import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Source-walking helpers for this package's guard — the same seam the core's guards
 * use (`packages/core/test/guards/_source.ts`): the guard reads whatever tree
 * `SMELT_GUARD_SRC` points at, so the mutation runner can point it at a deliberately
 * broken copy and watch it go red without touching the working tree.
 */
export function guardSrcRoot(): string {
  const override = process.env['SMELT_GUARD_SRC'];
  if (override !== undefined && override !== '') return resolve(override);
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../src');
}

/** This package's real root, regardless of where the guard source is pointed. */
export function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../..');
}

/** The repository root. */
export function repoRoot(): string {
  return resolve(packageRoot(), '../..');
}

/** Every `.ts` file under the guard source root, as paths relative to that root. */
export function allSourceFiles(root = guardSrcRoot()): readonly string[] {
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

export function readSource(relativePath: string, root = guardSrcRoot()): string {
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
 * Blank out string literals, template literals and comments, keeping the file's
 * length and line structure — so the forbidden-global scan never reports a word that
 * only appears inside a doc comment or an error message.
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
