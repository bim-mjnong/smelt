import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { retrieveStats } from '../src/stats.ts';

/**
 * The measurement harness's own tests — the pure half.
 *
 * `bench/lib.mjs` is deliberately free of I/O, network and `dist/` imports, so its
 * logic is testable here without a build and without a key. The wired-up halves are
 * covered elsewhere: tier 1 end-to-end by an actual committed run in
 * `bench/RESULTS.md`, and the honesty properties by
 * `test/guards/bench-results.test.ts` plus its mutations.
 */

const testDir = dirname(fileURLToPath(import.meta.url));
const benchDir = resolve(testDir, '../bench');

interface BenchCase {
  readonly id: string;
  readonly file: string;
  readonly path: string;
  readonly strategy: string;
  readonly focus: readonly string[];
  readonly budgetBytes: number;
  readonly task: string;
  readonly provenance: string;
}

interface BenchLib {
  validateCases(manifest: unknown, fileExists: (file: string) => boolean): readonly string[];
  resultRow(row: Record<string, unknown>): readonly string[];
  renderTable(rows: readonly (readonly string[])[]): string;
  appendResults(existing: string, section: string): string;
  countTokensRequest(model: string, text: string): { model: string; messages: unknown[] };
  tier3Verdict(stats: { elisionsStored: number; uniqueRetrieved: number }): {
    expansionRate: number;
    loss: boolean;
  };
  tier3Aggregate(inputs: readonly { elisionsStored: number; uniqueRetrieved: number }[]): number;
  tier3RowNote(input: {
    verdict: { expansionRate: number; loss: boolean };
    retrieveCalls: number;
    truncated: boolean;
    maxRounds: number;
  }): string;
  CORPUS_REF_FORMAT: string;
  corpusRefMismatch(input: {
    refFile: string;
    from: string;
    pinned: string;
    actual: string;
  }): string;
}

let lib: BenchLib;
beforeAll(async () => {
  // A computed specifier, because tsc does not typecheck plain .mjs imports.
  lib = (await import(pathToFileURL(join(benchDir, 'lib.mjs')).href)) as BenchLib;
});

function manifest(): { format: string; cases: readonly BenchCase[] } {
  return JSON.parse(readFileSync(join(benchDir, 'cases.json'), 'utf8')) as {
    format: string;
    cases: readonly BenchCase[];
  };
}

describe('the corpus and its manifest', () => {
  it('cases.json is valid and every corpus file it names exists — as bytes or as a pinned reference', () => {
    // A by-reference entry has no committed bytes; its committed `<name>.json`
    // reference is what exists. The runner materializes the bytes before validating.
    const problems = lib.validateCases(
      manifest(),
      (file) => existsSync(join(benchDir, file)) || existsSync(join(benchDir, `${file}.json`)),
    );
    expect(problems).toEqual([]);
  });

  it('covers the shapes Slice 3 requires: a large TS file, TSX, a grep, a stack trace, a build log', () => {
    const files = manifest().cases.map((benchCase) => benchCase.file);
    expect(files.some((file) => file.endsWith('.ts'))).toBe(true);
    expect(files.some((file) => file.endsWith('.tsx'))).toBe(true);
    expect(files.some((file) => file.includes('grep'))).toBe(true);
    expect(files.some((file) => file.includes('stack-trace'))).toBe(true);
    expect(files.some((file) => file.endsWith('.log'))).toBe(true);
  });

  it('the large TS file is a pinned reference to the real source — and the pin matches it', () => {
    // The old discipline was a committed byte-copy, guarded byte-for-byte. The new
    // one is a committed reference: the runner materializes the file from the
    // working tree and refuses a hash mismatch. This test keeps the pin honest at
    // `pnpm test` time — editing src/plan/structural.ts without re-pinning goes red
    // here, exactly as the byte-copy used to.
    const ref = JSON.parse(readFileSync(join(benchDir, 'corpus/structural.ts.json'), 'utf8')) as {
      format: string;
      from: string;
      sha256: string;
    };
    expect(ref.format).toBe(lib.CORPUS_REF_FORMAT);
    expect(ref.from).toBe('packages/core/src/plan/structural.ts');
    const source = readFileSync(resolve(testDir, '../src/plan/structural.ts'));
    expect(createHash('sha256').update(source).digest('hex')).toBe(ref.sha256);
  });

  it('a drifted source is refused with instructions, never silently measured', () => {
    const message = lib.corpusRefMismatch({
      refFile: 'corpus/structural.ts.json',
      from: 'packages/core/src/plan/structural.ts',
      pinned: 'aaaa',
      actual: 'bbbb',
    });
    expect(message).toContain('REFUSING');
    expect(message).toContain('update the pinned sha256');
    expect(message).toContain('corpus/structural.ts.json');
    expect(message).toContain('aaaa');
    expect(message).toContain('bbbb');
  });

  it('the build log is what its generator derives from the lockfile, and says it is synthetic', () => {
    const committed = readFileSync(join(benchDir, 'corpus/build.log'), 'utf8');
    expect(committed.split('\n')[0]).toContain('synthetic');
    // Committed log = generator output. A drifted lockfile would make this stale silently otherwise.
    return import(pathToFileURL(join(benchDir, 'gen-build-log.mjs')).href).then(
      (generator: {
        packagesFromLockfile(text: string): readonly { name: string; version: string }[];
        renderBuildLog(packages: readonly { name: string; version: string }[]): string;
      }) => {
        const lockfile = readFileSync(resolve(testDir, '../../../pnpm-lock.yaml'), 'utf8');
        expect(committed).toBe(generator.renderBuildLog(generator.packagesFromLockfile(lockfile)));
      },
    );
  });

  it('validateCases reports missing files, empty focus, bad budgets and unknown strategies', () => {
    const broken = {
      format: 'smelt-bench-cases/v1',
      cases: [
        {
          id: 'broken',
          file: 'corpus/nope.txt',
          path: '',
          strategy: 'vibes',
          focus: [],
          budgetBytes: -1,
          task: 't',
          provenance: '',
        },
      ],
    };
    const problems = lib.validateCases(broken, () => false);
    expect(problems.join('\n')).toContain('corpus file missing');
    expect(problems.join('\n')).toContain('no focus terms');
    expect(problems.join('\n')).toContain('budgetBytes');
    expect(problems.join('\n')).toContain('strategy');
    expect(problems.join('\n')).toContain('provenance');
  });
});

describe('result rows (Law 4, structurally)', () => {
  const base = {
    caseId: 'x',
    tier: 1,
    date: '2026-09-01',
    corpusCommit: 'abcdef1234',
    unit: 'bytes',
    input: 10,
    output: 5,
    elisions: 1,
  };

  it('a token row without a model refuses to render', () => {
    expect(() => lib.resultRow({ ...base, tier: 2, unit: 'tokens' })).toThrow(/name its model/);
    expect(lib.resultRow({ ...base, tier: 2, unit: 'tokens', model: 'claude-opus-5' })[4]).toBe(
      'claude-opus-5',
    );
  });

  it('a row without a real date, commit or tier refuses to render', () => {
    expect(() => lib.resultRow({ ...base, date: 'today' })).toThrow(/date/);
    expect(() => lib.resultRow({ ...base, corpusCommit: 'not-a-hash' })).toThrow(/git hash/);
    expect(() => lib.resultRow({ ...base, tier: 4 })).toThrow(/tier/);
  });

  it('appendResults appends and never edits, and refuses extrapolation vocabulary', () => {
    const existing = '# results\n\n| old row |\n';
    const combined = lib.appendResults(existing, '| new row |');
    expect(combined.startsWith(existing.trimEnd())).toBe(true);
    expect(combined).toContain('| new row |');
    expect(() => lib.appendResults(existing, 'saves up to 94%')).toThrow(/not a measurement/);
    expect(() => lib.appendResults(existing, 'a 90% cache hit rate')).toThrow(/not a measurement/);
  });

  it('countTokensRequest sends the text itself — no byte-derived numbers anywhere', () => {
    const request = lib.countTokensRequest('claude-opus-5', 'some text');
    expect(request).toEqual({
      model: 'claude-opus-5',
      messages: [{ role: 'user', content: 'some text' }],
    });
    expect(() => lib.countTokensRequest('', 'text')).toThrow(/model/);
  });
});

describe('tier 3 verdicts', () => {
  it('retrieving everything back is a loss; retrieving nothing is not', () => {
    expect(lib.tier3Verdict({ elisionsStored: 3, uniqueRetrieved: 3 })).toEqual({
      expansionRate: 1,
      loss: true,
    });
    expect(lib.tier3Verdict({ elisionsStored: 3, uniqueRetrieved: 1 })).toEqual({
      expansionRate: 1 / 3,
      loss: false,
    });
    expect(lib.tier3Verdict({ elisionsStored: 0, uniqueRetrieved: 0 })).toEqual({
      expansionRate: 0,
      loss: false,
    });
  });

  it('a log claiming more retrieved than stored is corrupt, not a data point', () => {
    expect(() => lib.tier3Verdict({ elisionsStored: 1, uniqueRetrieved: 2 })).toThrow(/corrupt/);
  });

  it('the aggregate is total retrieved over total stored', () => {
    expect(
      lib.tier3Aggregate([
        { elisionsStored: 3, uniqueRetrieved: 3 },
        { elisionsStored: 5, uniqueRetrieved: 1 },
      ]),
    ).toBe(0.5);
  });

  it('agrees with src/stats.ts — lib.mjs is import-free, so this pin is what stops the two copies of the formula drifting', () => {
    // tier3Verdict/tier3Aggregate re-derive the honesty arithmetic that
    // `retrieveStats` owns inside src/. If they drifted, the RESULTS.md tier-3
    // note and the committed tier3-log JSON for the same run would disagree.
    for (const counts of [
      { elisionsStored: 0, uniqueRetrieved: 0 },
      { elisionsStored: 3, uniqueRetrieved: 1 },
      { elisionsStored: 3, uniqueRetrieved: 3 },
    ]) {
      const derived = retrieveStats({
        ...counts,
        bytesStored: 0,
        retrieveCalls: counts.uniqueRetrieved,
        misses: 0,
      });
      const verdict = lib.tier3Verdict(counts);
      expect(verdict.expansionRate).toBe(derived.expansionRate);
      expect(verdict.loss).toBe(derived.allElisionsRetrieved);
      expect(lib.tier3Aggregate([counts])).toBe(derived.expansionRate);
    }
  });

  it('a truncated row says TRUNCATED and never claims a LOSS — the run was cut off, not measured', () => {
    const verdict = { expansionRate: 0.5, loss: false };
    expect(lib.tier3RowNote({ verdict, retrieveCalls: 4, truncated: false, maxRounds: 16 })).toBe(
      'expansion rate 0.50, 4 calls',
    );
    expect(
      lib.tier3RowNote({
        verdict: { expansionRate: 1, loss: true },
        retrieveCalls: 3,
        truncated: false,
        maxRounds: 16,
      }),
    ).toContain('LOSS');
    const truncatedNote = lib.tier3RowNote({
      verdict: { expansionRate: 1, loss: true },
      retrieveCalls: 3,
      truncated: true,
      maxRounds: 16,
    });
    expect(truncatedNote).toContain('TRUNCATED');
    expect(truncatedNote).toContain('16-round cap');
    expect(truncatedNote).not.toContain('LOSS');
  });
});

/** A stand-in smelter for tier-3 tests: one retrievable hash, library-shaped counters. */
function fakeSmelter(): unknown {
  return {
    tool: {
      name: 'smelt_retrieve',
      description: 'retrieve an elision',
      inputSchema: { type: 'object' },
      invoke: ({ hash }: { hash: string }) => `RESTORED:${hash}`,
    },
    stats: () => ({
      elisionsStored: 2,
      retrieveCalls: 1,
      uniqueRetrieved: 1,
      misses: 0,
      expansionRate: 0.5,
      allElisionsRetrieved: false,
    }),
  };
}

describe('the tier-3 retrieval log is the whole conversation', () => {
  interface Tier3Log {
    format: string;
    maxRounds: number;
    stopReasons: readonly string[];
    truncated: boolean;
    transcript: readonly { role: string; content: unknown }[];
    stats: Record<string, unknown>;
  }
  interface Tier3Module {
    measureExpansion(input: {
      model: string;
      benchCase: { id: string; task: string };
      smelter: unknown;
      smeltedText: string;
      transport: (payload: unknown) => Promise<unknown>;
    }): Promise<Tier3Log>;
  }

  let measureExpansion: Tier3Module['measureExpansion'];
  beforeAll(async () => {
    const tier3 = (await import(
      pathToFileURL(join(benchDir, 'tier3.mjs')).href
    )) as unknown as Tier3Module;
    measureExpansion = tier3.measureExpansion;
  });

  const toolUseResponse = {
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'call-1', name: 'smelt_retrieve', input: { hash: 'abc' } }],
  };
  const endTurnResponse = {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'done' }],
  };

  it('captures the prompt shown to the model, every tool_result payload, and the final answer', async () => {
    const responses = [toolUseResponse, endTurnResponse];
    const log = await measureExpansion({
      model: 'test-model',
      benchCase: { id: 'case-x', task: 'find the thing' },
      smelter: fakeSmelter(),
      smeltedText: 'THE SMELTED TEXT',
      transport: () => Promise.resolve(responses.shift()),
    });

    expect(log.truncated).toBe(false);
    expect(log.stopReasons).toEqual(['tool_use', 'end_turn']);
    // The initial user message — task and smelted text — is in the log verbatim.
    const [prompt] = log.transcript;
    expect(prompt?.role).toBe('user');
    expect(String(prompt?.content)).toContain('find the thing');
    expect(String(prompt?.content)).toContain('THE SMELTED TEXT');
    // The tool_result payload the harness sent back is in the log too.
    expect(JSON.stringify(log.transcript)).toContain('RESTORED:abc');
    // And the final assistant message closes the transcript.
    expect(log.transcript.at(-1)).toEqual({ role: 'assistant', content: endTurnResponse.content });
  });

  it('flags a run cut off at the round cap mid-task as truncated', async () => {
    const log = await measureExpansion({
      model: 'test-model',
      benchCase: { id: 'case-y', task: 'keep digging' },
      smelter: fakeSmelter(),
      smeltedText: 'S',
      transport: () => Promise.resolve(toolUseResponse),
    });

    expect(log.truncated).toBe(true);
    expect(log.stopReasons).toHaveLength(log.maxRounds);
    expect(log.stopReasons.at(-1)).toBe('tool_use');
    // Even the cut-off conversation is fully logged, tool results included.
    expect(log.transcript).toHaveLength(1 + 2 * log.maxRounds);
  });
});

describe('the harness stays out of the product', () => {
  it('package.json files excludes bench/', () => {
    const packageManifest = JSON.parse(
      readFileSync(resolve(testDir, '../package.json'), 'utf8'),
    ) as { files: readonly string[] };
    expect(
      packageManifest.files.some((entry) => entry === 'bench' || entry.startsWith('bench/')),
    ).toBe(false);
  });

  it('bench/ lives outside src/, so the zero-network walk never discovers it', () => {
    expect(existsSync(resolve(testDir, '../src/bench'))).toBe(false);
    expect(existsSync(join(benchDir, 'run.mjs'))).toBe(true);
  });
});
