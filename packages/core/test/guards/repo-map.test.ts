import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { tagsCacheKey, TAGS_CACHE_FORMAT } from '@guard/repomap/cache';
import {
  buildRepoMap,
  REPO_MAP_CACHE_CORRUPT_RULE,
  REPO_MAP_ID,
  REPO_MAP_PATH_ONLY_RULE,
  REPO_MAP_RANKED_RULE,
  REPO_MAP_UNREFERENCED_RULE,
} from '@guard/repomap/map';
import { SmeltError } from '@guard/errors';

/**
 * REPO-MAP GUARD — the guarantees Slice 7 claims.
 *
 * The repo map is modelled on Aider's (https://aider.chat/docs/repomap.html) and
 * inherits this repo's laws on top of it. Each property here could quietly rot into
 * something that still *looks* like a repo map from the outside:
 *
 *  1. **Deterministic, byte for byte.** Fixed PageRank constants and a total
 *     tie-break (rank, path, name, line). Equal-rank symbols in one file must come
 *     out name-sorted — lose the tie-break and the map's ordering becomes whatever
 *     the walk happened to produce.
 *  2. **The byte budget is respected**, and the included set is a rank-order prefix.
 *     A map that overruns the budget it was handed breaks the planner contract
 *     silently; a map that skips its #2 symbol to squeeze in its #9 lies about what
 *     mattered.
 *  3. **Every inclusion is explainable** — Law 2 applied to inclusion: rule id plus
 *     a sentence naming the definition site and the measured reference counts.
 *  4. **The cache invalidates on content change.** The key is a content hash; edit
 *     the file and the stale entry must never be served again.
 *  5. **A corrupt cache entry is discarded loudly, never trusted.** Trusting one
 *     silently drops symbols from the map with no error anywhere.
 *  6. **The walk stays inside the root**: symlinks are never followed, binary files
 *     are skipped, the ignore list is honored.
 *
 * Mutations for 2, 1, 4 and 5 live in `scripts/mutate.mjs`; `pnpm mutate` proves
 * each one turns this file red.
 */

const fixtureRoot = fileURLToPath(new URL('../fixtures/repomap-repo', import.meta.url));

const scratchDirs: string[] = [];
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

const BUDGET = 10_000;

describe('Slice 7 — the repo map keeps its claims', () => {
  it('is deterministic: two runs are byte-identical, with or without a cache', async () => {
    const cold = await buildRepoMap({ root: fixtureRoot, budgetBytes: BUDGET });
    const again = await buildRepoMap({ root: fixtureRoot, budgetBytes: BUDGET });
    expect(again.text).toBe(cold.text);
    expect(JSON.stringify(again)).toBe(JSON.stringify(cold));

    // A cache must be an optimization, never an author: the map built through a cold
    // cache and through a warm one is the same map, byte for byte.
    const cacheDir = scratch('smelt-repomap-cache-');
    const cachedCold = await buildRepoMap({ root: fixtureRoot, budgetBytes: BUDGET, cacheDir });
    const cachedWarm = await buildRepoMap({ root: fixtureRoot, budgetBytes: BUDGET, cacheDir });
    expect(cachedCold.text).toBe(cold.text);
    expect(cachedWarm.text).toBe(cold.text);
    expect(cachedWarm.entries).toEqual(cold.entries);
  });

  it('breaks rank ties by path and name, so equal-rank symbols never reorder', async () => {
    const map = await buildRepoMap({ root: fixtureRoot, budgetBytes: BUDGET });
    // src/ties.ts defines zuluTie before alphaTie; both are unreferenced, so their
    // ranks are equal and only the tie-break decides. Name order must win over
    // document order.
    const tieNames = map.entries
      .filter((entry) => entry.path === 'src/ties.ts')
      .map((entry) => entry.name);
    expect(tieNames).toEqual(['alphaTie', 'zuluTie']);
  });

  it('ranks the cross-file symbol first and fits the budget with a rank-order prefix', async () => {
    const full = await buildRepoMap({ root: fixtureRoot, budgetBytes: BUDGET });
    expect(full.id).toBe(REPO_MAP_ID);
    expect(full.outputBytes).toBeLessThanOrEqual(BUDGET);
    expect(full.outputBytes).toBe(Buffer.byteLength(full.text, 'utf8'));
    // readSettings is the only symbol referenced from another file, so PageRank must
    // put it first — ahead of every unreferenced definition.
    expect(full.entries[0]?.name).toBe('readSettings');
    expect(full.entries[0]?.rank).toBeGreaterThan(0);
    expect(full.definitionsTotal).toBe(full.entries.length);

    // A budget that only fits the first line: the map keeps exactly the top-ranked
    // symbol and stays under budget — never over, never a different symbol.
    const firstLine = full.text.split('\n')[0]!;
    const tight = await buildRepoMap({
      root: fixtureRoot,
      budgetBytes: Buffer.byteLength(firstLine, 'utf8') + 1,
    });
    expect(tight.outputBytes).toBeLessThanOrEqual(tight.budgetBytes);
    expect(tight.entries.map((entry) => entry.name)).toEqual(['readSettings']);
    expect(tight.definitionsTotal).toBe(full.definitionsTotal);
    expect(tight.pathOnly).toEqual([]);

    // A budget nothing fits: an empty map, not an overrun one.
    const none = await buildRepoMap({ root: fixtureRoot, budgetBytes: 3 });
    expect(none.text).toBe('');
    expect(none.entries).toEqual([]);
  });

  it('explains every inclusion: rule id, definition site, measured counts', async () => {
    const map = await buildRepoMap({ root: fixtureRoot, budgetBytes: BUDGET });
    expect(map.entries.length, 'no entries — this guard would be vacuous').toBeGreaterThan(3);
    for (const entry of map.entries) {
      expect([REPO_MAP_RANKED_RULE, REPO_MAP_UNREFERENCED_RULE]).toContain(entry.reason.rule);
      expect(entry.reason.explanation).toMatch(/^defined at .+:\d+/);
    }
    const top = map.entries[0]!;
    expect(top.reason.rule).toBe(REPO_MAP_RANKED_RULE);
    expect(top.reason.explanation).toMatch(/\d+ references? in from \d+ files?/);
    expect(top.reason.explanation).toMatch(/\d+ references? out/);
    const unreferenced = map.entries.find((entry) => entry.name === 'unusedHelper');
    expect(unreferenced?.reason.rule).toBe(REPO_MAP_UNREFERENCED_RULE);
    expect(unreferenced?.reason.explanation).toContain('no references');

    // Files with nothing parseable are still visible, with their own rule.
    const notes = map.pathOnly.find((entry) => entry.path === 'notes.md');
    expect(notes?.reason.rule).toBe(REPO_MAP_PATH_ONLY_RULE);
    expect(notes?.reason.explanation).not.toBe('');
  });

  it('counts cache activity honestly: all misses cold, all hits warm', async () => {
    const cacheDir = scratch('smelt-repomap-counts-');
    const cold = await buildRepoMap({ root: fixtureRoot, budgetBytes: BUDGET, cacheDir });
    expect(cold.cache).toBeDefined();
    expect(cold.cache!.hits).toBe(0);
    expect(cold.cache!.misses).toBeGreaterThan(0);
    expect(cold.cache!.discarded).toBe(0);

    const warm = await buildRepoMap({ root: fixtureRoot, budgetBytes: BUDGET, cacheDir });
    expect(warm.cache!.hits).toBe(cold.cache!.misses);
    expect(warm.cache!.misses).toBe(0);

    // No cacheDir handed in → no cache counts invented, and nothing written to disk.
    const uncached = await buildRepoMap({ root: fixtureRoot, budgetBytes: BUDGET });
    expect(uncached.cache).toBeUndefined();
  });

  it('invalidates the cache when file content changes', async () => {
    const root = scratch('smelt-repomap-edit-');
    const cacheDir = scratch('smelt-repomap-edit-cache-');
    const file = join(root, 'only.ts');

    writeFileSync(file, 'export function firstName(): string {\n  return "one";\n}\n');
    const before = await buildRepoMap({ root, budgetBytes: BUDGET, cacheDir });
    expect(before.entries.map((entry) => entry.name)).toContain('firstName');

    writeFileSync(file, 'export function secondName(): string {\n  return "two";\n}\n');
    const after = await buildRepoMap({ root, budgetBytes: BUDGET, cacheDir });
    expect(
      after.entries.map((entry) => entry.name),
      'the edited file was answered with stale cached tags',
    ).toContain('secondName');
    expect(after.entries.map((entry) => entry.name)).not.toContain('firstName');
  });

  it('discards a corrupt cache entry loudly — a warning and a re-extraction, never trust', async () => {
    const root = scratch('smelt-repomap-corrupt-');
    const cacheDir = scratch('smelt-repomap-corrupt-cache-');
    const content = 'export function survivor(): string {\n  return "here";\n}\n';
    writeFileSync(join(root, 'only.ts'), content);

    // Plant an entry at the exact key the build will look up: valid JSON, wrong
    // shape (a version this code does not understand, so its tags cannot be trusted).
    const key = tagsCacheKey('typescript', content);
    mkdirSync(join(cacheDir, 'tags'), { recursive: true });
    writeFileSync(
      join(cacheDir, 'tags', `${key}.json`),
      `${JSON.stringify({ format: TAGS_CACHE_FORMAT, version: 999, defs: [], refs: [] })}\n`,
    );

    const map = await buildRepoMap({ root, budgetBytes: BUDGET, cacheDir });
    expect(map.cache!.discarded).toBe(1);
    expect(map.warnings.map((warning) => warning.rule)).toContain(REPO_MAP_CACHE_CORRUPT_RULE);
    expect(map.warnings[0]!.explanation).toContain('only.ts');
    // The symbol still appears — re-extracted from source, not lost to the bad entry.
    expect(map.entries.map((entry) => entry.name)).toContain('survivor');

    // The discard rewrote a valid entry: the next build hits cleanly, no warning.
    const healed = await buildRepoMap({ root, budgetBytes: BUDGET, cacheDir });
    expect(healed.warnings).toEqual([]);
    expect(healed.cache!.hits).toBe(1);
    expect(healed.cache!.discarded).toBe(0);
  });

  it('never follows a symlink, so the walk cannot leave the root', async () => {
    const root = scratch('smelt-repomap-links-');
    const outside = scratch('smelt-repomap-outside-');
    writeFileSync(
      join(root, 'real.ts'),
      'export function insideTheRoot(): number {\n  return 1;\n}\n',
    );
    writeFileSync(
      join(outside, 'secret.ts'),
      'export function leakedSecretToken(): number {\n  return 2;\n}\n',
    );
    symlinkSync(join(outside, 'secret.ts'), join(root, 'link.ts'));
    symlinkSync(outside, join(root, 'linkdir'));

    const map = await buildRepoMap({ root, budgetBytes: BUDGET });
    expect(map.filesScanned).toBe(1);
    const names = map.entries.map((entry) => entry.name);
    expect(names).toContain('insideTheRoot');
    expect(names, 'a symlink was followed out of the root').not.toContain('leakedSecretToken');
    expect(map.text).not.toContain('leakedSecretToken');
  });

  it('skips binary files and honors the caller-supplied ignore list', async () => {
    // The committed fixture carries data.bin (contains a NUL byte). Self-check that
    // it is really there, so this test cannot go vacuous if the fixture moves.
    expect(readdirSync(fixtureRoot)).toContain('data.bin');

    const map = await buildRepoMap({ root: fixtureRoot, budgetBytes: BUDGET });
    expect(map.binarySkipped).toBeGreaterThanOrEqual(1);
    expect(map.text).not.toContain('data.bin');
    expect(map.pathOnly.map((entry) => entry.path)).not.toContain('data.bin');

    const ignored = await buildRepoMap({
      root: fixtureRoot,
      budgetBytes: BUDGET,
      ignore: ['tools', 'src/ties.ts'],
    });
    const names = ignored.entries.map((entry) => entry.name);
    expect(names).not.toContain('tally');
    expect(names).not.toContain('alphaTie');
    expect(names).toContain('readSettings');
  });

  it('refuses a budget that is not a positive integer', async () => {
    await expect(buildRepoMap({ root: fixtureRoot, budgetBytes: 0 })).rejects.toThrow(SmeltError);
    await expect(buildRepoMap({ root: fixtureRoot, budgetBytes: 1.5 })).rejects.toThrow(SmeltError);
  });
});
