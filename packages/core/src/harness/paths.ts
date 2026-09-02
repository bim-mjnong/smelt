import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ShimmedHarnessProfile } from './profile.ts';

/**
 * Where the scripts a harness config points at actually live, and how a profile names
 * one. Path facts only — nothing here reads or writes a file.
 */

/**
 * The `dist` directory of this installed package — where the shipped guard core and
 * shim scripts live. Computed from this module's own location, which is
 * `<pkg>/dist/harness/` in every real run (the CLI executes from `dist`); under the
 * test runner it is `<pkg>/src/harness/`, and the substitution still points at `dist`,
 * which is where the scripts will exist once built — the paths are written into config
 * files for *node* to execute, never imported.
 */
function packageDistDir(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // <pkg>/(dist|src)/harness
  return join(dirname(dirname(here)), 'dist');
}

/**
 * The shim script a harness's hook command runs. Takes a profile rather than an id,
 * because only a profile that carries a hook schema (or a hand-written adapter) has a
 * shim script on disk: a path for a harness that ships none would name a file the
 * build never produced.
 */
export function shimScriptPath(profile: ShimmedHarnessProfile): string {
  return join(packageDistDir(), 'hooks', 'shims', `${profile.id}.js`);
}

/** The guard core as a module: what the opencode plugin imports at hook time. */
export function guardCoreScriptPath(): string {
  return join(packageDistDir(), 'hooks', 'guard-core.js');
}

/** The `smelt` binary — quoted into the stats and map hook commands. */
export function smeltBinPath(): string {
  return join(packageDistDir(), 'cli', 'bin.js');
}

/** Inside the project, a project-relative path travels with the repo; outside, absolute. */
export function portablePath(cwd: string, absolute: string): string {
  const rel = relative(cwd, absolute);
  return rel.startsWith('..') || isAbsolute(rel) ? absolute : rel.split(sep).join('/');
}

/** `node "<script>"` — how every harness config invokes something of smelt's. */
export function nodeCommand(cwd: string, script: string, args = ''): string {
  return `node "${portablePath(cwd, script)}"${args === '' ? '' : ` ${args}`}`;
}
