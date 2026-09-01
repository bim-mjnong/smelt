import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CliUsageError } from '../src/errors.ts';
import { CONFIG_FILE_NAME, findConfigFile } from '../src/cli/config.ts';
import type { SmeltConfig } from '../src/cli/config.ts';
import { MEASURE_STUB_FILE, RERANK_STUB_FILE, runInit } from '../src/cli/init.ts';
import { EXIT, runCli } from '../src/cli/run.ts';
import type { CliIo } from '../src/cli/run.ts';

/**
 * The `smelt init` wizard, driven entirely in-process: the wizard is a pure function
 * over an input/output pair, so every flow here scripts the answers up front and
 * asserts on the files (and the transcript) afterwards. No terminal, no child process.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'smelt-init-'));
  // Discovery walks UP from `dir` to the filesystem root, so a stray
  // smelt.config.json in the temp tree (or above it) would flip every fresh-run
  // test into an edit run. Fail loudly here instead of mysteriously below.
  expect(findConfigFile(dir), 'ancestor smelt.config.json would break these tests').toBeUndefined();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface WizardRun {
  readonly code: number;
  readonly output: string;
}

async function wizard(answers: readonly string[], cwd = dir): Promise<WizardRun> {
  let output = '';
  const code = await runInit({
    input: Readable.from([`${answers.join('\n')}\n`]),
    output: (text) => {
      output += text;
    },
    cwd,
  });
  return { code, output };
}

function readConfig(at = dir): SmeltConfig {
  return JSON.parse(readFileSync(join(at, CONFIG_FILE_NAME), 'utf8')) as SmeltConfig;
}

/** budget, store=memory, strategy=lexical, no stubs, confirm yes. */
const MINIMAL_ANSWERS = ['4000', '1', '1', '1', '1', 'yes'];

describe('a fresh run', () => {
  it('writes a versioned config from the answers, and nothing else', async () => {
    const { code, output } = await wizard(MINIMAL_ANSWERS);
    expect(code).toBe(EXIT.ok);
    expect(readConfig()).toEqual({
      smeltConfig: 1,
      defaultBudgetBytes: 4000,
      strategy: 'lexical',
      store: { kind: 'memory' },
    });
    expect(existsSync(join(dir, MEASURE_STUB_FILE))).toBe(false);
    expect(existsSync(join(dir, RERANK_STUB_FILE))).toBe(false);
    expect(output).toContain('wrote smelt.config.json');
  });

  it('generates both stubs when asked, next to the config', async () => {
    const { code } = await wizard(['8000', '2', '', '2', '2', '2', 'yes']);
    expect(code).toBe(EXIT.ok);
    expect(readConfig()).toEqual({
      smeltConfig: 1,
      defaultBudgetBytes: 8000,
      strategy: 'structural',
      store: { kind: 'directory', path: '.smelt/store' },
    });
    const measure = readFileSync(join(dir, MEASURE_STUB_FILE), 'utf8');
    const rerank = readFileSync(join(dir, RERANK_STUB_FILE), 'utf8');
    expect(measure).toContain('Measure');
    expect(rerank).toContain('RerankStage');
    // The outbound call is sketched in the CONSUMER'S file, reading the consumer's
    // own env var — never wired into smelt's own graph.
    expect(rerank).toContain('TODO');
    expect(rerank).toContain('RERANKER_API_KEY');
    expect(rerank).toContain('fetch(');
  });

  it('accepts back at every step, including the confirm, and lands on the final answers', async () => {
    const answers = [
      '1000', // budget
      'back', // store → back to budget
      '2000', // budget again
      '1', // store: memory
      'back', // strategy → back to store
      '2', // store: directory
      '', // path: default
      '2', // strategy: structural
      'back', // measure → back to strategy
      '1', // strategy: lexical after all
      '1', // measure: none
      'back', // rerank → back to measure
      '2', // measure: generate
      '1', // rerank: none
      'back', // confirm → back to rerank
      '2', // rerank: generate after all
      'yes', // confirm
      // no overwrite questions: nothing existed
    ];
    const { code } = await wizard(answers);
    expect(code).toBe(EXIT.ok);
    expect(readConfig()).toEqual({
      smeltConfig: 1,
      defaultBudgetBytes: 2000,
      strategy: 'lexical',
      store: { kind: 'directory', path: '.smelt/store' },
    });
    expect(existsSync(join(dir, MEASURE_STUB_FILE))).toBe(true);
    expect(existsSync(join(dir, RERANK_STUB_FILE))).toBe(true);
  });

  it('back at the first step stays at the first step instead of crashing', async () => {
    const { code, output } = await wizard(['back', ...MINIMAL_ANSWERS]);
    expect(code).toBe(EXIT.ok);
    expect(output).toContain('first step');
    expect(existsSync(join(dir, CONFIG_FILE_NAME))).toBe(true);
  });

  it('re-asks on an answer it does not understand, without advancing', async () => {
    const { code } = await wizard(['not-a-number', '-3', '4000', '7', '1', '1', '1', '1', 'yes']);
    expect(code).toBe(EXIT.ok);
    expect(readConfig().defaultBudgetBytes).toBe(4000);
  });

  it('writes NOTHING when the final confirm is declined', async () => {
    const { code, output } = await wizard(['4000', '1', '1', '2', '2', 'no']);
    expect(code).toBe(EXIT.ok);
    expect(output).toContain('Nothing was written');
    expect(existsSync(join(dir, CONFIG_FILE_NAME))).toBe(false);
    expect(existsSync(join(dir, MEASURE_STUB_FILE))).toBe(false);
    expect(existsSync(join(dir, RERANK_STUB_FILE))).toBe(false);
  });

  it('writes nothing before the confirm even when input ends mid-wizard', async () => {
    await expect(wizard(['4000', '1'])).rejects.toThrow(CliUsageError);
    expect(existsSync(join(dir, CONFIG_FILE_NAME))).toBe(false);
  });

  it('lists exactly what will be written before asking for the confirm', async () => {
    const { output } = await wizard(['4000', '1', '1', '2', '1', 'no']);
    const listing = output.slice(output.indexOf('About to write'));
    expect(listing).toContain(CONFIG_FILE_NAME);
    expect(listing).toContain(MEASURE_STUB_FILE);
    expect(listing).not.toContain(RERANK_STUB_FILE);
    expect(listing).toContain('Nothing has been written yet');
  });

  it('claims no unmeasured number anywhere in its copy (Law 4)', async () => {
    const { output } = await wizard(MINIMAL_ANSWERS);
    expect(output).not.toMatch(/\d+\s*%/);
    expect(output.toLowerCase()).not.toContain('hit rate');
    expect(output.toLowerCase()).not.toContain('sav');
  });
});

describe('a re-run over an existing config', () => {
  const existing: SmeltConfig = {
    smeltConfig: 1,
    defaultBudgetBytes: 4000,
    strategy: 'lexical',
    store: { kind: 'memory' },
  };

  beforeEach(() => {
    writeFileSync(join(dir, CONFIG_FILE_NAME), `${JSON.stringify(existing, null, 2)}\n`);
  });

  it('shows the current values and changes exactly one choice at a time', async () => {
    const { code, output } = await wizard([
      'strategy', // edit one setting…
      '2', // …to structural
      'done',
      'yes', // confirm
      'yes', // overwrite smelt.config.json
    ]);
    expect(code).toBe(EXIT.ok);
    expect(output).toContain('already exists');
    expect(output).toContain('budget:    4000 bytes');
    expect(output).toContain('strategy:  lexical'); // shown before the edit
    expect(readConfig()).toEqual({ ...existing, strategy: 'structural' });
  });

  it('never overwrites the existing config without an explicit per-file yes', async () => {
    const before = readFileSync(join(dir, CONFIG_FILE_NAME), 'utf8');
    const { code, output } = await wizard(['budget', '9999', 'done', 'yes', 'no']);
    expect(code).toBe(EXIT.ok);
    expect(output).toContain('overwrite');
    expect(output).toContain('skipped');
    expect(readFileSync(join(dir, CONFIG_FILE_NAME), 'utf8')).toBe(before);
  });

  it('back at the menu leaves without writing anything', async () => {
    const before = readFileSync(join(dir, CONFIG_FILE_NAME), 'utf8');
    const { code, output } = await wizard(['back']);
    expect(code).toBe(EXIT.ok);
    expect(output).toContain('Nothing has been written');
    expect(readFileSync(join(dir, CONFIG_FILE_NAME), 'utf8')).toBe(before);
  });

  it('does not rewrite an unchanged config, and says so', async () => {
    const before = readFileSync(join(dir, CONFIG_FILE_NAME), 'utf8');
    const { code, output } = await wizard(['done', 'yes']);
    expect(code).toBe(EXIT.ok);
    expect(output).toContain('unchanged');
    expect(readFileSync(join(dir, CONFIG_FILE_NAME), 'utf8')).toBe(before);
  });

  it('declining to overwrite an existing stub leaves it byte-for-byte intact', async () => {
    const sentinel = '// my hand-written reranker — do not touch\n';
    writeFileSync(join(dir, RERANK_STUB_FILE), sentinel);
    const { code, output } = await wizard([
      'rerank',
      '2', // generate the stub
      'done',
      'yes', // confirm (the config itself is unchanged, so no question for it)
      'no', // decline overwriting smelt.rerank.ts
    ]);
    expect(code).toBe(EXIT.ok);
    expect(output).toContain(`${RERANK_STUB_FILE} exists`);
    expect(readFileSync(join(dir, RERANK_STUB_FILE), 'utf8')).toBe(sentinel);
  });

  it('refuses a malformed existing config loudly instead of overwriting it', async () => {
    writeFileSync(join(dir, CONFIG_FILE_NAME), '{ not json');
    await expect(wizard(['4000'])).rejects.toThrow(/malformed/);
  });

  describe('over a valid config that never had a budget', () => {
    // `defaultBudgetBytes` is optional in the schema, so this config parses fine —
    // the forced budget prompt at the confirm is the only thing standing between
    // `done` and writing a budget-less config the wizard itself called incomplete.
    const budgetless = `${JSON.stringify({ smeltConfig: 1, strategy: 'lexical' }, null, 2)}\n`;

    beforeEach(() => {
      writeFileSync(join(dir, CONFIG_FILE_NAME), budgetless);
    });

    it('back at the forced budget prompt returns to the menu instead of falling into the confirm', async () => {
      const { code, output } = await wizard([
        'done', // review → forced budget prompt (no budget set)
        'back', // back out of it → the menu, NOT the confirm
        'back', // leave the menu without writing
      ]);
      expect(code).toBe(EXIT.ok);
      expect(output).toContain('No budget is set yet');
      expect(output).not.toContain('About to write'); // never reached the confirm
      expect(readFileSync(join(dir, CONFIG_FILE_NAME), 'utf8')).toBe(budgetless);
    });

    it('a budget answered at the forced prompt lands in the written config', async () => {
      const { code } = await wizard([
        'done', // review → forced budget prompt
        '5000', // set one
        'yes', // confirm
        'yes', // overwrite smelt.config.json
      ]);
      expect(code).toBe(EXIT.ok);
      expect(readConfig().defaultBudgetBytes).toBe(5000);
    });
  });
});

describe('smelt init through the CLI', () => {
  it('runs the wizard from runCli, against io.cwd', async () => {
    let stdout = '';
    const io: CliIo = {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => undefined,
      stdin: () => '',
      version: '9.9.9-test',
      cwd: dir,
      initInput: Readable.from([`${MINIMAL_ANSWERS.join('\n')}\n`]),
    };
    const code = await runCli(['init'], io);
    expect(code).toBe(EXIT.ok);
    expect(stdout).toContain('wrote smelt.config.json');
    expect(readConfig()).toMatchObject({ smeltConfig: 1, defaultBudgetBytes: 4000 });
  });

  it('is a usage error when no interactive input is wired', async () => {
    let stderr = '';
    const code = await runCli(['init'], {
      stdout: () => undefined,
      stderr: (text) => {
        stderr += text;
      },
      stdin: () => '',
      version: '9.9.9-test',
      cwd: dir,
    });
    expect(code).toBe(EXIT.usage);
    expect(stderr).toContain('interactive');
  });

  it('refuses flags: init asks, it does not parse', async () => {
    let stderr = '';
    const code = await runCli(['init', '--budget', '4000'], {
      stdout: () => undefined,
      stderr: (text) => {
        stderr += text;
      },
      stdin: () => '',
      version: '9.9.9-test',
      cwd: dir,
    });
    expect(code).toBe(EXIT.usage);
    expect(stderr).toContain('no flags');
  });
});
