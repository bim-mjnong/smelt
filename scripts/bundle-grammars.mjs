#!/usr/bin/env node
/**
 * Copy the grammars smelt supports into the package, so they ship inside the tarball.
 *
 * This is what makes "zero native compilation, works offline" a fact rather than a
 * hope. The alternative — an optional peer dependency the consumer has to remember —
 * fails in the most annoying possible way: structural planning silently unavailable on
 * someone else's machine, discovered from a `GrammarUnavailableError` in production.
 *
 * Bundling is redistribution, which is why `scripts/generate-third-party.mjs` exists
 * and why `THIRD-PARTY.md` is generated rather than written.
 *
 * The list of grammars is **not** duplicated here. It is read from the built
 * `WASM_BY_LANGUAGE` map, which is typed `Record<LanguageId, string>` — so adding a
 * language without a grammar is already a compile error, and this script cannot fall
 * behind that map. Run after `tsc`.
 */

import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const corePackage = join(repoRoot, 'packages/core');
const outDir = join(corePackage, 'grammars');

const { WASM_BY_LANGUAGE } = await import(join(corePackage, 'dist/index.js'));
if (typeof WASM_BY_LANGUAGE !== 'object' || WASM_BY_LANGUAGE === null) {
  throw new Error(
    'bundle-grammars: dist/index.js does not export WASM_BY_LANGUAGE. Run `tsc` first.',
  );
}

const require = createRequire(join(corePackage, 'package.json'));

// Rebuild the directory from scratch, so a grammar dropped from the map does not linger
// in the tarball and keep getting attributed in THIRD-PARTY.md.
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const wanted = [...new Set(Object.values(WASM_BY_LANGUAGE))].sort();
let bytes = 0;

for (const file of wanted) {
  let source;
  try {
    source = require.resolve(`tree-sitter-wasms/out/${file}`);
  } catch {
    throw new Error(
      `bundle-grammars: tree-sitter-wasms does not provide "${file}", which ` +
        `WASM_BY_LANGUAGE claims. Either the grammar package changed its contents or ` +
        `the map names a file that does not exist.`,
    );
  }
  copyFileSync(source, join(outDir, file));
  bytes += statSync(source).size;
}

const copied = readdirSync(outDir).sort();
if (copied.length !== wanted.length) {
  throw new Error(
    `bundle-grammars: expected ${wanted.length} grammars in grammars/, found ${copied.length}.`,
  );
}

process.stdout.write(
  `bundle-grammars: ${copied.length} grammars, ${(bytes / 1024 / 1024).toFixed(1)} MB → ` +
    `packages/core/grammars/\n`,
);
