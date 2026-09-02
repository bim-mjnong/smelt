import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  buildRepoMap,
  createRetrieveTool,
  createSmelter,
  formatReport,
  isStrategy,
  RETRIEVE_TOOL_NAME,
  SmeltError,
  STRATEGIES,
  UnknownHashError,
} from '@smeltjs/core';
import type { Strategy } from '@smeltjs/core';

import { resolveMcpStore } from './store.ts';
import type { ResolvedMcpStore } from './store.ts';

/**
 * The smelt MCP server: the same library the `smelt` CLI fronts, as four stdio tools.
 *
 * The tool surface is deliberately minimal (founder ruling, KOT-211): `smelt_file`,
 * `smelt_retrieve`, `repo_map`, `smelt_stats` — the smallest set that covers cut,
 * un-cut, orient, and audit. Everything else the library offers stays a library
 * concern; a tool a model never needed is context every call pays for.
 *
 * Two properties are load-bearing and guarded:
 *
 * - **stdio-local.** This package's one sanctioned dependency beyond the core is the
 *   official `@modelcontextprotocol/sdk`, and only its stdio transport. The SDK also
 *   ships HTTP/SSE transports; no module here imports them, and
 *   `test/guards/no-network.test.ts` pins the exact SDK subpaths this source may
 *   touch — so Law 1 (zero network) holds for the server the same way it holds for
 *   the library under it.
 * - **stdout carries protocol JSON only.** The transport owns stdout; every human
 *   word this server says goes to stderr. A log line on stdout is a corrupted
 *   JSON-RPC stream, which clients report as a broken server.
 */

/** The server's protocol-visible name. */
export const SERVER_NAME = 'smelt-mcp';

/** This package's version, read from the manifest so the two cannot drift. */
export const SERVER_VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

/** Tool names. `smelt_retrieve` is the core's frozen wire-surface name, re-exported. */
export const SMELT_FILE_TOOL_NAME = 'smelt_file';
export const REPO_MAP_TOOL_NAME = 'repo_map';
export const SMELT_STATS_TOOL_NAME = 'smelt_stats';
export { RETRIEVE_TOOL_NAME } from '@smeltjs/core';

/**
 * The `instructions` field of the initialize result. A hint, not a lever (clients MAY
 * surface it — see docs/research/2026-09-02-agent-enforcement.md §4), so it carries
 * the one fact a model cannot infer from the tool list alone: markers' in-band
 * `retrieve("hash")` maps to the `smelt_retrieve` tool here. Kept well under the 2 KB
 * cap Claude Code applies to descriptions + instructions.
 */
export const SERVER_INSTRUCTIONS =
  'smelt shrinks what enters your context without lying about what it removed. ' +
  'Use smelt_file instead of reading a large file (or pasting a large blob) raw: it cuts ' +
  'the text to a byte budget and replaces everything it removed with one-line markers like ' +
  '`<<smelt/v1: collapsed 3 sibling functions (2224B) — retrieve("84998967370f38bc")>>`. ' +
  'A marker\'s retrieve("hash") maps to the smelt_retrieve tool: call it with the hash to ' +
  'get the exact original bytes back — nothing is deleted, and guessing at what a marker ' +
  'hid is never correct. repo_map renders a ranked symbol map of a directory tree inside a ' +
  'byte budget, for orienting in an unfamiliar repository. Retrievals are counted; ' +
  'smelt_stats reads the counters (including the expansion rate — the fraction of hidden ' +
  'content asked for back) without changing them.';

/** Options for {@link createSmeltMcpServer}. */
export interface SmeltMcpServerOptions {
  /**
   * Where `smelt.config.json` discovery starts — the directory the harness launched
   * the server in, which is how the CLI and the server find the same store. Defaults
   * to the process working directory.
   */
  readonly cwd?: string;
}

/** A constructed server plus the store decision it runs on. */
export interface SmeltMcpServer {
  /** The SDK server. Connect it to a transport; `bin.ts` wires real stdio. */
  readonly server: Server;
  /** The store decision, for the startup line and for tests. */
  readonly resolved: ResolvedMcpStore;
}

/** One text block, the shape every tool result here is built from. */
function text(value: string): { type: 'text'; text: string } {
  return { type: 'text', text: value };
}

/**
 * A tool-level error: `isError: true` plus a message the model can act on. Distinct
 * from a protocol error on purpose — a bad argument or an unknown hash is a fact about
 * this call, not a broken server, and the model is the party that can correct it.
 */
function toolError(message: string): CallToolResult {
  return { isError: true, content: [text(message)] };
}

/** Thrown by the argument readers below; caught and rendered as a tool error. */
class ToolArgumentError extends Error {}

function asArguments(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ToolArgumentError('arguments must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

/**
 * Refuse unknown argument keys, exactly as the CLI refuses unknown config keys: a
 * typo'd `focuss` that parsed cleanly would be an argument the model believed it
 * passed, silently ignored — the one failure shape this project refuses everywhere.
 */
function refuseUnknownKeys(args: Record<string, unknown>, known: readonly string[]): void {
  const unknown = Object.keys(args).filter((key) => !known.includes(key));
  if (unknown.length > 0) {
    throw new ToolArgumentError(
      `unknown argument${unknown.length === 1 ? '' : 's'} ` +
        `${unknown.map((key) => `"${key}"`).join(', ')}. ` +
        `Known arguments: ${known.length === 0 ? '(none)' : known.join(', ')}.`,
    );
  }
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new ToolArgumentError(`"${key}" must be a string.`);
  return value;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = optionalString(args, key);
  if (value === undefined || value === '') {
    throw new ToolArgumentError(`"${key}" is required and must be a non-empty string.`);
  }
  return value;
}

/**
 * `budgetBytes`, validated the way the CLI validates `--budget`: a whole number of
 * UTF-8 bytes greater than zero, with no default — a budget this server invented
 * would silently decide how much of the caller's context to throw away.
 */
function requireBudget(args: Record<string, unknown>): number {
  const value = args['budgetBytes'];
  if (value === undefined) {
    throw new ToolArgumentError(
      '"budgetBytes" is required, in UTF-8 bytes. There is no default, because a ' +
        'budget smelt invented would silently decide how much of your context to ' +
        'throw away.',
    );
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ToolArgumentError(
      `"budgetBytes" must be a whole number of bytes, got ${JSON.stringify(value)}.`,
    );
  }
  if (value <= 0) {
    throw new ToolArgumentError(`"budgetBytes" must be greater than zero, got ${String(value)}.`);
  }
  return value;
}

function optionalFocus(args: Record<string, unknown>): readonly string[] | undefined {
  const value = args['focus'];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ToolArgumentError('"focus" must be an array of strings.');
  }
  return value as readonly string[];
}

function optionalStrategy(args: Record<string, unknown>): Strategy | undefined {
  const value = optionalString(args, 'strategy');
  if (value === undefined) return undefined;
  if (!isStrategy(value)) {
    throw new ToolArgumentError(
      `"strategy" must be ${STRATEGIES.map((s) => `"${s}"`).join(' or ')}, ` +
        `got ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

/** The JSON Schema fragments the tool list advertises. */
const BUDGET_SCHEMA = {
  type: 'integer',
  minimum: 1,
  description:
    'Output ceiling in UTF-8 bytes. Required — there is no default budget. Budgets are ' +
    'bytes, permanently: bytes are the only unit computable locally for every model.',
} as const;

const FOCUS_SCHEMA = {
  type: 'array',
  items: { type: 'string' },
  description:
    'What the task is actually about — a symbol name, an error string, a grep pattern. ' +
    'Matching regions survive; everything else is first to go.',
} as const;

function buildToolList(retrieveDescription: string): Tool[] {
  return [
    {
      name: SMELT_FILE_TOOL_NAME,
      description:
        'Shrink a file (or a blob of text) to a byte budget before it enters context, ' +
        'without losing anything: the parts the task needs survive, and every removed ' +
        'region is replaced by a one-line marker naming what went, how big it was, and a ' +
        'hash that smelt_retrieve turns back into the exact original bytes. Use it ' +
        'instead of reading a large file raw; for a small file, reading raw is cheaper ' +
        'than a round trip. Returns two text blocks: the smelted text, then a report of ' +
        'every elision (rule, lines, bytes, hash, explanation).',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              "File to read and smelt, resolved against the server's working directory. " +
              'Pass exactly one of "path" or "text".',
          },
          text: {
            type: 'string',
            description:
              'The blob itself — a grep result, a build log, a diff. Pass exactly one of ' +
              '"path" or "text".',
          },
          budgetBytes: BUDGET_SCHEMA,
          focus: FOCUS_SCHEMA,
          strategy: {
            type: 'string',
            enum: [...STRATEGIES],
            description:
              '"structural" parses the file and collapses whole sibling declarations ' +
              '(refused, never approximated, for languages without a bundled grammar); ' +
              '"lexical" uses focus windows — right for logs, traces, and anything that ' +
              'is not code. Defaults to the smelt.config.json strategy, else "lexical".',
          },
        },
        required: ['budgetBytes'],
        additionalProperties: false,
      },
    },
    {
      name: RETRIEVE_TOOL_NAME,
      // The core renders this description around a marker built by the real marker
      // builder, so the example a model learns from can never drift from the wire
      // format. Reused verbatim for the same reason the tool name is.
      description: retrieveDescription,
      inputSchema: {
        type: 'object',
        properties: {
          hash: {
            type: 'string',
            description: 'The hash from a marker\'s retrieve("hash").',
          },
        },
        required: ['hash'],
        additionalProperties: false,
      },
    },
    {
      name: REPO_MAP_TOOL_NAME,
      description:
        'A ranked symbol map of a whole directory tree, fitted to a byte budget by ' +
        'construction — tree-sitter definition tags ranked by references (modelled on ' +
        "Aider's repo map), every included symbol stating why it ranked. Use it to " +
        'orient in an unfamiliar repository before opening files; it elides nothing and ' +
        'stores nothing, so there is nothing to retrieve from it.',
      inputSchema: {
        type: 'object',
        properties: {
          dir: {
            type: 'string',
            description: "Directory to map, resolved against the server's working directory.",
          },
          budgetBytes: BUDGET_SCHEMA,
          focus: FOCUS_SCHEMA,
        },
        required: ['dir', 'budgetBytes'],
        additionalProperties: false,
      },
    },
    {
      name: SMELT_STATS_TOOL_NAME,
      description:
        "The store's retrieval counters, verbatim: elisionsStored, bytesStored, " +
        'retrieveCalls, uniqueRetrieved, misses, expansionRate (the fraction of hidden ' +
        'blobs asked for back — the honest signal of over-pruning) and ' +
        'allElisionsRetrieved. Reading stats is not a retrieval and never moves the ' +
        'counters.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  ];
}

/**
 * Build the server: resolve the store once, register the four tools, and wire every
 * refusal to a tool-level error rather than a crash.
 *
 * @throws {CliUsageError} when a `smelt.config.json` exists and is malformed — the
 *   server refuses to start on a config it cannot have meant, exactly as the CLI does.
 */
export function createSmeltMcpServer(options: SmeltMcpServerOptions = {}): SmeltMcpServer {
  const cwd = options.cwd ?? process.cwd();
  const resolved = resolveMcpStore(cwd);
  const retrieveTool = createRetrieveTool(resolved.store);
  const tools = buildToolList(retrieveTool.description);

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const name = request.params.name;
    try {
      const args = asArguments(request.params.arguments);
      switch (name) {
        case SMELT_FILE_TOOL_NAME:
          return await handleSmeltFile(args, resolved, cwd);
        case RETRIEVE_TOOL_NAME:
          return handleRetrieve(args, resolved);
        case REPO_MAP_TOOL_NAME:
          return await handleRepoMap(args, cwd);
        case SMELT_STATS_TOOL_NAME:
          return handleStats(args, resolved);
        default:
          throw new McpError(ErrorCode.InvalidParams, `unknown tool "${name}"`);
      }
    } catch (error) {
      if (error instanceof ToolArgumentError) return toolError(`${name}: ${error.message}`);
      // The library said no — a refusal, passed through with its name so the model
      // can tell a GrammarUnavailableError from an UnknownHashError. Never an empty
      // result, never a crash: a refusal is an answer.
      if (error instanceof SmeltError) return toolError(`${error.name}: ${error.message}`);
      throw error;
    }
  });

  return { server, resolved };
}

async function handleSmeltFile(
  args: Record<string, unknown>,
  resolved: ResolvedMcpStore,
  cwd: string,
): Promise<CallToolResult> {
  refuseUnknownKeys(args, ['path', 'text', 'budgetBytes', 'focus', 'strategy']);
  const path = optionalString(args, 'path');
  const inline = optionalString(args, 'text');
  if ((path === undefined) === (inline === undefined)) {
    throw new ToolArgumentError(
      'pass exactly one of "path" (a file to read) or "text" (the blob itself).',
    );
  }
  const budgetBytes = requireBudget(args);
  const focus = optionalFocus(args);
  const strategy = optionalStrategy(args) ?? resolved.defaultStrategy ?? 'lexical';

  let inputText: string;
  let source: string;
  if (path !== undefined) {
    const full = resolve(cwd, path);
    try {
      inputText = readFileSync(full, 'utf8');
    } catch (cause) {
      throw new ToolArgumentError(
        `cannot read "${path}": ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    source = path;
  } else {
    inputText = inline as string;
    source = '<text>';
  }

  const smelter = createSmelter({ store: resolved.store, strategy });
  const result = await smelter.smelt(inputText, {
    budgetBytes,
    ...(path === undefined ? {} : { path }),
    ...(focus === undefined ? {} : { focus }),
  });

  // Two blocks: the payload, then the same report the CLI prints to stderr — every
  // total read off the result, no separate accounting. Over budget is reported in the
  // report (the plan came back as it came back), not dressed up as an error.
  return {
    content: [text(result.text), text(formatReport({ result, source, budgetBytes, inputText }))],
  };
}

function handleRetrieve(args: Record<string, unknown>, resolved: ResolvedMcpStore): CallToolResult {
  refuseUnknownKeys(args, ['hash']);
  const hash = requireString(args, 'hash');
  try {
    // The counted read — this is the expansion rate moving. Exact original bytes,
    // nothing appended, nothing re-encoded.
    return { content: [text(resolved.store.retrieve(hash))] };
  } catch (error) {
    if (error instanceof UnknownHashError && resolved.persistenceHint !== undefined) {
      // On a memory store, "unknown hash" is very often "hash from an earlier
      // session" — say so, the way the CLI's `smelt retrieve` refusal says so.
      return toolError(`${error.name}: ${error.message}\n\n${resolved.persistenceHint}`);
    }
    throw error;
  }
}

async function handleRepoMap(args: Record<string, unknown>, cwd: string): Promise<CallToolResult> {
  refuseUnknownKeys(args, ['dir', 'budgetBytes', 'focus']);
  const dir = requireString(args, 'dir');
  const budgetBytes = requireBudget(args);
  const focus = optionalFocus(args);

  const root = resolve(cwd, dir);
  let isDirectory: boolean;
  try {
    isDirectory = statSync(root).isDirectory();
  } catch (cause) {
    throw new ToolArgumentError(
      `cannot read directory "${dir}": ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (!isDirectory) {
    throw new ToolArgumentError(
      `"${dir}" is not a directory. repo_map reads a whole tree; for one file, use ` +
        `${SMELT_FILE_TOOL_NAME}.`,
    );
  }

  const map = await buildRepoMap({
    root,
    budgetBytes,
    ...(focus === undefined ? {} : { focus }),
  });

  const blocks = [text(map.text)];
  if (map.warnings.length > 0) {
    blocks.push(
      text(
        map.warnings
          .map((warning) => `warning  ${warning.rule}: ${warning.explanation}`)
          .join('\n'),
      ),
    );
  }
  return { content: blocks };
}

function handleStats(args: Record<string, unknown>, resolved: ResolvedMcpStore): CallToolResult {
  refuseUnknownKeys(args, []);
  // `stats()` journals nothing — an observer that inflated its own metric would make
  // the honest signal dishonest. The RetrieveStats goes out verbatim, as JSON.
  return { content: [text(JSON.stringify(resolved.store.stats(), null, 2))] };
}
