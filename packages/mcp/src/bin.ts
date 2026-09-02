#!/usr/bin/env node
import process from 'node:process';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SmeltError } from '@smeltjs/core';

import { createSmeltMcpServer, SERVER_NAME, SERVER_VERSION } from './server.ts';

/**
 * The `smelt-mcp` binary (`npx @smeltjs/mcp`). Owns only what cannot live in
 * `server.ts`: the shebang, the real stdio transport, the process exit.
 *
 * The stdout/stderr split is absolute here, not stylistic: stdout belongs to the
 * transport — protocol JSON only — so every human-readable word, the startup line and
 * any fatal error included, goes to stderr. `test/protocol.test.ts` drives this exact
 * binary over a real pipe and fails if a non-JSON byte ever lands on stdout.
 */
async function main(): Promise<void> {
  const { server, resolved } = createSmeltMcpServer({ cwd: process.cwd() });

  // stderr, never stdout: a human-facing startup receipt naming the store decision,
  // so "which store is this server on?" is answered by the harness log.
  process.stderr.write(`${SERVER_NAME} ${SERVER_VERSION}: ${resolved.description}\n`);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // No explicit exit wiring: when stdin ends or the client disconnects, the transport
  // closes its streams, nothing holds the event loop, and the process exits 0 on its
  // own. (`test/protocol.test.ts` asserts exactly that over a real pipe.)
}

main().catch((error: unknown) => {
  // A refusal (a malformed smelt.config.json, say) or an unexpected crash — either
  // way it is prose, so it belongs on stderr, and the exit code says it was fatal.
  const message =
    error instanceof SmeltError
      ? `${error.name}: ${error.message}`
      : error instanceof Error
        ? (error.stack ?? error.message)
        : String(error);
  process.stderr.write(`${SERVER_NAME}: ${message}\n`);
  process.exit(1);
});
