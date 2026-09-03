#!/usr/bin/env node
/**
 * Empty `dist/` before a build.
 *
 * `tsc` overwrites what it emits and leaves everything else, so a module deleted from
 * `src` keeps its `dist` output — and its declaration map, which then names a source
 * file that no longer exists. That stale output is publishable: `files` ships `dist`
 * wholesale. Clearing first makes the build's output a function of the source alone.
 */
import { rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = process.cwd();
const dist = join(packageDir, 'dist');
void resolve(dirname(fileURLToPath(import.meta.url)));
rmSync(dist, { recursive: true, force: true });
