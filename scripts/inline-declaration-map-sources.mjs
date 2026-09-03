#!/usr/bin/env node
/**
 * Fill the one gap TypeScript leaves in a self-contained sourcemap.
 *
 * A published package ships `dist`, never `src` — that is what `files` says, and
 * packing the source as well would put a second copy of the tree in the tarball that
 * can drift from the one the maps name. But the maps tsc emits point at `../src/*.ts`
 * by path, so on a consumer's machine every one of those paths is a file that was
 * never published: go-to-definition lands nowhere, and a stack trace resolves to
 * nothing. The fix is to carry the sources *inside* the maps (`sourcesContent`), which
 * costs the same bytes once and cannot drift.
 *
 * `compilerOptions.inlineSources` does exactly that — **for JavaScript maps only**.
 * TypeScript does not write `sourcesContent` into declaration maps (`*.d.ts.map`), so
 * `declarationMap` alone ships a map that is dead on arrival. This step fills those,
 * and only those: the `.js.map` files are tsc's own job, and if `inlineSources` is ever
 * dropped from `tsconfig.json` this script must not quietly paper over it —
 * `test/guards/packaging.test.ts` has to go red instead.
 *
 * Idempotent, and a hard error on anything it cannot do honestly: a map naming a
 * source that is not on disk is a build that would have shipped a dead map anyway.
 *
 * Usage: `node scripts/inline-declaration-map-sources.mjs [distDir]` from a package
 * directory (default `dist`).
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const distDir = resolve(process.argv[2] ?? 'dist');

function die(message) {
  console.error(`inline-declaration-map-sources: ${message}`);
  process.exit(1);
}

/** Every `*.d.ts.map` under `dist`, recursively. */
function declarationMaps(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...declarationMaps(path));
    else if (entry.name.endsWith('.d.ts.map')) found.push(path);
  }
  return found;
}

const maps = declarationMaps(distDir);
if (maps.length === 0) {
  die(`no *.d.ts.map under ${distDir} — declarationMap is off, or the build did not run`);
}

let filled = 0;
for (const mapPath of maps) {
  const map = JSON.parse(readFileSync(mapPath, 'utf8'));
  const sources = map.sources ?? [];
  if (sources.length === 0) die(`${mapPath} names no sources`);
  // Already self-contained (a re-run, or a future tsc that learned to do this).
  if (Array.isArray(map.sourcesContent) && map.sourcesContent.every((s) => typeof s === 'string')) {
    continue;
  }
  map.sourcesContent = sources.map((source) => {
    // `sourceRoot` is empty in this repo's configs; honour it anyway rather than
    // resolving a path that the map itself says is relative to something else.
    const sourcePath = resolve(dirname(mapPath), map.sourceRoot ?? '', source);
    try {
      return readFileSync(sourcePath, 'utf8');
    } catch {
      return die(`${mapPath} names source "${source}", which is not readable at ${sourcePath}`);
    }
  });
  writeFileSync(mapPath, JSON.stringify(map));
  filled += 1;
}

console.log(
  `inline-declaration-map-sources: ${String(filled)} of ${String(maps.length)} declaration maps filled`,
);
