import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildRepoMap, REPO_MAP_FOCUS_RULE } from '../src/repomap/map.ts';
import type { RepoMap } from '../src/repomap/map.ts';
import { CLI_MAP_JSON_FORMAT, cliUsage, EXIT, runCli } from '../src/cli/run.ts';
import type { CliIo } from '../src/cli/run.ts';

/**
 * `smelt map` — the repo map's front door, end to end and in-process (the
 * `runCli` pattern from `test/cli.test.ts`). The report-honesty half — the stderr
 * figures matching what actually landed on stdout — lives in
 * `test/guards/repo-map.test.ts`, where a mutation proves it can go red; this file
 * covers the subcommand's plumbing: parsing, config, the envelope, the exit codes.
 */

const fixtureRoot = fileURLToPath(new URL('fixtures/repomap-repo', import.meta.url));

interface Captured {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'smelt-cli-map-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function run(argv: readonly string[], cwd?: string): Promise<Captured> {
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    stdin: () => '',
    version: '9.9.9-test',
    ...(cwd === undefined ? {} : { cwd }),
  };
  const code = await runCli(argv, io);
  return { code, stdout, stderr };
}

describe('smelt map renders the ranked symbol map', () => {
  it('prints the map on stdout, the report on stderr, and exits 0', async () => {
    const { code, stdout, stderr } = await run(['map', fixtureRoot, '--budget', '10000']);
    expect(code).toBe(EXIT.ok);
    // The cross-file symbol the fixture repo is built around ranks first.
    expect(stdout.split('\n')[0]).toContain('readSettings');
    expect(stderr).toContain('smelt map  ');
    expect(stderr).toContain('files scanned');
    expect(stderr).toContain('symbols ranked');
    expect(stderr).toMatch(/bytes used [\d,]+ of [\d,]+ budget/);
    // The budget line carries its provenance — the ResolvedMapRun.budgetSource
    // receipt — so a surprising budget is traceable without re-deriving precedence.
    expect(stderr).toContain('budget (flag)');
  });

  it('matches the committed snapshot on the fixture repo, so a map change is a reviewable diff', async () => {
    const { stdout } = await run(['map', fixtureRoot, '--budget', '10000']);
    await expect(stdout).toMatchFileSnapshot('__snapshots__/cli-map.fixture.txt');
  });

  it('exits 0 on a tight budget — the map fits itself by construction, never over-budget', async () => {
    const { code, stdout, stderr } = await run(['map', fixtureRoot, '--budget', '80']);
    expect(code).toBe(EXIT.ok);
    expect(code).not.toBe(EXIT.overBudget);
    expect(Buffer.byteLength(stdout, 'utf8')).toBeLessThanOrEqual(80);
    expect(stderr).not.toContain('OVER BUDGET');
    expect(stderr).toContain('by construction');
  });

  it('--json emits the RepoMap verbatim in its own versioned envelope', async () => {
    const { code, stdout } = await run(['map', fixtureRoot, '--budget', '10000', '--json']);
    expect(code).toBe(EXIT.ok);
    const envelope = JSON.parse(stdout) as { format: string; map: RepoMap };
    expect(envelope.format).toBe(CLI_MAP_JSON_FORMAT);

    // The same build through the library, compared field for field. If the CLI
    // reshaped, renamed or dropped anything, this fails.
    const expected = await buildRepoMap({ root: fixtureRoot, budgetBytes: 10_000 });
    expect(envelope.map).toEqual(JSON.parse(JSON.stringify(expected)));
  });

  it('promotes --focus matches to the front, with a receipt naming the term', async () => {
    const { stdout: json } = await run([
      'map',
      fixtureRoot,
      '--budget',
      '10000',
      '--focus',
      'alphaTie',
      '--json',
    ]);
    const { map } = JSON.parse(json) as { map: RepoMap };
    expect(map.entries[0]?.name).toBe('alphaTie');
    expect(map.entries[0]?.reason.rule).toBe(REPO_MAP_FOCUS_RULE);
    expect(map.entries[0]?.reason.explanation).toContain('matches focus "alphaTie"');
    // Promotion only: without focus the same symbol carries the same measured rank.
    const plain = await buildRepoMap({ root: fixtureRoot, budgetBytes: 10_000 });
    const unpromoted = plain.entries.find((entry) => entry.name === 'alphaTie');
    expect(map.entries[0]?.rank).toBe(unpromoted?.rank);
  });

  it('honors --ignore, replacing the default list', async () => {
    const { stdout } = await run([
      'map',
      fixtureRoot,
      '--budget',
      '10000',
      '--ignore',
      'src/ties.ts',
      '--ignore',
      'tools',
    ]);
    expect(stdout).not.toContain('alphaTie');
    expect(stdout).not.toContain('tally');
    expect(stdout).toContain('readSettings');
  });

  it('writes to disk only through --cache, and reports the counts', async () => {
    const cacheDir = join(dir, 'tags-cache');
    const cold = await run(['map', fixtureRoot, '--budget', '10000', '--cache', cacheDir]);
    expect(cold.stderr).toMatch(/cache {2}0 hits, [\d,]+ misses, 0 discarded/);
    const warm = await run(['map', fixtureRoot, '--budget', '10000', '--cache', cacheDir]);
    expect(warm.stderr).toMatch(/cache {2}[\d,]+ hits, 0 misses, 0 discarded/);
    expect(warm.stdout).toBe(cold.stdout);

    const uncached = await run(['map', fixtureRoot, '--budget', '10000']);
    expect(uncached.stderr).not.toContain('cache ');
  });
});

describe('smelt map owns its errors the way every mode does', () => {
  it('requires --budget, or a config default — same refusal, map wording', async () => {
    const { code, stderr } = await run(['map', fixtureRoot]);
    expect(code).toBe(EXIT.usage);
    expect(stderr).toMatch(/--budget is required/);
    expect(stderr).toMatch(/how much of the map to leave out/);
  });

  it('takes the budget from smelt.config.json when the flag is absent — and says so', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'smelt-map-config-'));
    try {
      writeFileSync(
        join(cwd, 'smelt.config.json'),
        `${JSON.stringify({ smeltConfig: 1, defaultBudgetBytes: 10_000 })}\n`,
      );
      const { code, stdout, stderr } = await run(['map', fixtureRoot], cwd);
      expect(code).toBe(EXIT.ok);
      expect(stdout).toContain('readSettings');
      expect(stderr).toContain('budget (config)');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('needs the directory, and exactly one', async () => {
    const missing = await run(['map', '--budget', '4000']);
    expect(missing.code).toBe(EXIT.usage);
    expect(missing.stderr).toMatch(/map needs the directory/);

    const two = await run(['map', 'a', 'b', '--budget', '4000']);
    expect(two.code).toBe(EXIT.usage);
    expect(two.stderr).toMatch(/exactly one directory/);
  });

  it('says which directory it could not read, and refuses a file', async () => {
    const gone = await run(['map', join(dir, 'nope'), '--budget', '4000']);
    expect(gone.code).toBe(EXIT.usage);
    expect(gone.stderr).toMatch(/cannot read directory/);

    const file = join(dir, 'a-file.ts');
    writeFileSync(file, 'export const x = 1;\n');
    const notDir = await run(['map', file, '--budget', '4000']);
    expect(notDir.code).toBe(EXIT.usage);
    expect(notDir.stderr).toMatch(/not a directory/);
  });

  it('refuses --language, --strategy and --reconstruct — a map is not a planner strategy', async () => {
    const strategy = await run(['map', fixtureRoot, '--budget', '4000', '--strategy', 'lexical']);
    expect(strategy.code).toBe(EXIT.usage);
    expect(strategy.stderr).toMatch(/not a planner\s+strategy/);

    const language = await run(['map', fixtureRoot, '--budget', '4000', '--language', 'python']);
    expect(language.code).toBe(EXIT.usage);

    const reconstruct = await run(['map', fixtureRoot, '--reconstruct']);
    expect(reconstruct.code).toBe(EXIT.usage);
    expect(reconstruct.stderr).toMatch(/elides nothing/);
  });

  it('refuses the map-only flags outside map, instead of ignoring them', async () => {
    const ignore = await run(['--budget', '4000', '--ignore', '.git']);
    expect(ignore.code).toBe(EXIT.usage);
    expect(ignore.stderr).toMatch(/belong to `smelt map`/);

    const cache = await run(['--budget', '4000', '--cache', '/tmp/x']);
    expect(cache.code).toBe(EXIT.usage);
  });
});

describe('the help text documents the subcommand from the real registries', () => {
  it('names map, its flags, the Aider credit, and the no-over-budget exit', () => {
    const usage = cliUsage();
    expect(usage).toContain('smelt map <dir> --budget <bytes>');
    expect(usage).toContain("Aider's repo-map");
    expect(usage).toContain('--ignore <entry>');
    expect(usage).toContain('--cache <dir>');
    expect(usage).toMatch(/map never exits\s+1/);
  });
});
