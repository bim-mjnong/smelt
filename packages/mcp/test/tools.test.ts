import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CliUsageError } from '@smeltjs/core';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createSmeltMcpServer,
  REPO_MAP_TOOL_NAME,
  RETRIEVE_TOOL_NAME,
  SMELT_FILE_TOOL_NAME,
  SMELT_STATS_TOOL_NAME,
} from '../src/index.ts';

/**
 * In-process tests for each tool's edge cases, driven through a real SDK client over
 * a linked in-memory transport pair — the same protocol layer the stdio binary
 * serves, minus the process boundary (`test/protocol.test.ts` owns that half).
 */

const cleanups: (() => void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'smelt-mcp-test-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function connect(cwd: string): Promise<Client> {
  const { server } = createSmeltMcpServer({ cwd });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'smelt-mcp-test', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(() => {
    void client.close();
    void server.close();
  });
  return client;
}

interface ToolResult {
  readonly isError: boolean;
  readonly texts: readonly string[];
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content?: readonly { type: string; text?: string }[];
  };
  return {
    isError: result.isError === true,
    texts: (result.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? ''),
  };
}

/** A blob with an obvious focus target and plenty of collapsible padding. */
function fixtureText(lines = 300): string {
  const padding = Array.from({ length: lines }, (_, i) => `padding line ${String(i)}`);
  padding.splice(150, 0, 'the handleRequest line the task is about');
  return `${padding.join('\n')}\n`;
}

describe('tools/list', () => {
  it('serves exactly the four ruled tools, budgetBytes required where it exists', async () => {
    const client = await connect(tempDir());
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).toSorted()).toEqual(
      [
        SMELT_FILE_TOOL_NAME,
        RETRIEVE_TOOL_NAME,
        REPO_MAP_TOOL_NAME,
        SMELT_STATS_TOOL_NAME,
      ].toSorted(),
    );
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.get(SMELT_FILE_TOOL_NAME)?.inputSchema['required']).toEqual(['budgetBytes']);
    expect(byName.get(REPO_MAP_TOOL_NAME)?.inputSchema['required']).toEqual(['dir', 'budgetBytes']);
    expect(byName.get(RETRIEVE_TOOL_NAME)?.inputSchema['required']).toEqual(['hash']);
    // The retrieve description is the core's own, rendered around a real marker — the
    // example a model learns from can never drift from the wire format.
    expect(byName.get(RETRIEVE_TOOL_NAME)?.description).toContain('<<smelt/v1:');
  });
});

describe('smelt_file', () => {
  it('smelts inline text and returns the payload plus the report, markers intact', async () => {
    const client = await connect(tempDir());
    const input = fixtureText();
    const result = await call(client, SMELT_FILE_TOOL_NAME, {
      text: input,
      budgetBytes: 600,
      focus: ['handleRequest'],
    });
    expect(result.isError).toBe(false);
    expect(result.texts).toHaveLength(2);
    const [smelted, report] = result.texts as [string, string];
    expect(smelted).toContain('the handleRequest line the task is about');
    expect(smelted).toContain('<<smelt/v1:');
    expect(smelted.length).toBeLessThan(input.length);
    expect(report).toMatch(/in [\d,]+ B → out [\d,]+ B/);
    expect(report).toContain('focus-window');
  });

  it('reads a file when given a path, resolved against the server cwd', async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, 'build.log'), fixtureText());
    const client = await connect(cwd);
    const result = await call(client, SMELT_FILE_TOOL_NAME, {
      path: 'build.log',
      budgetBytes: 600,
      focus: ['handleRequest'],
    });
    expect(result.isError).toBe(false);
    expect(result.texts[0]).toContain('<<smelt/v1:');
    expect(result.texts[1]).toContain('build.log');
  });

  it('refuses path and text together, and neither, as tool errors', async () => {
    const client = await connect(tempDir());
    const both = await call(client, SMELT_FILE_TOOL_NAME, {
      path: 'x',
      text: 'y',
      budgetBytes: 100,
    });
    expect(both.isError).toBe(true);
    expect(both.texts[0]).toContain('pass exactly one of "path"');
    const neither = await call(client, SMELT_FILE_TOOL_NAME, { budgetBytes: 100 });
    expect(neither.isError).toBe(true);
    expect(neither.texts[0]).toContain('pass exactly one of "path"');
  });

  it('refuses a missing, zero, negative or fractional budget — never invents one', async () => {
    const client = await connect(tempDir());
    for (const args of [
      { text: 'hello' },
      { text: 'hello', budgetBytes: 0 },
      { text: 'hello', budgetBytes: -1 },
      { text: 'hello', budgetBytes: 1.5 },
      { text: 'hello', budgetBytes: '4kb' },
    ]) {
      const result = await call(client, SMELT_FILE_TOOL_NAME, args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(result.texts[0]).toContain('budgetBytes');
    }
  });

  it('refuses an unknown argument key instead of silently ignoring it', async () => {
    const client = await connect(tempDir());
    const result = await call(client, SMELT_FILE_TOOL_NAME, {
      text: 'hello',
      budgetBytes: 100,
      focuss: ['typo'],
    });
    expect(result.isError).toBe(true);
    expect(result.texts[0]).toContain('unknown argument');
    expect(result.texts[0]).toContain('"focuss"');
  });

  it('refuses an unreadable path as a tool error naming the path', async () => {
    const client = await connect(tempDir());
    const result = await call(client, SMELT_FILE_TOOL_NAME, {
      path: 'no-such-file.txt',
      budgetBytes: 100,
    });
    expect(result.isError).toBe(true);
    expect(result.texts[0]).toContain('cannot read "no-such-file.txt"');
  });

  it('passes a structural refusal through as a tool error, never a silent fallback', async () => {
    const client = await connect(tempDir());
    const result = await call(client, SMELT_FILE_TOOL_NAME, {
      text: fixtureText(),
      budgetBytes: 600,
      strategy: 'structural', // inline text has no path → language 'unknown' → refusal
    });
    expect(result.isError).toBe(true);
    expect(result.texts[0]).toContain('GrammarUnavailableError');
  });

  it('rejects an unknown strategy name against the registry', async () => {
    const client = await connect(tempDir());
    const result = await call(client, SMELT_FILE_TOOL_NAME, {
      text: 'hello',
      budgetBytes: 100,
      strategy: 'clever',
    });
    expect(result.isError).toBe(true);
    expect(result.texts[0]).toContain('"strategy" must be');
  });

  it('defaults the strategy from smelt.config.json, flag-over-config style', async () => {
    const cwd = tempDir();
    writeFileSync(
      join(cwd, 'smelt.config.json'),
      `${JSON.stringify({ smeltConfig: 1, strategy: 'structural' })}\n`,
    );
    const client = await connect(cwd);
    // No strategy argument → the config's structural default applies to pathless
    // text (language 'unknown'), which structural refuses: proof the default drove.
    const configured = await call(client, SMELT_FILE_TOOL_NAME, {
      text: fixtureText(),
      budgetBytes: 600,
    });
    expect(configured.isError).toBe(true);
    expect(configured.texts[0]).toContain('GrammarUnavailableError');
    // An explicit argument wins over the config, same precedence as the CLI.
    const explicit = await call(client, SMELT_FILE_TOOL_NAME, {
      text: fixtureText(),
      budgetBytes: 600,
      strategy: 'lexical',
    });
    expect(explicit.isError).toBe(false);
  });

  it('handles an oversized input without truncating it silently', async () => {
    const client = await connect(tempDir());
    const big = fixtureText(120_000); // ~2 MB
    const result = await call(client, SMELT_FILE_TOOL_NAME, {
      text: big,
      budgetBytes: 2_000,
      focus: ['handleRequest'],
    });
    expect(result.isError).toBe(false);
    const [smelted, report] = result.texts as [string, string];
    expect(smelted).toContain('the handleRequest line the task is about');
    expect(smelted).toContain('<<smelt/v1:');
    expect(smelted.length).toBeLessThan(big.length / 100);
    expect(report).toMatch(/\d+ elisions/);
  });
});

describe('smelt_retrieve', () => {
  it('returns the exact elided bytes, and the retrieval is counted', async () => {
    const client = await connect(tempDir());
    const input = fixtureText();
    const smelted = (
      await call(client, SMELT_FILE_TOOL_NAME, {
        text: input,
        budgetBytes: 600,
        focus: ['handleRequest'],
      })
    ).texts[0]!;
    const hash = /retrieve\("([0-9a-f]+)"\)/.exec(smelted)?.[1];
    expect(hash, 'no marker hash in the smelted output').toBeDefined();

    const retrieved = await call(client, RETRIEVE_TOOL_NAME, { hash });
    expect(retrieved.isError).toBe(false);
    expect(retrieved.texts).toHaveLength(1);
    // Exact original bytes: the retrieved run is a verbatim slice of the input.
    expect(retrieved.texts[0]!.length).toBeGreaterThan(0);
    expect(input).toContain(retrieved.texts[0]!);

    const stats = JSON.parse((await call(client, SMELT_STATS_TOOL_NAME, {})).texts[0]!) as Record<
      string,
      number
    >;
    expect(stats['retrieveCalls']).toBe(1);
    expect(stats['uniqueRetrieved']).toBe(1);
  });

  it('answers an unknown hash with a tool error, never empty text', async () => {
    const client = await connect(tempDir());
    const result = await call(client, RETRIEVE_TOOL_NAME, { hash: 'deadbeefdeadbeef' });
    expect(result.isError).toBe(true);
    expect(result.texts[0]).toContain('UnknownHashError');
    expect(result.texts[0]).toContain('no stored content for hash "deadbeefdeadbeef"');
  });

  it('says how to get persistence when a memory store cannot hold earlier sessions', async () => {
    const client = await connect(tempDir()); // no config → memory store
    const result = await call(client, RETRIEVE_TOOL_NAME, { hash: 'deadbeefdeadbeef' });
    expect(result.isError).toBe(true);
    expect(result.texts[0]).toContain('memory store dies with the process that made it');
    expect(result.texts[0]).toContain('{"store": {"kind": "directory", "path": …}}');
    expect(result.texts[0]).toContain('smelt.config.json');
    expect(result.texts[0]).toContain('`smelt init` writes one');
  });

  it('keeps the directory-store unknown-hash error free of the memory-store hint', async () => {
    const cwd = tempDir();
    writeFileSync(
      join(cwd, 'smelt.config.json'),
      `${JSON.stringify({
        smeltConfig: 1,
        store: { kind: 'directory', path: '.smelt-store' },
      })}\n`,
    );
    const client = await connect(cwd);
    const result = await call(client, RETRIEVE_TOOL_NAME, { hash: 'deadbeefdeadbeef' });
    expect(result.isError).toBe(true);
    expect(result.texts[0]).toContain('UnknownHashError');
    expect(result.texts[0]).not.toContain('memory store dies');
  });

  it('retrieves across server instances through the shared directory store', async () => {
    const cwd = tempDir();
    writeFileSync(
      join(cwd, 'smelt.config.json'),
      `${JSON.stringify({
        smeltConfig: 1,
        store: { kind: 'directory', path: '.smelt-store' },
      })}\n`,
    );
    const input = fixtureText();

    const first = await connect(cwd);
    const smelted = (
      await call(first, SMELT_FILE_TOOL_NAME, {
        text: input,
        budgetBytes: 600,
        focus: ['handleRequest'],
      })
    ).texts[0]!;
    const hash = /retrieve\("([0-9a-f]+)"\)/.exec(smelted)![1]!;

    // A second server over the same cwd — a later session. Same config discovery,
    // same directory, same bytes: this is the CLI-and-server-share-one-store claim.
    const second = await connect(cwd);
    const retrieved = await call(second, RETRIEVE_TOOL_NAME, { hash });
    expect(retrieved.isError).toBe(false);
    expect(input).toContain(retrieved.texts[0]!);

    const stats = JSON.parse((await call(second, SMELT_STATS_TOOL_NAME, {})).texts[0]!) as Record<
      string,
      number
    >;
    expect(stats['retrieveCalls']).toBe(1);
    expect(stats['elisionsStored']).toBeGreaterThan(0);
  });
});

describe('repo_map', () => {
  it('renders a ranked map inside the budget', async () => {
    const cwd = tempDir();
    const src = join(cwd, 'src');
    mkdirSync(src);
    writeFileSync(
      join(src, 'greet.ts'),
      'export function greet(name: string): string {\n  return `hi ${name}`;\n}\n',
    );
    writeFileSync(
      join(src, 'main.ts'),
      "import { greet } from './greet.ts';\n\nexport function main(): void {\n  greet('smelt');\n  greet('again');\n}\n",
    );
    const client = await connect(cwd);
    const result = await call(client, REPO_MAP_TOOL_NAME, { dir: 'src', budgetBytes: 2_000 });
    expect(result.isError).toBe(false);
    expect(result.texts[0]).toContain('greet');
    expect(Buffer.byteLength(result.texts[0]!, 'utf8')).toBeLessThanOrEqual(2_000);
  });

  it('refuses a missing or non-directory target as a tool error', async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, 'a-file.txt'), 'not a directory\n');
    const client = await connect(cwd);
    const missing = await call(client, REPO_MAP_TOOL_NAME, { dir: 'nowhere', budgetBytes: 1_000 });
    expect(missing.isError).toBe(true);
    expect(missing.texts[0]).toContain('cannot read directory "nowhere"');
    const file = await call(client, REPO_MAP_TOOL_NAME, { dir: 'a-file.txt', budgetBytes: 1_000 });
    expect(file.isError).toBe(true);
    expect(file.texts[0]).toContain('is not a directory');
  });
});

describe('smelt_stats', () => {
  it('is an uncounted read: watching the counters never moves them', async () => {
    const client = await connect(tempDir());
    await call(client, SMELT_FILE_TOOL_NAME, {
      text: fixtureText(),
      budgetBytes: 600,
      focus: ['handleRequest'],
    });
    const first = JSON.parse((await call(client, SMELT_STATS_TOOL_NAME, {})).texts[0]!) as Record<
      string,
      unknown
    >;
    const second = JSON.parse((await call(client, SMELT_STATS_TOOL_NAME, {})).texts[0]!) as Record<
      string,
      unknown
    >;
    expect(second).toEqual(first);
    expect(first['retrieveCalls']).toBe(0);
    expect(first['elisionsStored']).toBeGreaterThan(0);
    expect(first['allElisionsRetrieved']).toBe(false);
  });

  it('refuses arguments — the tool takes none', async () => {
    const client = await connect(tempDir());
    const result = await call(client, SMELT_STATS_TOOL_NAME, { verbose: true });
    expect(result.isError).toBe(true);
    expect(result.texts[0]).toContain('unknown argument');
  });
});

describe('startup', () => {
  it('refuses to start on a malformed smelt.config.json, exactly as the CLI does', () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, 'smelt.config.json'), '{"smeltConfig": 1, "defaultBudgetByte": 5}\n');
    expect(() => createSmeltMcpServer({ cwd })).toThrow(CliUsageError);
    expect(() => createSmeltMcpServer({ cwd })).toThrow(/unknown key "defaultBudgetByte"/);
  });
});
