import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { Language, Parser } from 'web-tree-sitter';

import { GrammarUnavailableError } from '../errors.ts';
import { assertLocalResource } from '../net/policy.ts';
import type { LanguageId } from '../types.ts';

/**
 * Grammar file for each language smelt claims to parse. This map is
 * `Record<LanguageId, string>` on purpose: adding a `LanguageId` without adding its
 * grammar is a type error, so the two cannot drift.
 */
const WASM_BY_LANGUAGE: Readonly<Record<LanguageId, string>> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  rust: 'tree-sitter-rust.wasm',
  python: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
};

const require = createRequire(import.meta.url);
const cache = new Map<LanguageId, Language>();
let runtimeReady: Promise<void> | undefined;

/**
 * Resolve a grammar to a path on this machine.
 *
 * Note what this function does *not* do: it never constructs a URL from a version
 * string, a CDN base, or anything else. Grammars come from a package the consumer
 * already installed. That is the whole reason `tree-sitter-wasms` is a dependency
 * rather than a download — a "fetch the grammar on first use" cache is the most natural
 * way to break Law 1 without noticing, because it works perfectly on the machine that
 * wrote it.
 */
export function grammarPath(language: LanguageId): string {
  const file = WASM_BY_LANGUAGE[language];
  try {
    return require.resolve(`tree-sitter-wasms/out/${file}`);
  } catch {
    throw new GrammarUnavailableError(
      `smelt: no grammar for "${language}". Install the optional peer dependency ` +
        `\`tree-sitter-wasms\` to enable structural planning, or pass ` +
        `\`language: 'unknown'\` to use the lexical planner.`,
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
