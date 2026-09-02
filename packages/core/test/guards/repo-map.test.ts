import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { tagsCacheKey, TAGS_CACHE_FORMAT } from '@guard/repomap/cache';
import {
  buildRepoMap,
  REPO_MAP_CACHE_CORRUPT_RULE,
  REPO_MAP_FOCUS_RULE,
  REPO_MAP_ID,
  REPO_MAP_PATH_ONLY_RULE,
  REPO_MAP_RANKED_RULE,
  REPO_MAP_UNREFERENCED_RULE,
} from '@guard/repomap/map';
import { EXIT, runCli } from '@guard/cli/run';
import { SmeltError } from '@guard/errors';
import { extractTags } from '@guard/repomap/tags';

import type { GuardMutation } from './_mutations.ts';

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
 *  7. **The `smelt map` report tells the truth.** The stderr "bytes used" figure is
 *     the byte count of what actually landed on stdout, read off the RepoMap —
 *     never a second tally, never the budget dressed up as a measurement.
 *
 * Mutations for 2, 1, 4, 5 and 7 live in the MUTATIONS export at the bottom of this
 * file; `pnpm mutate` proves each one turns this file red.
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

  it('counts refsOut once per reference, not once per definer file (Law 4)', async () => {
    // `dup` is defined in TWO other files. a.ts makes exactly 2 references to it, so
    // its "references out" is 2 — an implementation that walks the per-definer edge
    // loop for this number reports 4, and every explanation a.ts's symbols carry
    // states a number nothing measured.
    const root = scratch('smelt-repomap-refsout-');
    writeFileSync(
      join(root, 'a.ts'),
      'export function useDup(): number {\n  return dup() + dup();\n}\n' +
        'export function callUseDup(): number {\n  return useDup();\n}\n',
    );
    writeFileSync(join(root, 'b.ts'), 'export function dup(): number {\n  return 1;\n}\n');
    writeFileSync(join(root, 'c.ts'), 'export function dup(): number {\n  return 2;\n}\n');

    const map = await buildRepoMap({ root, budgetBytes: BUDGET });
    const useDup = map.entries.find((entry) => entry.name === 'useDup');
    expect(useDup).toBeDefined();
    expect(useDup!.refsOut).toBe(2);
    expect(useDup!.reason.explanation).toContain('makes 2 references out');
    expect(map.text).toContain('useDup [1 in from 1 file, 2 out]');
  });

  it('never reports a bodiless C/C++ specifier as a definition (Law 2 — the receipt must be true)', async () => {
    // `struct point p;` parses as a struct_specifier exactly like the bodied
    // definition does. Reporting it as a definition mints a false `defined at`
    // receipt, AND poisons defNameStarts so the usage no longer counts as a
    // reference — the true definition's cross-file rank silently evaporates.
    // Mutation: `pnpm mutate` removes the body requirement, and this must go red.
    const tags = await extractTags(
      [
        'struct point {',
        '  int x;',
        '  int y;',
        '};',
        '',
        'enum color {',
        '  RED,',
        '  BLUE,',
        '};',
        '',
        'struct point origin(void);',
        '',
        'enum color pick(struct point p);',
        '',
      ].join('\n'),
      'c',
    );

    // Exactly the 2 real definitions — the usage sites must not add fake ones.
    expect(tags.defs.map((def) => `${def.kind} ${def.name}`)).toEqual([
      'struct point',
      'enum color',
    ]);
    // And the usage sites now count as references, so the true definitions regain
    // their cross-file rank: `point` is mentioned twice below its definition
    // (`origin`'s return type and `pick`'s parameter), `color` once.
    expect(tags.refs).toContainEqual({ name: 'point', count: 2 });
    expect(tags.refs).toContainEqual({ name: 'color', count: 1 });
  });

  it('regains cross-file references for a C definition mentioned in another file', async () => {
    // The audit's shape end to end: the header defines `struct point`; the consumer
    // file only *mentions* the type. Before the body check, the consumer's mention
    // was itself reported as a definition (with a fake receipt) and its name node
    // swallowed the reference — so the real definition ranked as unreferenced.
    const root = scratch('smelt-repomap-cspec-');
    writeFileSync(join(root, 'point.h'), 'struct point {\n  int x;\n  int y;\n};\n');
    writeFileSync(
      join(root, 'use.c'),
      'struct point make_origin(void);\n\nstruct point make_origin(void) {\n' +
        '  struct point p;\n  p.x = 0;\n  p.y = 0;\n  return p;\n}\n',
    );

    const map = await buildRepoMap({ root, budgetBytes: BUDGET });
    const pointDefs = map.entries.filter((entry) => entry.name === 'point');
    expect(pointDefs, 'the bodiless mentions in use.c minted extra definitions').toHaveLength(1);
    expect(pointDefs[0]!.path).toBe('point.h');
    expect(pointDefs[0]!.reason.rule).toBe(REPO_MAP_RANKED_RULE);
    expect(pointDefs[0]!.refsIn, 'the usage sites no longer count as references').toBeGreaterThan(
      0,
    );
    expect(pointDefs[0]!.refsInFiles).toBe(1);
  });

  it('treats a trailing-slash ignore entry as the documented root-relative prefix', async () => {
    // `build/` contains a `/`, so the doc promises prefix matching: the root-level
    // build tree is skipped, and a nested `deep/build` — a different path entirely —
    // is not. Stripping the slash first used to demote `build/` to a bare name that
    // matched every `build` segment at any depth.
    const root = scratch('smelt-repomap-slash-');
    mkdirSync(join(root, 'build'), { recursive: true });
    mkdirSync(join(root, 'deep', 'build'), { recursive: true });
    writeFileSync(
      join(root, 'build', 'top.ts'),
      'export function topLevelArtifact(): number {\n  return 1;\n}\n',
    );
    writeFileSync(
      join(root, 'deep', 'build', 'nested.ts'),
      'export function nestedKeeper(): number {\n  return 2;\n}\n',
    );

    const map = await buildRepoMap({ root, budgetBytes: BUDGET, ignore: ['build/'] });
    const names = map.entries.map((entry) => entry.name);
    expect(names, 'the root-level build/ tree was not ignored').not.toContain('topLevelArtifact');
    expect(
      names,
      'a trailing-slash entry leaked into bare-name mode and ate deep/build too',
    ).toContain('nestedKeeper');
  });

  it('promotes a focus match without touching its measured numbers, and says which term', async () => {
    const plain = await buildRepoMap({ root: fixtureRoot, budgetBytes: BUDGET });
    const focused = await buildRepoMap({
      root: fixtureRoot,
      budgetBytes: BUDGET,
      focus: ['unusedHelper'],
    });

    // Promotion only: place in the fill order changes, rank and counts do not.
    const top = focused.entries[0]!;
    expect(top.name).toBe('unusedHelper');
    expect(top.reason.rule).toBe(REPO_MAP_FOCUS_RULE);
    expect(top.reason.explanation).toContain('matches focus "unusedHelper"');
    const unpromoted = plain.entries.find((entry) => entry.name === 'unusedHelper')!;
    expect(top.rank).toBe(unpromoted.rank);
    expect(top.refsIn).toBe(unpromoted.refsIn);

    // Deterministic with focus too — a stable partition of a total order.
    const again = await buildRepoMap({
      root: fixtureRoot,
      budgetBytes: BUDGET,
      focus: ['unusedHelper'],
    });
    expect(JSON.stringify(again)).toBe(JSON.stringify(focused));
  });

  it('reports bytes used truthfully through the CLI: the stderr figure IS the stdout byte count', async () => {
    // `smelt map`'s report law, same as the smelt report's: every number is read off
    // the RepoMap the library returned, never tallied separately. The mutation
    // `repomap-map-report-bytes-invented` wires the figure to the budget and this
    // assertion must go red — a budget-fitting report that lies about bytes used
    // would make the one honest number in the subcommand a decoration.
    let stdout = '';
    let stderr = '';
    const code = await runCli(['map', fixtureRoot, '--budget', String(BUDGET)], {
      stdout: (text: string) => {
        stdout += text;
      },
      stderr: (text: string) => {
        stderr += text;
      },
      stdin: () => '',
      version: '0.0.0-guard',
    });
    expect(code).toBe(EXIT.ok);

    const match = stderr.match(/bytes used ([\d,]+) of ([\d,]+) budget/);
    expect(match, 'the report no longer states bytes used against the budget').not.toBeNull();
    const reported = Number(match![1]!.replaceAll(',', ''));
    expect(reported, 'the report lies about the bytes the map used').toBe(
      Buffer.byteLength(stdout, 'utf8'),
    );
    expect(Number(match![2]!.replaceAll(',', ''))).toBe(BUDGET);
  });
});

/**
 * The breaks this guard must catch. `pnpm mutate` applies each one to a scratch copy
 * of `src` and asserts this file goes red — see `test/guards/_mutations.ts`.
 */
export const MUTATIONS: GuardMutation[] = [
  {
    id: 'repomap-budget-unenforced',
    file: 'repomap/map.ts',
    find: '    if (bytes + lineBytes > budgetBytes) return false;',
    replace: '    if (false) return false;',
    why: 'the repo-map byte budget ignored — a map that overruns the budget it was handed breaks the planner contract silently',
  },
  {
    id: 'repomap-tiebreak-dropped',
    file: 'repomap/rank.ts',
    find: '  if (a.name !== b.name) return a.name < b.name ? -1 : 1;',
    replace: '  // name tie-break removed',
    why: 'the stable path+name tie-break loses its name leg — equal-rank symbols fall back to incidental document order, and byte-for-byte determinism quietly dies',
  },
  {
    id: 'repomap-cache-key-ignores-content',
    file: 'repomap/cache.ts',
    find: '  return contentHash(`${TAGS_CACHE_FORMAT}/${String(TAGS_CACHE_VERSION)}\\0${language}\\0${content}`);',
    replace:
      '  return contentHash(`${TAGS_CACHE_FORMAT}/${String(TAGS_CACHE_VERSION)}\\0${language}`);',
    why: 'the cache key no longer derived from file content — an edited file is answered with stale tags, the exact staleness a content-hash key exists to make impossible',
  },
  {
    id: 'repomap-corrupt-cache-trusted',
    file: 'repomap/cache.ts',
    find: "    if (tags === undefined) {\n      this.#discard(key);\n      return 'corrupt';\n    }",
    replace: '    if (tags === undefined) {\n      return { defs: [], refs: [] };\n    }',
    why: 'a corrupt cache entry quietly trusted as empty tags instead of discarded loudly — symbols vanish from the map with no warning anywhere',
  },
  {
    id: 'repomap-refsout-per-definer',
    file: 'repomap/rank.ts',
    find: '    refsOut: refsOutByFile.get(def.path) ?? 0,',
    replace: '    refsOut: outWeight.get(def.path) ?? 0,',
    why: 'refsOut reported from the PageRank edge denominator, which grows once per definer file — a reference to a name two files define counts double, and every Law 2 explanation states a number nothing measured',
  },
  {
    id: 'repomap-usage-site-counted-as-definition',
    file: 'repomap/tags.ts',
    find:
      "  if (BODY_REQUIRED_TYPES.has(node.type) && node.childForFieldName('body') === null) {\n" +
      '    return false; // a bodiless specifier is a usage or forward declaration, not a definition\n' +
      '  }\n',
    replace: '',
    why: "the C/C++ body requirement dropped — `struct point p;` earns a `defined at` receipt it never had, and its name node poisons defNameStarts so the true definition's cross-file references silently vanish from the map",
  },
  {
    id: 'repomap-map-report-bytes-invented',
    file: 'cli/report.ts',
    find: '    `bytes used ${group(map.outputBytes)} of ${group(map.budgetBytes)} budget — the map ` +',
    replace:
      '    `bytes used ${group(map.budgetBytes)} of ${group(map.budgetBytes)} budget — the map ` +',
    why: "the map report's bytes-used figure wired to the budget — a budget-fitting report that always claims the budget spent, so the one number a human reads off `smelt map` stops being a measurement",
  },
];
