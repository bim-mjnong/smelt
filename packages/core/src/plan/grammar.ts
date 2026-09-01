import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { Language, Parser } from 'web-tree-sitter';

import { GrammarUnavailableError } from '../errors.ts';
import { assertLocalResource } from '../net/policy.ts';
import type { LanguageId } from '../types.ts';

/**
 * Grammar file for each language smelt claims to parse. This map is
 * `Record<LanguageId, string>` on purpose: adding a `LanguageId` without adding its
 * grammar is a type error, so the two cannot drift. It is exported because
 * `scripts/bundle-grammars.mjs` and the attribution generator both read it — a
 * hand-written second list of grammar filenames would be exactly the drift this map
 * exists to prevent.
 */
export const WASM_BY_LANGUAGE: Readonly<Record<LanguageId, string>> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  rust: 'tree-sitter-rust.wasm',
  python: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
};

/**
 * Where the bundled grammars live, relative to this module.
 *
 * From `dist/plan/grammar.js` and from `src/plan/grammar.ts` alike, `../../grammars/`
 * is this package's own `grammars/` directory — filled by `pnpm build` and shipped
 * inside the npm tarball. That is what makes "zero native compilation, works offline"
 * true rather than aspirational: whoever installs the package has the parsers, with no
 * post-install download and no optional peer dependency to remember. It is also
 * redistribution, which is why `THIRD-PARTY.md` exists and is generated.
 */
const BUNDLED_GRAMMAR_DIR = new URL('../../grammars/', import.meta.url);

const require = createRequire(import.meta.url);
const cache = new Map<LanguageId, Language>();
let runtimeReady: Promise<void> | undefined;

/**
 * Resolve a grammar to a path on this machine.
 *
 * The copy bundled in this package wins; `tree-sitter-wasms` is the fallback, for a
 * source checkout that has not run `pnpm build` yet. Note what this function does *not*
 * do: it never constructs a URL from a version string, a CDN base, or anything else.
 * Grammars come off disk — either the ones shipped here or the ones a package manager
 * already installed. A "fetch the grammar on first use" cache is the most natural way
 * to break Law 1 without noticing, because it works perfectly on the machine that
 * wrote it.
 */
export function grammarPath(language: LanguageId): string {
  const file = WASM_BY_LANGUAGE[language];

  const bundled = fileURLToPath(new URL(file, BUNDLED_GRAMMAR_DIR));
  if (existsSync(bundled)) return bundled;

  try {
    return require.resolve(`tree-sitter-wasms/out/${file}`);
  } catch {
    throw new GrammarUnavailableError(
      `smelt: no grammar for "${language}". The bundled copy is missing (run ` +
        `\`pnpm build\` in a source checkout) and \`tree-sitter-wasms\` is not installed ` +
        `either. Pass \`language: 'unknown'\` to use the lexical planner.`,
    );
  }
}

/**
 * Load a grammar, from disk, once.
 *
 * The bytes are read here and handed to tree-sitter as a `Uint8Array` rather than
 * passing it a path. `Language.load()` accepts `string | URL`, and a `URL` with an
 * `https:` scheme would make it fetch — inside the elision path, from a dependency's
 * ordinary happy path. Reading the file ourselves removes that capability instead of
 * documenting it, and {@link assertLocalResource} rejects a remote path before we get
 * that far.
 */
export async function loadGrammar(language: LanguageId): Promise<Language> {
  const cached = cache.get(language);
  if (cached !== undefined) return cached;

  runtimeReady ??= Parser.init();
  await runtimeReady;

  const resolved = assertLocalResource(grammarPath(language));
  const bytes = await readFile(fileURLToPath(resolved));
  const grammar = await Language.load(new Uint8Array(bytes));
  cache.set(language, grammar);
  return grammar;
}

/** Reset the grammar cache. Tests use it; production has no reason to. */
export function clearGrammarCache(): void {
  cache.clear();
  runtimeReady = undefined;
}
