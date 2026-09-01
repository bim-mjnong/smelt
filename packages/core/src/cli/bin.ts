#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import process from 'node:process';

import { EXIT, runCli } from './run.ts';

/**
 * The `smelt` binary: the thinnest possible shell around {@link runCli}.
 *
 * Everything decidable lives in `run.ts`, which returns an exit code instead of
 * calling `exit`, so the whole CLI is testable in-process. This file owns only the
 * things that cannot be tested without a real process: the shebang, stdin on fd 0, and
 * the exit code itself.
 */

/** Reading fd 0 synchronously is the whole of "works in a pipe", with no stream plumbing. */
function readStdin(): string {
  if (process.stdin.isTTY === true) {
    process.stderr.write(
      'smelt: no input. Pass a file, or pipe text in:\n' +
        '  smelt src/server.ts --budget 4000\n' +
        '  smelt --budget 4000 --focus TypeError < build.log\n',
    );
    process.exit(EXIT.usage);
  }
  return readFileSync(0, 'utf8');
}

/** `--version` should agree with the manifest, not with a second copy of the number. */
function packageVersion(): string {
  const manifest = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
  const parsed = JSON.parse(manifest) as { version?: string };
  return parsed.version ?? '0.0.0';
}

try {
  process.exitCode = await runCli(process.argv.slice(2), {
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
    stdin: readStdin,
    version: packageVersion(),
    cwd: process.cwd(),
    // `smelt init` reads answers line by line, so it gets the stream, not readStdin's
    // one-shot slurp of fd 0.
    initInput: process.stdin,
  });
} catch (error) {
  process.stderr.write(
    `smelt: unexpected internal error — this is a bug, please report it.\n` +
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = EXIT.unexpected;
}
