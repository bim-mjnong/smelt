import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { DEFAULT_GUARD_SETTINGS } from '../src/hooks/guard-core.ts';
import type { GuardSettings } from '../src/hooks/guard-core.ts';
import { renderShimDecision } from '../src/hooks/shim.ts';
import type { ShimAdapter } from '../src/hooks/shim.ts';
import { adapter as claudeCode } from '../src/hooks/shims/claude-code.ts';
import { adapter as codex } from '../src/hooks/shims/codex.ts';
import { adapter as gemini } from '../src/hooks/shims/gemini.ts';
import { adapter as grok } from '../src/hooks/shims/grok.ts';
import { adapter as hermes } from '../src/hooks/shims/hermes.ts';
import { adapter as cursor } from '../src/hooks/shims/cursor.ts';
import { adapter as cline } from '../src/hooks/shims/cline.ts';
import { packageRoot } from './guards/_source.ts';

/**
 * Schema-mapping tests, one recorded fixture file per harness
 * (`test/fixtures/hooks/<id>.json`). Each fixture cites the row of
 * docs/research/2026-09-02-harness-capability-matrix.md (or the § of the
 * enforcement research note) that its input shape was recorded from — so when a
 * harness moves its schema, the place to re-verify is one hop away.
 *
 * Every case runs through `renderShimDecision`, the exact function the shim
 * processes run, with a stat stub for the two paths the fixtures speak about.
 */

const stat = (path: string): { size: number; isFile: boolean } | undefined => {
  if (path === '/repo/big.ts') return { size: 20_000, isFile: true };
  if (path === '/repo/small.ts') return { size: 10, isFile: true };
  return undefined;
};

const DENY: GuardSettings = DEFAULT_GUARD_SETTINGS;
const REWRITE: GuardSettings = { ...DEFAULT_GUARD_SETTINGS, enforcement: 'rewrite' };

function fixture(id: string): Record<string, unknown> {
  const path = join(packageRoot(), 'test', 'fixtures', 'hooks', `${id}.json`);
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  expect(parsed['_cites'], `${id}.json must cite the matrix row it was recorded from`).toContain(
    'docs/research/2026-09-02',
  );
  return parsed;
}

function run(
  adapter: ShimAdapter,
  raw: unknown,
  settings: GuardSettings,
): { stdout: string; exitCode: number; json: unknown } {
  const output = renderShimDecision(adapter, raw, settings, '/repo', stat);
  return {
    ...output,
    json: output.stdout === '' ? undefined : (JSON.parse(output.stdout) as unknown),
  };
}

describe('claude-code shim (VERIFIED)', () => {
  const cases = fixture('claude-code');

  it('denies an oversized Read in the PreToolUse decision schema, reason to the model', () => {
    const { json, exitCode } = run(claudeCode, cases['readBig'], DENY);
    expect(exitCode).toBe(0);
    expect(json).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
      },
    });
    const reason = (json as { hookSpecificOutput: { permissionDecisionReason: string } })
      .hookSpecificOutput.permissionDecisionReason;
    expect(reason).toContain('smelt /repo/big.ts --budget 8000');
    expect(reason).toContain('smelt retrieve');
  });

  it('passes a windowed Read, a small Read, an un-guarded tool, and grep in deny mode', () => {
    for (const name of ['readWindowed', 'readSmall', 'otherTool', 'bashGrep']) {
      expect(run(claudeCode, cases[name], DENY), name).toEqual({
        stdout: '',
        exitCode: 0,
        json: undefined,
      });
    }
  });

  it('denies an oversized cat in deny mode — never a silent rewrite', () => {
    const { json } = run(claudeCode, cases['bashCatBig'], DENY);
    expect(json).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    expect(JSON.stringify(json)).not.toContain('updatedInput');
  });

  it('rewrite mode substitutes via updatedInput, replacing the whole input object and saying so', () => {
    const { json } = run(claudeCode, cases['bashCatBig'], REWRITE);
    expect(json).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: {
          command: 'smelt /repo/big.ts --budget 8000',
          // unchanged fields ride along — updatedInput replaces the entire object
          description: 'Read the big file',
        },
      },
    });
    const reason = (json as { hookSpecificOutput: { permissionDecisionReason: string } })
      .hookSpecificOutput.permissionDecisionReason;
    expect(reason).toContain('rewrote');
  });

  it('rewrite mode wraps grep with the focus derived from the pattern', () => {
    const { json } = run(claudeCode, cases['bashGrep'], REWRITE);
    expect(json).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'allow',
        updatedInput: {
          command: 'grep -rn handleRequest src | smelt --budget 8000 --focus handleRequest',
        },
      },
    });
  });

  it('rewrite mode still DENIES an oversized Read — updatedInput cannot turn a Read into a Bash call', () => {
    const { json } = run(claudeCode, cases['readBig'], REWRITE);
    expect(json).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  });
});

describe('codex shim (VERIFIED)', () => {
  const cases = fixture('codex');

  it('mirrors the Claude Code decision schema, and never emits the unsupported "ask"', () => {
    const { json } = run(codex, cases['readBig'], DENY);
    expect(json).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(JSON.stringify(json)).not.toContain('"ask"');
  });

  it('rewrites Bash with a string `command` in updatedInput, as Codex requires', () => {
    const { json } = run(codex, cases['bashCatBig'], REWRITE);
    const updated = (json as { hookSpecificOutput: { updatedInput: { command: unknown } } })
      .hookSpecificOutput.updatedInput;
    expect(typeof updated.command).toBe('string');
    expect(updated.command).toBe('smelt /repo/big.ts --budget 8000');
  });

  it('maps the `shell` tool spelling too, and passes a small grep through', () => {
    expect(run(codex, cases['shellGrep'], DENY)).toEqual({
      stdout: '',
      exitCode: 0,
      json: undefined,
    });
  });
});

describe('gemini shim (EXPERIMENTAL)', () => {
  const cases = fixture('gemini');

  it('denies with the BeforeTool {"decision":"deny"} shape', () => {
    const { json } = run(gemini, cases['readBig'], DENY);
    expect(json).toMatchObject({ decision: 'deny' });
    expect((json as { reason: string }).reason).toContain('smelt /repo/big.ts');
  });

  it('honors a windowed read_file (offset/limit)', () => {
    expect(run(gemini, cases['readWindowed'], DENY).stdout).toBe('');
  });

  it('rewrites run_shell_command via hookSpecificOutput.tool_input', () => {
    const { json } = run(gemini, cases['shellCatBig'], REWRITE);
    expect(json).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'BeforeTool',
        tool_input: { command: 'smelt /repo/big.ts --budget 8000' },
      },
    });
  });
});

describe('grok shim (EXPERIMENTAL, deny-only)', () => {
  const cases = fixture('grok');

  it('denies with {"decision":"deny"}', () => {
    expect(run(grok, cases['readBig'], DENY).json).toMatchObject({ decision: 'deny' });
  });

  it('rewrite mode falls back to a deny whose reason carries the replacement — input is read-only there', () => {
    const { json } = run(grok, cases['bashCatBig'], REWRITE);
    expect(json).toMatchObject({ decision: 'deny' });
    expect((json as { reason: string }).reason).toContain('smelt /repo/big.ts --budget 8000');
  });
});

describe('hermes shim (EXPERIMENTAL)', () => {
  const cases = fixture('hermes');

  it('blocks with {"action":"block"}', () => {
    expect(run(hermes, cases['readBig'], DENY).json).toMatchObject({ action: 'block' });
  });

  it('rewrites with {"action":"modify","args":{command}} — a shallow merge, so only command is sent', () => {
    const { json } = run(hermes, cases['bashCatBig'], REWRITE);
    expect(json).toEqual({
      action: 'modify',
      args: { command: 'smelt /repo/big.ts --budget 8000' },
    });
  });
});

describe('cursor shim (EXPERIMENTAL)', () => {
  const cases = fixture('cursor');

  it('denies with permission:"deny" and the steering text in agentMessage', () => {
    const { json } = run(cursor, cases['readBig'], DENY);
    expect(json).toMatchObject({ permission: 'deny' });
    expect((json as { agentMessage: string }).agentMessage).toContain('smelt retrieve');
  });

  it('rewrites via updated_input (snake_case)', () => {
    const { json } = run(cursor, cases['terminalCatBig'], REWRITE);
    expect(json).toMatchObject({
      permission: 'allow',
      updated_input: { command: 'smelt /repo/big.ts --budget 8000' },
    });
  });
});

describe('cline shim (EXPERIMENTAL, deny-only)', () => {
  const cases = fixture('cline');

  it('cancels with {"cancel":true} in both accepted input spellings', () => {
    expect(run(cline, cases['readBig'], DENY).json).toMatchObject({ cancel: true });
    expect(run(cline, cases['readBigNested'], DENY).json).toMatchObject({ cancel: true });
  });

  it('rewrite mode falls back to cancel — the response schema has no input-modification field', () => {
    const { json } = run(cline, cases['bashCatBig'], REWRITE);
    expect(json).toMatchObject({ cancel: true });
    expect((json as { errorMessage: string }).errorMessage).toContain(
      'smelt /repo/big.ts --budget 8000',
    );
  });
});

describe('the built shim scripts are runnable front doors', () => {
  it('dist/hooks/shims/claude-code.js answers a real spawned request (isMainModule wiring)', () => {
    const script = join(packageRoot(), 'dist', 'hooks', 'shims', 'claude-code.js');
    const spawned = spawnSync(process.execPath, [script], {
      input: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'echo hello' },
      }),
      encoding: 'utf8',
    });
    expect(spawned.status).toBe(0);
    expect(spawned.stdout).toBe(''); // allow: no output
  });
});
