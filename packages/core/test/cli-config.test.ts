import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONFIG_FILE_NAME, findConfigFile, parseConfig } from '../src/cli/config.ts';
import { EXIT, runCli } from '../src/cli/run.ts';
import type { CliIo } from '../src/cli/run.ts';

/**
 * `smelt.config.json` supplies DEFAULTS to the CLI, and nothing else. These tests pin
 * the three properties that matter: the nearest config is found by walking up,
 * explicit flags always beat it, and a malformed config is a loud usage error — never
 * silently ignored, not even when every flag was given. The programmatic API never
 * reads it at all.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'smelt-config-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Captured {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(argv: readonly string[], cwd: string, stdin = ''): Promise<Captured> {
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
    cwd,
  };
  const code = await runCli(argv, io);
  return { code, stdout, stderr };
}

function writeConfig(at: string, config: unknown): void {
  writeFileSync(join(at, CONFIG_FILE_NAME), `${JSON.stringify(config, null, 2)}\n`);
}

/** Big enough to force elisions at a small budget. */
function corpus(): string {
  const lines = Array.from(
    { length: 240 },
    (_, i) => `line ${String(i)} some padding text to make this worth collapsing`,
  );
  lines[120] = 'function handleRequest(req, res) { /* the one we care about */ }';
  return `${lines.join('\n')}\n`;
}

describe('the config supplies defaults', () => {
  it('defaultBudgetBytes makes --budget optional', async () => {
    writeConfig(dir, { smeltConfig: 1, defaultBudgetBytes: 4000 });
    const { code, stderr } = await run(['--focus', 'handleRequest'], dir, corpus());
    expect(code).toBe(EXIT.ok);
    expect(stderr).not.toContain('OVER BUDGET');
  });

  it('is found by walking up from the cwd, like package.json', async () => {
    writeConfig(dir, { smeltConfig: 1, defaultBudgetBytes: 4000 });
    const nested = join(dir, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    expect(findConfigFile(nested)).toBe(join(dir, CONFIG_FILE_NAME));
    const { code } = await run([], nested, corpus());
    expect(code).toBe(EXIT.ok);
  });

  it('strategy comes from the config when the flag is absent', async () => {
    // Structural refuses stdin with no detectable language, so a refusal exit proves
    // the config's strategy was actually in force.
    writeConfig(dir, { smeltConfig: 1, defaultBudgetBytes: 4000, strategy: 'structural' });
    const { code, stderr } = await run([], dir, corpus());
    expect(code).toBe(EXIT.refused);
    expect(stderr).toMatch(/GrammarUnavailableError/);
  });

  it('a directory store from the config persists elided bytes on disk', async () => {
    writeConfig(dir, {
      smeltConfig: 1,
      defaultBudgetBytes: 400,
      store: { kind: 'directory', path: 'elision-store' },
    });
    const { code } = await run(['--focus', 'handleRequest'], dir, corpus());
    expect(code).toBeLessThanOrEqual(EXIT.overBudget); // ok or over budget — both smelted
    // The store path resolves relative to the config file, and the blobs are real.
    expect(readdirSync(join(dir, 'elision-store', 'blobs')).length).toBeGreaterThan(0);
  });
});

describe('explicit flags always win', () => {
  it('--budget beats defaultBudgetBytes', async () => {
    // The config budget is unfittable; the flag budget fits. Exit codes tell them apart.
    writeConfig(dir, { smeltConfig: 1, defaultBudgetBytes: 120 });
    const viaConfig = await run(['--focus', 'handleRequest'], dir, corpus());
    expect(viaConfig.code).toBe(EXIT.overBudget);
    const viaFlag = await run(['--budget', '4000', '--focus', 'handleRequest'], dir, corpus());
    expect(viaFlag.code).toBe(EXIT.ok);
  });

  it('--strategy beats the config strategy', async () => {
    writeConfig(dir, { smeltConfig: 1, defaultBudgetBytes: 4000, strategy: 'structural' });
    const { code } = await run(['--strategy', 'lexical'], dir, corpus());
    expect(code).toBe(EXIT.ok);
  });
});

describe('a malformed config is a usage error, never silently ignored', () => {
  it('even when every flag was given explicitly', async () => {
    writeFileSync(join(dir, CONFIG_FILE_NAME), '{ this is not json');
    const { code, stderr } = await run(['--budget', '4000'], dir, corpus());
    expect(code).toBe(EXIT.usage);
    expect(stderr).toContain('malformed');
    expect(stderr).toContain(join(dir, CONFIG_FILE_NAME));
  });

  it('refuses an unknown schema version instead of half-reading it', async () => {
    writeConfig(dir, { smeltConfig: 2, defaultBudgetBytes: 4000 });
    const { code, stderr } = await run([], dir, corpus());
    expect(code).toBe(EXIT.usage);
    expect(stderr).toContain('version');
  });

  it('refuses unknown keys — a typo is not a setting', async () => {
    writeConfig(dir, { smeltConfig: 1, defaultBudgetByte: 4000 });
    const { code, stderr } = await run([], dir, corpus());
    expect(code).toBe(EXIT.usage);
    expect(stderr).toContain('defaultBudgetByte');
  });

  it('validates types and ranges like the flags do', () => {
    for (const bad of [
      { smeltConfig: 1, defaultBudgetBytes: 0 },
      { smeltConfig: 1, defaultBudgetBytes: 4.5 },
      { smeltConfig: 1, strategy: 'psychic' },
      { smeltConfig: 1, store: { kind: 'cloud' } },
      { smeltConfig: 1, store: { kind: 'directory' } },
      { smeltConfig: 1, store: { kind: 'memory', path: 'x' } },
    ]) {
      expect(() => parseConfig(JSON.stringify(bad), 'x.json'), JSON.stringify(bad)).toThrow();
    }
  });

  it('no config at all is fine — flags alone are a complete interface', async () => {
    const { code } = await run(['--budget', '4000'], dir, corpus());
    expect(code).toBe(EXIT.ok);
  });

  it('still requires a budget when neither flag nor config has one, naming both fixes', async () => {
    const { code, stderr } = await run([], dir, corpus());
    expect(code).toBe(EXIT.usage);
    expect(stderr).toMatch(/--budget is required/);
    expect(stderr).toContain('defaultBudgetBytes');
    expect(stderr).toContain('smelt init');
  });
});
