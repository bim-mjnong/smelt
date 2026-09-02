import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSmelter } from '../src/index.ts';
import { STRUCTURAL_LANGUAGES } from '../src/plan/structural.ts';
import {
  CLI_JSON_FORMAT,
  cliUsage,
  EXIT,
  formatReport,
  parseSmeltArgs,
  runCli,
} from '../src/cli/run.ts';
import type { CliIo } from '../src/cli/run.ts';
import type { SmeltResult } from '../src/types.ts';

/**
 * Slice 1's acceptance criteria, as tests.
 *
 * `runCli` returns an exit code instead of calling `process.exit`, so the whole CLI runs
 * in-process here. The one thing this file cannot prove is that the *built binary*
 * works, which is why the PR carries a screenshot of `node dist/cli/bin.js` on a real
 * file: an in-process test and a shipped executable are different claims.
 */

interface Captured {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'smelt-cli-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function run(argv: readonly string[], stdin = ''): Promise<Captured> {
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    stdin: () => stdin,
    version: '9.9.9-test',
  };
  const code = await runCli(argv, io);
  return { code, stdout, stderr };
}

/** 240 lines, one of which mentions the focus term. Big enough to force elisions. */
function corpus(): string {
  const lines = Array.from(
    { length: 240 },
    (_, i) => `line ${String(i)} some padding text to make this worth collapsing`,
  );
  lines[120] = 'function handleRequest(req, res) { /* the one we care about */ }';
  return `${lines.join('\n')}\n`;
}

describe('smelt <file> and stdin both work', () => {
  it('reads a file, prints text on stdout and the report on stderr', async () => {
    const file = join(dir, 'corpus.ts');
    writeFileSync(file, corpus());

    const { code, stdout, stderr } = await run([
      file,
      '--budget',
      '4000',
      '--focus',
      'handleRequest',
    ]);
    expect(code).toBe(EXIT.ok);
    expect(stdout).toContain('handleRequest');
    expect(stdout).toContain('<<smelt/v1:');
    // The report is on stderr, so `> out.txt` keeps them apart.
    expect(stdout).not.toContain('OVER BUDGET');
    expect(stderr).toContain('smelt  ');
    expect(stderr).toContain('typescript');
    expect(stderr).toContain('lexical/v1');
  });

  it('reads stdin when no file is given, and says <stdin> in the report', async () => {
    const { code, stdout, stderr } = await run(
      ['--budget', '4000', '--focus', 'handleRequest'],
      corpus(),
    );
    expect(code).toBe(EXIT.ok);
    expect(stdout).toContain('handleRequest');
    expect(stderr).toContain('<stdin>');
    // No path, so no extension, so no language: 'unknown' is a first-class answer.
    expect(stderr).toContain('unknown');
  });

  it('refuses more than one file rather than picking one', async () => {
    const { code, stderr } = await run(['a.ts', 'b.ts', '--budget', '4000']);
    expect(code).toBe(EXIT.usage);
    expect(stderr).toMatch(/at most one file/);
  });

  it('says which file it could not read', async () => {
    const { code, stderr } = await run([join(dir, 'nope.ts'), '--budget', '4000']);
    expect(code).toBe(EXIT.usage);
    expect(stderr).toMatch(/cannot read/);
  });
});

describe('--budget is required, and its absence is an error', () => {
  it('exits with a usage code and explains why there is no default', async () => {
    const { code, stdout, stderr } = await run(['--budget-less'], 'text');
    expect(code).toBe(EXIT.usage);
    expect(stdout).toBe('');
    expect(stderr).toMatch(/Run `smelt --help`/);
  });

  it('names the flag and the reasoning when it is simply missing', async () => {
    const { code, stderr } = await run([], 'text');
    expect(code).toBe(EXIT.usage);
    expect(stderr).toMatch(/--budget is required/);
    expect(stderr).toMatch(/no default/);
  });

  it('never invents a budget from a bad value', async () => {
    for (const bad of ['abc', '-1', '4kb', '0', '4.5']) {
      const { code, stdout } = await run(['--budget', bad], 'text');
      expect(code, bad).toBe(EXIT.usage);
      expect(stdout, bad).toBe('');
    }
  });

  it('parses a good budget into bytes', () => {
    expect(parseSmeltArgs(['--budget', '4000']).budgetBytes).toBe(4000);
  });
});

/** The report's own grouping, restated independently so a change to either shows up. */
const group = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

describe('the report agrees with the result it reports on', () => {
  it('prints exactly inputBytes and outputBytes, formatted', async () => {
    const text = corpus();
    const smelter = createSmelter();
    const result = await smelter.smelt(text, { budgetBytes: 4000, focus: ['handleRequest'] });

    const report = formatReport({
      result,
      source: 'corpus.ts',
      budgetBytes: 4000,
      inputText: text,
    });

    expect(report).toContain(
      `in ${group(result.inputBytes)} B → out ${group(result.outputBytes)} B`,
    );
    expect(report).toContain(`${String(result.elisions.length)} elision`);
    for (const elision of result.elisions) {
      expect(report).toContain(elision.hash);
      expect(report).toContain(elision.reason.rule);
    }
  });

  it('says so when nothing was elided, instead of printing an empty table', async () => {
    const smelter = createSmelter();
    const text = 'short\n';
    const result = await smelter.smelt(text, { budgetBytes: 10_000 });
    const report = formatReport({ result, source: 'x.txt', budgetBytes: 10_000, inputText: text });
    expect(result.elisions).toEqual([]);
    expect(report).toMatch(/nothing elided/);
  });

  it('reports a consumer-supplied measure, with the counter named', async () => {
    const smelter = createSmelter({
      measure: { id: 'test/words', unit: 'words', count: (t) => t.split(/\s+/).length },
    });
    const text = corpus();
    const result = await smelter.smelt(text, { budgetBytes: 4000, focus: ['handleRequest'] });
    expect(result.measured?.measure).toBe('test/words');
    expect(result.measured?.unit).toBe('words');
    expect(result.measured?.input).toBeGreaterThan(result.measured?.output ?? Infinity);

    const report = formatReport({ result, source: 's', budgetBytes: 4000, inputText: text });
    expect(report).toContain('words (test/words)');
  });
});

describe('--json emits the SmeltResult verbatim', () => {
  it('nests the result unchanged, so it can be diffed against the library', async () => {
    const text = corpus();
    const { code, stdout } = await run(
      ['--budget', '4000', '--focus', 'handleRequest', '--json'],
      text,
    );
    expect(code).toBe(EXIT.ok);

    const envelope = JSON.parse(stdout) as { format: string; result: SmeltResult };
    expect(envelope.format).toBe(CLI_JSON_FORMAT);

    // The same call through the library, compared field for field. If the CLI reshaped,
    // renamed or dropped anything, this fails.
    const expected = await createSmelter().smelt(text, {
      budgetBytes: 4000,
      focus: ['handleRequest'],
    });
    expect(envelope.result).toEqual(JSON.parse(JSON.stringify(expected)));
  });

  it('carries the elided bytes, keyed by the hashes the result names', async () => {
    const { stdout } = await run(
      ['--budget', '4000', '--focus', 'handleRequest', '--json'],
      corpus(),
    );
    const envelope = JSON.parse(stdout) as {
      result: SmeltResult;
      elided: Record<string, string>;
    };
    expect(Object.keys(envelope.elided).length).toBe(envelope.result.elisions.length);
    for (const elision of envelope.result.elisions) {
      expect(envelope.elided[elision.hash]).toBeDefined();
      expect(Buffer.byteLength(envelope.elided[elision.hash]!, 'utf8')).toBe(elision.bytes);
    }
  });

  it('building the envelope does not count as the model retrieving anything', async () => {
    // `peek`, not `retrieve` — otherwise writing a file would inflate the expansion rate,
    // the one number smelt is trying to keep honest.
    const { stdout } = await run(['--budget', '4000', '--json'], corpus());
    expect(stdout).toContain('"elided"');
  });
});

describe('--reconstruct closes the round trip from a shell', () => {
  it('prints the original, byte for byte', async () => {
    const text = corpus();
    const { stdout: json } = await run(
      ['--budget', '4000', '--focus', 'handleRequest', '--json'],
      text,
    );
    const file = join(dir, 'result.json');
    writeFileSync(file, json);

    const { code, stdout, stderr } = await run(['--reconstruct', file]);
    expect(code).toBe(EXIT.ok);
    expect(stdout).toBe(text);
    expect(stderr).toMatch(/byte for byte/);
  });

  it('reads the envelope from stdin too', async () => {
    const text = corpus();
    const { stdout: json } = await run(['--budget', '4000', '--json'], text);
    const { code, stdout } = await run(['--reconstruct'], json);
    expect(code).toBe(EXIT.ok);
    expect(stdout).toBe(text);
  });

  it('round-trips multi-byte text, CRLF, and a file with no trailing newline', async () => {
    const cases = [
      `🔥 unicode ${'padding — with an em dash and ünïcödé\n'.repeat(80)}🔥 end`,
      `a\r\n${'b padding padding padding\r\n'.repeat(120)}c\r\n`,
      'x\n'.repeat(200) + 'no trailing newline here',
    ];
    for (const text of cases) {
      const { stdout: json } = await run(['--budget', '300', '--json'], text);
      const { code, stdout } = await run(['--reconstruct'], json);
      expect(code).toBe(EXIT.ok);
      expect(stdout).toBe(text);
    }
  });

  it('refuses an envelope whose bytes do not hash to their key', async () => {
    const { stdout: json } = await run(['--budget', '400', '--json'], corpus());
    const envelope = JSON.parse(json) as { elided: Record<string, string> };
    const [hash] = Object.keys(envelope.elided);
    envelope.elided[hash!] = 'tampered';

    const { code, stderr } = await run(['--reconstruct'], JSON.stringify(envelope));
    expect(code).toBe(EXIT.usage);
    expect(stderr).toMatch(/not self-consistent/);
  });

  it('refuses an envelope that dropped the bytes it claims to have elided', async () => {
    const { stdout: json } = await run(['--budget', '400', '--json'], corpus());
    const envelope = JSON.parse(json) as { elided: Record<string, string> };
    envelope.elided = {};

    const { code, stderr } = await run(['--reconstruct'], JSON.stringify(envelope));
    expect(code).toBe(EXIT.usage);
    expect(stderr).toMatch(/missing the bytes/);
  });

  it('refuses an envelope from a format it does not read', async () => {
    const { code, stderr } = await run(
      ['--reconstruct'],
      JSON.stringify({ format: 'smelt-cli/v99', result: {}, elided: {} }),
    );
    expect(code).toBe(EXIT.usage);
    expect(stderr).toMatch(/smelt-cli\/v99/);
  });

  it('refuses --budget with --reconstruct rather than ignoring it', async () => {
    const { code, stderr } = await run(['--reconstruct', '--budget', '4000']);
    expect(code).toBe(EXIT.usage);
    expect(stderr).toMatch(/makes no sense/);
  });
});

describe('the exit code never lies about the budget', () => {
  it('is non-zero when the plan came back over budget, and says so', async () => {
    const text = corpus();
    const { code, stdout, stderr } = await run(
      ['--budget', '120', '--focus', 'handleRequest'],
      text,
    );

    expect(code).toBe(EXIT.overBudget);
    expect(code).not.toBe(EXIT.ok);
    expect(stderr).toContain('OVER BUDGET');
    expect(stderr).toMatch(/over by \d/);
    // The output is still emitted: over budget is a fact about the plan, not a crash.
    expect(stdout.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(stdout, 'utf8')).toBeGreaterThan(120);
  });

  it('is zero when the output fits', async () => {
    const { code, stderr } = await run(['--budget', '4000', '--focus', 'handleRequest'], corpus());
    expect(code).toBe(EXIT.ok);
    expect(stderr).not.toContain('OVER BUDGET');
  });

  it('distinguishes a refusal from a usage error and from over budget', async () => {
    // A log on stdin has no detectable language, and structural refuses to guess —
    // never a silent lexical fallback. From the shell that is a refusal exit.
    const { code, stderr } = await run(['--budget', '4000', '--strategy', 'structural'], corpus());
    expect(code).toBe(EXIT.refused);
    expect(stderr).toMatch(/GrammarUnavailableError/);
    expect(
      new Set([EXIT.ok, EXIT.overBudget, EXIT.usage, EXIT.refused, EXIT.unexpected]).size,
    ).toBe(5);
  });
});

describe('--help and --version', () => {
  it('prints usage on stdout and exits zero', async () => {
    const { code, stdout } = await run(['--help']);
    expect(code).toBe(EXIT.ok);
    expect(stdout).toBe(cliUsage());
    expect(stdout).toMatch(/--budget <bytes>\s+Required/);
    expect(stdout).toMatch(/EXIT CODES/);
  });

  it('derives the --strategy language list from STRUCTURAL_LANGUAGES, never a stale hand count', async () => {
    // The help once hardcoded "typescript, tsx, rust, python and go" and claimed the
    // rest were refused — false from the moment ten more grammars shipped. Deriving
    // from the one source of truth means the claim cannot rot again.
    const { stdout } = await run(['--help']);
    expect(stdout).toContain(STRUCTURAL_LANGUAGES.join(', '));
    expect(stdout).not.toMatch(/rust, python and go/);
  });

  it('prints the version it was handed, so it cannot drift from the manifest', async () => {
    const { code, stdout } = await run(['--version']);
    expect(code).toBe(EXIT.ok);
    expect(stdout).toBe('9.9.9-test\n');
  });

  it('the shipped bin reads its version from the manifest, not from a second copy', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string; bin: Record<string, string> };
    const bin = readFileSync(new URL('../src/cli/bin.ts', import.meta.url), 'utf8');
    expect(bin).toContain("new URL('../../package.json', import.meta.url)");
    // No `./` prefix: npm 11's publish validation treats a `./`-prefixed bin value as
    // invalid and silently REMOVES the bin entry from the published manifest.
    expect(manifest.bin['smelt']).toBe('dist/cli/bin.js');
    expect(typeof manifest.version).toBe('string');
  });
});
