import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  decide,
  DEFAULT_GUARD_SETTINGS,
  DEFAULT_SUGGESTION_BUDGET_BYTES,
  DEFAULT_THRESHOLD_BYTES,
  parseGuardRequest,
  readGuardSettings,
  searchPattern,
  shellQuote,
  simpleCommandWords,
} from '../src/hooks/guard-core.ts';
import type { GuardSettings } from '../src/hooks/guard-core.ts';
import { parseConfig } from '../src/cli/config.ts';
import { renderConfigWithHooks } from '../src/cli/hooks.ts';
import { packageRoot } from './guards/_source.ts';

/**
 * The guard core, unit by unit: threshold, windows, suggestion rendering, config
 * override, and — end to end against the built script — the fail-open contract:
 * malformed stdin allows with a warning on stderr, never a non-zero exit. A guard
 * that can brick a session is worse than no guard.
 */

/** A stat stub: the two fixture paths every test in this file speaks about. */
const stat = (path: string): { size: number; isFile: boolean } | undefined => {
  if (path === '/repo/big.ts') return { size: 20_000, isFile: true };
  if (path === '/repo/small.ts') return { size: 10, isFile: true };
  if (path === '/repo/exactly.ts') return { size: DEFAULT_THRESHOLD_BYTES, isFile: true };
  if (path === '/repo/a dir') return { size: 999_999, isFile: false };
  if (path === '/repo/with space.log') return { size: 999_999, isFile: true };
  return undefined;
};

const SETTINGS: GuardSettings = DEFAULT_GUARD_SETTINGS;
const REWRITE: GuardSettings = { ...DEFAULT_GUARD_SETTINGS, enforcement: 'rewrite' };

describe('the Read guard', () => {
  it('allows at the threshold and denies just above it — the threshold is a boundary, not a vibe', () => {
    expect(
      decide({ tool: 'Read', input: { path: '/repo/exactly.ts' } }, SETTINGS, '/repo', stat).action,
    ).toBe('allow');
    expect(
      decide({ tool: 'Read', input: { path: '/repo/big.ts' } }, SETTINGS, '/repo', stat).action,
    ).toBe('deny');
    expect(
      decide({ tool: 'Read', input: { path: '/repo/small.ts' } }, SETTINGS, '/repo', stat).action,
    ).toBe('allow');
  });

  it('always allows a windowed read — offset/limit of a huge file is an economy move', () => {
    const decision = decide(
      { tool: 'Read', input: { path: '/repo/big.ts', offsetLimited: true } },
      SETTINGS,
      '/repo',
      stat,
    );
    expect(decision).toEqual({ action: 'allow' });
  });

  it('fails open on anything it cannot stat: missing files, directories, unknown tools', () => {
    expect(
      decide({ tool: 'Read', input: { path: '/repo/nope.ts' } }, SETTINGS, '/repo', stat).action,
    ).toBe('allow');
    expect(
      decide({ tool: 'Read', input: { path: '/repo/a dir' } }, SETTINGS, '/repo', stat).action,
    ).toBe('allow');
    expect(decide({ tool: 'Glob', input: {} }, SETTINGS, '/repo', stat).action).toBe('allow');
    expect(decide({ tool: 'Read', input: {} }, SETTINGS, '/repo', stat).action).toBe('allow');
  });

  it('resolves a relative path against the cwd before statting', () => {
    expect(
      decide({ tool: 'Read', input: { path: 'big.ts' } }, SETTINGS, '/repo', stat).action,
    ).toBe('deny');
  });

  it('renders the deny to steer: the exact command with the file path and budget, and smelt retrieve', () => {
    const decision = decide(
      { tool: 'Read', input: { path: '/repo/big.ts' } },
      SETTINGS,
      '/repo',
      stat,
    );
    expect(decision.action).toBe('deny');
    expect(decision.reason).toContain('/repo/big.ts is 20000 bytes');
    expect(decision.reason).toContain(`${String(DEFAULT_THRESHOLD_BYTES)}-byte`);
    expect(decision.reason).toContain(
      `smelt /repo/big.ts --budget ${String(DEFAULT_SUGGESTION_BUDGET_BYTES)}`,
    );
    expect(decision.reason).toContain('smelt retrieve <hash>');
    expect(decision.suggestion).toBe(
      `smelt /repo/big.ts --budget ${String(DEFAULT_SUGGESTION_BUDGET_BYTES)}`,
    );
  });

  it('shell-quotes a path with spaces in the suggestion, so the command runs as printed', () => {
    const decision = decide(
      { tool: 'Read', input: { path: '/repo/with space.log' } },
      SETTINGS,
      '/repo',
      stat,
    );
    expect(decision.suggestion).toBe(`smelt '/repo/with space.log' --budget 8000`);
  });
});

describe('the Bash guard', () => {
  it('denies a simple cat of an oversized file, with the faithful replacement as suggestion', () => {
    const decision = decide(
      { tool: 'Bash', input: { command: 'cat /repo/big.ts' } },
      SETTINGS,
      '/repo',
      stat,
    );
    expect(decision.action).toBe('deny');
    expect(decision.suggestion).toBe('smelt /repo/big.ts --budget 8000');
  });

  it('multi-file cat with an oversized member denies with a reason but NO suggestion — a substitute would drop the other file', () => {
    const decision = decide(
      { tool: 'Bash', input: { command: 'cat /repo/small.ts /repo/big.ts' } },
      SETTINGS,
      '/repo',
      stat,
    );
    expect(decision.action).toBe('deny');
    expect(decision.suggestion).toBeUndefined();
  });

  it('passes anything it cannot judge whole: pipelines, redirects, substitutions, small cats', () => {
    for (const command of [
      'cat /repo/big.ts | head -5',
      'cat /repo/big.ts > /tmp/x',
      'cat $(ls)',
      'cat `ls`',
      'cat /repo/small.ts',
      'cat /repo/*.ts',
      'grep -rn pattern src && echo done',
    ]) {
      expect(
        decide({ tool: 'Bash', input: { command } }, SETTINGS, '/repo', stat),
        command,
      ).toEqual({ action: 'allow' });
    }
  });

  it('never intercepts a command that already uses smelt — including the exact replacement it just suggested', () => {
    for (const command of [
      'smelt /repo/big.ts --budget 8000',
      'grep -rn x src | smelt --budget 8000 --focus x',
      'smelt retrieve 84998967370f38bc',
    ]) {
      expect(decide({ tool: 'Bash', input: { command } }, REWRITE, '/repo', stat), command).toEqual(
        { action: 'allow' },
      );
    }
  });

  it('grep passes in deny mode — output size is unknowable pre-run, and denying would fight the agent', () => {
    expect(
      decide({ tool: 'Bash', input: { command: 'grep -rn pattern src' } }, SETTINGS, '/repo', stat),
    ).toEqual({ action: 'allow' });
  });

  it('rewrite mode wraps grep/rg with the focus derived from the pattern, shell-quoted', () => {
    const decision = decide(
      { tool: 'Bash', input: { command: 'grep -rn handleRequest src' } },
      REWRITE,
      '/repo',
      stat,
    );
    expect(decision.action).toBe('deny');
    expect(decision.suggestion).toBe(
      'grep -rn handleRequest src | smelt --budget 8000 --focus handleRequest',
    );

    const quoted = decide(
      { tool: 'Bash', input: { command: "rg -e 'foo bar' src" } },
      REWRITE,
      '/repo',
      stat,
    );
    expect(quoted.suggestion).toBe("rg -e 'foo bar' src | smelt --budget 8000 --focus 'foo bar'");
  });
});

describe('command parsing helpers', () => {
  it('simpleCommandWords honors quotes and refuses shell machinery', () => {
    expect(simpleCommandWords(`cat 'a file.ts' next`)).toEqual(['cat', 'a file.ts', 'next']);
    expect(simpleCommandWords('a | b')).toBeUndefined();
    expect(simpleCommandWords('a "un$safe"')).toBeUndefined();
    expect(simpleCommandWords("a 'unterminated")).toBeUndefined();
  });

  it('searchPattern finds the pattern through flags, -e, and --', () => {
    expect(searchPattern(['grep', '-rn', 'pat', 'src'])).toBe('pat');
    expect(searchPattern(['grep', '-e', 'pat', 'src'])).toBe('pat');
    expect(searchPattern(['rg', '--type', 'ts', 'pat'])).toBe('pat');
    expect(searchPattern(['grep', '--', '-literal'])).toBe('-literal');
    expect(searchPattern(['grep', '-r'])).toBeUndefined();
  });

  it('shellQuote leaves safe strings bare and single-quotes the rest', () => {
    expect(shellQuote('src/plan.ts')).toBe('src/plan.ts');
    expect(shellQuote('a b')).toBe(`'a b'`);
    expect(shellQuote(`it's`)).toBe(`'it'"'"'s'`);
  });
});

const stat150 = (): { size: number; isFile: boolean } => ({ size: 150, isFile: true });

describe('config: the guard reads smelt.config.json tolerantly, and agrees with the CLI parser', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'smelt-guard-config-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('no config: the defaults, and they are the documented ones', () => {
    expect(readGuardSettings(dir, () => {})).toEqual({
      thresholdBytes: 8192,
      enforcement: 'deny',
      budgetBytes: 8000,
    });
  });

  it('a config override changes the decision — the threshold is wired to the config, not a constant', () => {
    writeFileSync(
      join(dir, 'smelt.config.json'),
      `${JSON.stringify({ smeltConfig: 1, defaultBudgetBytes: 4000, hooks: { thresholdBytes: 100, enforcement: 'rewrite' } })}\n`,
    );
    const settings = readGuardSettings(dir, () => {});
    expect(settings).toEqual({ thresholdBytes: 100, enforcement: 'rewrite', budgetBytes: 4000 });

    const decision = decide(
      { tool: 'Read', input: { path: '/repo/x.ts' } },
      settings,
      '/repo',
      stat150,
    );
    expect(decision.action).toBe('deny');
    expect(decision.suggestion).toBe('smelt /repo/x.ts --budget 4000');
    expect(
      decide(
        { tool: 'Read', input: { path: '/repo/x.ts' } },
        DEFAULT_GUARD_SETTINGS,
        '/repo',
        stat150,
      ).action,
    ).toBe('allow');
  });

  it('fails open on a malformed config, warning instead of refusing — the CLI refuses, a session guard must not', () => {
    writeFileSync(join(dir, 'smelt.config.json'), 'not json at all');
    const warnings: string[] = [];
    expect(readGuardSettings(dir, (text) => warnings.push(text))).toEqual(DEFAULT_GUARD_SETTINGS);
    expect(warnings.join('\n')).toContain('not readable JSON');

    writeFileSync(
      join(dir, 'smelt.config.json'),
      `${JSON.stringify({ smeltConfig: 1, hooks: { thresholdBytes: 'huge', enforcement: 'shout' } })}\n`,
    );
    const warned: string[] = [];
    expect(readGuardSettings(dir, (text) => warned.push(text))).toEqual(DEFAULT_GUARD_SETTINGS);
    expect(warned.join('\n')).toContain('hooks.thresholdBytes');
    expect(warned.join('\n')).toContain('hooks.enforcement');
  });

  it('pins the guard reader and the strict CLI parser to the same keys and values (no drift)', () => {
    // What the installer writes, the strict parser accepts, and the guard reads —
    // one config, three readers, identical facts.
    const rendered = renderConfigWithHooks(
      { smeltConfig: 1, defaultBudgetBytes: 4000 },
      { thresholdBytes: 12_345, enforcement: 'rewrite' },
    );
    writeFileSync(join(dir, 'smelt.config.json'), rendered);

    const strict = parseConfig(rendered, join(dir, 'smelt.config.json'));
    expect(strict.hooks).toEqual({ thresholdBytes: 12_345, enforcement: 'rewrite' });

    const guard = readGuardSettings(dir, () => {});
    expect(guard).toEqual({ thresholdBytes: 12_345, enforcement: 'rewrite', budgetBytes: 4000 });
  });
});

describe('parseGuardRequest', () => {
  it('accepts the documented shape and refuses everything else as undefined', () => {
    expect(parseGuardRequest('{"tool":"Read","input":{"path":"/a"}}')).toEqual({
      tool: 'Read',
      input: { path: '/a' },
    });
    expect(parseGuardRequest('nope')).toBeUndefined();
    expect(parseGuardRequest('[]')).toBeUndefined();
    expect(parseGuardRequest('{"tool":1,"input":{}}')).toBeUndefined();
    expect(parseGuardRequest('{"tool":"Read"}')).toBeUndefined();
    expect(parseGuardRequest('{"tool":"Read","input":{"path":5}}')).toBeUndefined();
  });
});

describe('the built script (dist/hooks/guard-core.js) — the artifact the shims and harnesses run', () => {
  const script = join(packageRoot(), 'dist', 'hooks', 'guard-core.js');

  it('is built (pnpm verify builds before testing; run `pnpm build` if this fails)', () => {
    expect(existsSync(script)).toBe(true);
  });

  it('malformed stdin → allow with a warning on stderr and exit 0 — fail open, never brick a session', () => {
    const run = spawnSync(process.execPath, [script], { input: 'not json', encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ action: 'allow' });
    expect(run.stderr).toContain('allowing the call');
  });

  it('denies an oversized Read end to end, naming the replacement command', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smelt-guard-e2e-'));
    try {
      const big = join(dir, 'big.log');
      writeFileSync(big, 'x'.repeat(DEFAULT_THRESHOLD_BYTES + 1));
      const run = spawnSync(process.execPath, [script], {
        input: JSON.stringify({ tool: 'Read', input: { path: big } }),
        encoding: 'utf8',
        cwd: dir,
      });
      expect(run.status).toBe(0);
      const decision = JSON.parse(run.stdout) as { action: string; reason?: string };
      expect(decision.action).toBe('deny');
      expect(decision.reason).toContain(big);
      expect(decision.reason).toContain('smelt retrieve');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the allow fast path stays library-free: no planner, no grammar, no index import', () => {
    // The property behind the latency budget (research § 5): the always-on guard
    // imports node builtins only. Walk the *built* script's static imports.
    const run = spawnSync(
      process.execPath,
      [
        '-e',
        `const{readFileSync}=require('node:fs');const s=readFileSync(process.argv[1],'utf8');` +
          `const specs=[...s.matchAll(/from\\s*['"]([^'"]+)['"]/g)].map(m=>m[1]);` +
          `console.log(JSON.stringify(specs));`,
        script,
      ],
      { encoding: 'utf8' },
    );
    const specifiers = JSON.parse(run.stdout) as string[];
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier.startsWith('node:'), `guard-core imports "${specifier}"`).toBe(true);
    }
  });
});
