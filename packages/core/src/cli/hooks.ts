import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Readable } from 'node:stream';

import { CliUsageError } from '../errors.ts';
import { nodeCommand, portablePath, shimScriptPath, smeltBinPath } from '../harness/paths.ts';
import { hasShim, TIER_HONESTY } from '../harness/profile.ts';
import type {
  HarnessInstallContext,
  HarnessJsonHooks,
  HarnessProfile,
} from '../harness/profile.ts';
import {
  GUARD_EVENTS,
  GUARD_ONLY_FILES,
  HARNESSES,
  harnessById,
  JSON_HOOK_FILES,
  LIFECYCLE_EVENTS,
  MANAGED_EVENTS,
} from '../harness/registry.ts';
import {
  instructionSnippet,
  OURS_TOKEN,
  SNIPPET_END_MD,
  SNIPPET_START_MD,
} from '../harness/snippet.ts';
import { DEFAULT_SUGGESTION_BUDGET_BYTES, DEFAULT_THRESHOLD_BYTES } from '../hooks/guard-core.ts';
import type { EnforcementMode } from '../hooks/guard-core.ts';

import { CLI_NAME } from './shell.ts';
import type { AnswerStream } from './shell.ts';
import {
  CONFIG_FILE_NAME,
  CONFIG_VERSION,
  findConfigFile,
  parseConfig,
  renderConfig,
} from './config.ts';
import type { SmeltConfig, SmeltConfigHooks } from './config.ts';

/**
 * `smelt hooks install` / `smelt hooks remove` — the multi-harness guard preset.
 *
 * The design: one zero-dependency guard core
 * (`src/hooks/guard-core.ts`), thin per-harness shims mapping each harness's native
 * hook schema onto it, and this installer, which writes the harness config that wires
 * a shim in — plus an instruction-file snippet as belt and braces, because the
 * snippet is also what teaches the model to run `smelt retrieve` after a deny.
 *
 * Every per-harness fact lives in that harness's {@link HarnessProfile}
 * (`src/harness/<id>.ts`), including what to write and how to take it back out. This
 * module owns only what is the *same* for every harness: the byte-faithful JSON merge,
 * the marker-block upsert, the wizard, and the two plans below — folds over
 * `profile.install`, with no case list of its own.
 *
 * Harnesses come in three honesty tiers (docs/research/2026-09-02-harness-capability-matrix.md):
 *
 *  - **verified** — Claude Code, Codex: schemas verified against primary docs and
 *    exercised against recorded fixtures; first-class targets.
 *  - **experimental** — Gemini, Grok, Hermes, Cursor, opencode, Cline: hook schemas
 *    mapped from the capability matrix but not yet smoke-tested green against the
 *    real binary. Labelled as such in code, docs, and this installer's output.
 *  - **advisory** — KiloCode, Aider: no usable hook API, so what ships is
 *    instructions (and, for KiloCode, a permissions/MCP sketch). Nothing enforces
 *    them, and the output says so rather than implying a guard exists.
 *
 * The wizard discipline is `smelt init`'s, verbatim: every step accepts `back`,
 * nothing is written until a final confirm that lists every file, and an existing
 * file is never overwritten without an explicit per-file `yes` — guarded by
 * `test/guards/hooks-preset.test.ts`, with mutation `hooks-install-overwrite-without-consent`
 * proving the guard goes red.
 */

/** Where the wizard's bytes come from and go. Injected so `runHooks` tests in-process. */
export interface HooksIo {
  /**
   * Scripted answers in, one line at a time. Structural on purpose; see
   * {@link AnswerStream}.
   */
  readonly input: AnswerStream;
  readonly output: (text: string) => void;
  /** Project directory: detection, config discovery, and every write are relative to it. */
  readonly cwd: string;
  /** Home directory for detection only. Tests point it at a temp dir; nothing writes here. */
  readonly home?: string;
}

export { instructionSnippet, SNIPPET_END_MD, SNIPPET_START_MD };

/** A harness whose config directory exists in the project or the home directory. */
export function detectedHarnesses(cwd: string, home: string): readonly HarnessProfile[] {
  return HARNESSES.filter(
    (profile) =>
      profile.detect.some((path) => existsSync(join(cwd, path))) ||
      profile.detectHome.some((path) => existsSync(join(home, path))),
  );
}

/* ------------------------------------------------------------------------------------
 * Generated content
 * ---------------------------------------------------------------------------------- */

/** Claude-style hook entry: one command under an optional matcher. */
function commandEntry(matcher: string | undefined, command: string): unknown {
  return {
    ...(matcher === undefined ? {} : { matcher }),
    hooks: [{ type: 'command', command }],
  };
}

/**
 * The hook command a harness's entries run: its own shim script, through node.
 *
 * @throws {Error} when a profile declares a JSON hook file but ships no shim — a
 *   registry bug, pinned by `test/guards/harness-registry.test.ts`, not a user error.
 */
function shimCommand(profile: HarnessProfile, cwd: string): string {
  /* v8 ignore next 5 -- unreachable: pinned by the harness-registry guard */
  if (!hasShim(profile)) {
    throw new Error(
      `smelt: harness "${profile.id}" wires a hook command but ships no shim script.`,
    );
  }
  return nodeCommand(cwd, shimScriptPath(profile));
}

/**
 * One harness's hook entries: the guard under each matcher its schema spells, plus
 * the two session-lifecycle hooks for the harnesses whose schema carries them. Every
 * toggle the wizard offers is a key that is present or absent here — an absent key is
 * how a re-run turns a toggle *off*, because the merge deletes what it no longer sees.
 */
function jsonHookEvents(
  step: HarnessJsonHooks,
  ctx: HarnessInstallContext,
  command: string,
): Record<string, readonly unknown[]> {
  // The trailing shell comment tags the entry as this installer's (see isOursEntry):
  // a bare `cli/bin.js` substring would also match some other npm CLI's built binary.
  const stats = `${nodeCommand(ctx.cwd, smeltBinPath(), 'stats')} 2>/dev/null || true # ${OURS_TOKEN}`;
  const map = `${nodeCommand(
    ctx.cwd,
    smeltBinPath(),
    `map . --budget ${String(ctx.budgetBytes)} --cache .smelt/tags`,
  )} 2>/dev/null || true # ${OURS_TOKEN}`;

  return {
    ...(ctx.guard
      ? {
          [step.event]: step.matchers.map((matcher) =>
            step.entry === 'bare-command' ? { command } : commandEntry(matcher, command),
          ),
        }
      : {}),
    ...(step.lifecycle && ctx.statsOnStop
      ? { [LIFECYCLE_EVENTS.stats]: [commandEntry(undefined, stats)] }
      : {}),
    ...(step.lifecycle && ctx.mapOnStart
      ? { [LIFECYCLE_EVENTS.map]: [commandEntry('startup|resume|clear|compact', map)] }
      : {}),
  };
}

/**
 * True for a hook entry this installer wrote. Matched on the shim script paths and the
 * `smelt:hooks` token the stats/map commands carry — never on a substring as generic
 * as `cli/bin.js`, which another npm CLI's built binary could share: remove and
 * re-install may only ever touch entries that are provably smelt's.
 */
function isOursEntry(entry: unknown): boolean {
  const text = JSON.stringify(entry) ?? '';
  return text.includes('hooks/shims/') || text.includes(OURS_TOKEN);
}

/**
 * Merge our hook entries into a JSON settings file, preserving everything foreign
 * **byte-faithfully**: the merged `hooks` value is spliced into the original text, so
 * unknown top-level keys, string escapes, number spellings, indentation and key order
 * outside the `hooks` property ride through verbatim (an installer
 * that reformats somebody's settings file has edited what it was never asked to).
 * Inside `hooks`, unmanaged events and other people's entries under managed events
 * are preserved; our previous entries are replaced (that is what makes a re-run edit
 * toggles), and events left with no entries disappear. A semantic no-op returns the
 * input text unchanged. Returns `undefined` when the existing file is not a JSON
 * object — the caller skips the file rather than clobbering something it cannot
 * understand.
 */
export function mergeJsonHooks(
  existingText: string | undefined,
  events: Record<string, readonly unknown[]>,
  shape: { readonly version?: number } = {},
): string | undefined {
  let root: Record<string, unknown> = {};
  if (existingText !== undefined) {
    try {
      const parsed: unknown = JSON.parse(existingText);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
      root = parsed as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  const hooksValue = root['hooks'];
  const existingHooks =
    typeof hooksValue === 'object' && hooksValue !== null && !Array.isArray(hooksValue)
      ? (hooksValue as Record<string, unknown>)
      : undefined;
  const hooks = { ...existingHooks };

  for (const event of MANAGED_EVENTS) {
    const existing = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    const foreign = existing.filter((entry) => !isOursEntry(entry));
    const ours = events[event] ?? [];
    const merged = [...foreign, ...ours];
    if (merged.length > 0) hooks[event] = merged;
    else delete hooks[event];
  }

  const mergedHooks = Object.keys(hooks).length > 0 ? hooks : undefined;

  // A brand-new file: nothing to preserve, render fresh two-space JSON.
  if (existingText === undefined) {
    const fresh: Record<string, unknown> = {};
    if (mergedHooks !== undefined) fresh['hooks'] = mergedHooks;
    if (shape.version !== undefined) fresh['version'] = shape.version;
    return `${JSON.stringify(fresh, null, 2)}\n`;
  }

  const hooksChanged =
    JSON.stringify(existingHooks ?? null) !== JSON.stringify(mergedHooks ?? null);
  const needsVersion = shape.version !== undefined && root['version'] === undefined;
  if (!hooksChanged && !needsVersion) return existingText;

  const newline = existingText.includes('\r\n') ? '\r\n' : '\n';
  const indent = /\n([ \t]+)"/.exec(existingText)?.[1] ?? '  ';
  let text = existingText;

  if (hooksChanged) {
    const scan = scanJsonTopLevel(text);
    /* v8 ignore next -- unreachable: JSON.parse accepted the same text above */
    if (scan === undefined) return undefined;
    const property = scan.properties.find((candidate) => candidate.key === 'hooks');
    if (mergedHooks === undefined) {
      if (property !== undefined) text = removeJsonProperty(text, scan, property);
    } else {
      const rendered = renderJsonValue(mergedHooks, indent, newline);
      text =
        property !== undefined
          ? `${text.slice(0, property.valueStart)}${rendered}${text.slice(property.valueEnd)}`
          : insertJsonProperty(text, scan, 'hooks', rendered, indent, newline);
    }
  }
  if (needsVersion) {
    const scan = scanJsonTopLevel(text);
    /* v8 ignore next -- unreachable: every splice above keeps the text valid JSON */
    if (scan === undefined) return undefined;
    text = insertJsonProperty(
      text,
      scan,
      'version',
      JSON.stringify(shape.version),
      indent,
      newline,
    );
  }
  return text;
}

/** One top-level property of a JSON object, located by offsets in its source text. */
interface JsonTopLevelProperty {
  readonly key: string;
  /** Offset of the key's opening quote. */
  readonly keyStart: number;
  /** Offset of the value's first byte. */
  readonly valueStart: number;
  /** Offset one past the value's last byte. */
  readonly valueEnd: number;
}

interface JsonTopLevelScan {
  /** Offset of the root object's `{`. */
  readonly open: number;
  /** Offset of the root object's `}`. */
  readonly close: number;
  readonly properties: readonly JsonTopLevelProperty[];
}

/**
 * Locate the top-level properties of a JSON object *in its source text*, so one
 * property can be replaced, inserted or removed while every other byte of the file
 * rides through verbatim. `undefined` when the text is not an object — callers have
 * already `JSON.parse`d it, so that is belt and braces, not a validator.
 */
function scanJsonTopLevel(text: string): JsonTopLevelScan | undefined {
  let i = skipJsonWhitespace(text, 0);
  if (text[i] !== '{') return undefined;
  const open = i;
  i = skipJsonWhitespace(text, i + 1);
  const properties: JsonTopLevelProperty[] = [];
  if (text[i] === '}') return { open, close: i, properties };
  for (;;) {
    if (text[i] !== '"') return undefined;
    const keyStart = i;
    const keyEnd = skipJsonString(text, i);
    if (keyEnd === undefined) return undefined;
    const key = JSON.parse(text.slice(keyStart, keyEnd)) as string;
    i = skipJsonWhitespace(text, keyEnd);
    if (text[i] !== ':') return undefined;
    const valueStart = skipJsonWhitespace(text, i + 1);
    const valueEnd = skipJsonValue(text, valueStart);
    if (valueEnd === undefined) return undefined;
    properties.push({ key, keyStart, valueStart, valueEnd });
    i = skipJsonWhitespace(text, valueEnd);
    if (text[i] === ',') {
      i = skipJsonWhitespace(text, i + 1);
      continue;
    }
    if (text[i] === '}') return { open, close: i, properties };
    return undefined;
  }
}

function skipJsonWhitespace(text: string, from: number): number {
  let i = from;
  while (i < text.length && ' \t\r\n'.includes(text[i]!)) i += 1;
  return i;
}

/** `from` points at `"`; returns the offset one past the closing quote. */
function skipJsonString(text: string, from: number): number | undefined {
  let i = from + 1;
  while (i < text.length) {
    if (text[i] === '\\') i += 2;
    else if (text[i] === '"') return i + 1;
    else i += 1;
  }
  return undefined;
}

function skipJsonValue(text: string, from: number): number | undefined {
  const first = text[from];
  if (first === '"') return skipJsonString(text, from);
  if (first === '{' || first === '[') {
    let depth = 0;
    let i = from;
    while (i < text.length) {
      const ch = text[i]!;
      if (ch === '"') {
        const end = skipJsonString(text, i);
        if (end === undefined) return undefined;
        i = end;
        continue;
      }
      if (ch === '{' || ch === '[') depth += 1;
      else if (ch === '}' || ch === ']') {
        depth -= 1;
        if (depth === 0) return i + 1;
      }
      i += 1;
    }
    return undefined;
  }
  // number / true / false / null
  let i = from;
  while (i < text.length && !',}] \t\r\n'.includes(text[i]!)) i += 1;
  return i > from ? i : undefined;
}

/** A JSON value indented for embedding at a top-level property position. */
function renderJsonValue(value: unknown, indent: string, newline: string): string {
  return JSON.stringify(value, null, indent).split('\n').join(`${newline}${indent}`);
}

function removeJsonProperty(
  text: string,
  scan: JsonTopLevelScan,
  property: JsonTopLevelProperty,
): string {
  const index = scan.properties.indexOf(property);
  const next = scan.properties[index + 1];
  if (next !== undefined) {
    // Delete through the separating comma and whitespace, up to the next key.
    return text.slice(0, property.keyStart) + text.slice(next.keyStart);
  }
  const previous = scan.properties[index - 1];
  // Last (or only) property: delete the preceding comma (if any) with it.
  const from = previous !== undefined ? previous.valueEnd : scan.open + 1;
  return text.slice(0, from) + text.slice(property.valueEnd);
}

function insertJsonProperty(
  text: string,
  scan: JsonTopLevelScan,
  key: string,
  renderedValue: string,
  indent: string,
  newline: string,
): string {
  const entry = `${JSON.stringify(key)}: ${renderedValue}`;
  if (scan.properties.length === 0) {
    return `${text.slice(0, scan.open + 1)}${newline}${indent}${entry}${newline}${text.slice(scan.close)}`;
  }
  const last = scan.properties[scan.properties.length - 1]!;
  return `${text.slice(0, last.valueEnd)},${newline}${indent}${entry}${text.slice(last.valueEnd)}`;
}

/** Replace this installer's marker block in `existingText`, or append it. */
export function upsertMarkerBlock(
  existingText: string | undefined,
  block: string,
  start: string,
  end: string,
): string {
  if (existingText === undefined || existingText.trim() === '') return block;
  const startIndex = existingText.indexOf(start);
  const endIndex = existingText.indexOf(end);
  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    const before = existingText.slice(0, startIndex);
    const after = existingText.slice(endIndex + end.length).replace(/^\n/, '');
    return `${before}${block}${after}`;
  }
  return `${existingText.replace(/\n*$/, '\n\n')}${block}`;
}

/** Remove the marker block. `undefined` when nothing (or only whitespace) remains. */
export function stripMarkerBlock(
  existingText: string,
  start: string,
  end: string,
): string | undefined {
  const startIndex = existingText.indexOf(start);
  const endIndex = existingText.indexOf(end);
  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) return existingText;
  const stripped =
    existingText.slice(0, startIndex).replace(/\n+$/, '\n') +
    existingText.slice(endIndex + end.length).replace(/^\n+/, '');
  return stripped.trim() === '' ? undefined : stripped;
}

/* ------------------------------------------------------------------------------------
 * Planning
 * ---------------------------------------------------------------------------------- */

interface PlannedFile {
  /** Display path, relative to the project. */
  readonly name: string;
  readonly path: string;
  readonly content: string;
  readonly exists: boolean;
  readonly unchanged: boolean;
  /** chmod after writing (the cline hook must be executable). */
  readonly mode?: number;
}

interface SkippedFile {
  readonly name: string;
  readonly why: string;
}

interface PlannedRemoval {
  readonly name: string;
  readonly path: string;
  /** `'delete'` removes the file; `'modify'` writes `content` (ours stripped out). */
  readonly action: 'delete' | 'modify';
  readonly content?: string;
}

export interface HooksChoices {
  harnesses: HarnessProfile[];
  guard: boolean;
  statsOnStop: boolean;
  mapOnStart: boolean;
  enforcement: EnforcementMode;
  thresholdBytes: number;
}

interface InstallPlan {
  readonly files: readonly PlannedFile[];
  readonly skipped: readonly SkippedFile[];
  readonly notes: readonly string[];
}

function planFile(cwd: string, name: string, content: string, mode?: number): PlannedFile {
  const path = join(cwd, name);
  const exists = existsSync(path);
  const unchanged = exists && readFileSync(path, 'utf8') === content;
  return { name, path, content, exists, unchanged, ...(mode === undefined ? {} : { mode }) };
}

function readIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

/**
 * Every file `install` would write, computed against the current disk state — pure
 * planning, nothing written. A fold over each chosen profile's `install` list and its
 * instruction layer; all per-harness knowledge is in the profiles. Shared instruction
 * files (several harnesses read AGENTS.md) are planned once.
 *
 * @throws {CliUsageError} when an existing `smelt.config.json` is malformed — the
 *   same refusal every other subcommand makes; an installer that guessed around a
 *   broken config would write settings the guard then ignores.
 */
export function planInstall(cwd: string, choices: HooksChoices): InstallPlan {
  const files = new Map<string, PlannedFile>();
  const skipped: SkippedFile[] = [];
  const notes: string[] = [];

  // -- smelt.config.json: the guard's runtime settings live here, not in any harness
  // file, so every shim reads one source of truth.
  const configPath = findConfigFile(cwd) ?? join(cwd, CONFIG_FILE_NAME);
  const existingConfig =
    readIfExists(configPath) === undefined
      ? undefined
      : parseConfig(readFileSync(configPath, 'utf8'), configPath);
  const hooksBlock: SmeltConfigHooks = {
    thresholdBytes: choices.thresholdBytes,
    enforcement: choices.enforcement,
  };
  const budgetBytes = existingConfig?.defaultBudgetBytes ?? DEFAULT_SUGGESTION_BUDGET_BYTES;
  files.set(configPath, {
    name: portablePath(cwd, configPath),
    path: configPath,
    content: renderConfigWithHooks(existingConfig, hooksBlock),
    exists: existsSync(configPath),
    unchanged: readIfExists(configPath) === renderConfigWithHooks(existingConfig, hooksBlock),
  });

  const ctx: HarnessInstallContext = {
    cwd,
    guard: choices.guard,
    statsOnStop: choices.statsOnStop,
    mapOnStart: choices.mapOnStart,
    thresholdBytes: choices.thresholdBytes,
    budgetBytes,
  };
  const snippet = instructionSnippet(choices.thresholdBytes, budgetBytes);

  const planJsonHooks = (
    name: string,
    events: Record<string, readonly unknown[]>,
    shape: { readonly version?: number } = {},
  ): void => {
    const path = join(cwd, name);
    // Nothing to install and nothing to strip: don't create an empty hooks file.
    if (Object.keys(events).length === 0 && !existsSync(path)) return;
    const merged = mergeJsonHooks(readIfExists(path), events, shape);
    if (merged === undefined) {
      skipped.push({
        name,
        why: 'exists but is not a JSON object — fix or remove it, then re-run',
      });
      return;
    }
    files.set(path, planFile(cwd, name, merged));
  };

  const planBlockFile = (
    name: string,
    block: string,
    start: string,
    end: string,
    skipWhen?: { readonly contains: string; readonly why: string },
  ): void => {
    const path = join(cwd, name);
    if (files.has(path)) return; // a shared file (AGENTS.md), already planned
    const existing = readIfExists(path);
    // A file that already carries its owner's version of what this block does is
    // theirs to edit, not ours: say so, and touch nothing.
    if (
      skipWhen !== undefined &&
      existing !== undefined &&
      !existing.includes(start) &&
      existing.includes(skipWhen.contains)
    ) {
      skipped.push({ name, why: skipWhen.why });
      return;
    }
    files.set(path, planFile(cwd, name, upsertMarkerBlock(existing, block, start, end)));
  };

  for (const profile of choices.harnesses) {
    for (const step of profile.install) {
      switch (step.kind) {
        case 'json-hooks':
          planJsonHooks(
            step.file,
            jsonHookEvents(step, ctx, shimCommand(profile, cwd)),
            step.shape ?? {},
          );
          break;
        case 'marker-block':
          planBlockFile(step.file, step.block(ctx), step.start, step.end, step.skipWhen);
          break;
        case 'own-file':
          if (step.guardOnly && !ctx.guard) break;
          files.set(join(cwd, step.file), planFile(cwd, step.file, step.content(ctx), step.mode));
          break;
      }
    }

    if (profile.instructions === 'snippet') {
      planBlockFile(profile.instructionFile, snippet, SNIPPET_START_MD, SNIPPET_END_MD);
    } else {
      files.set(
        join(cwd, profile.instructionFile),
        planFile(cwd, profile.instructionFile, profile.instructions(ctx)),
      );
    }

    for (const caveat of profile.caveats) notes.push(`${profile.name}: ${caveat}`);
  }

  return { files: [...files.values()], skipped, notes };
}

/** Where the installed config points the persistent store, relative to the config file. */
export const DEFAULT_STORE_DIR = '.smelt/store';

/**
 * Existing config re-rendered with the hooks block, other fields carried verbatim —
 * except that a config with **no** store block gains a directory store. The deny
 * reasons and the instruction snippet teach `smelt retrieve <hash>`, and retrieval
 * across processes needs a persistent store (`smelt retrieve` refuses a memory
 * store, exit 2) — an install whose own guard promises a command the installed
 * config cannot run would be the exact silent-failure shape this project refuses.
 * An *explicit* `{"kind":"memory"}` is respected; the guard then conditions its
 * retrieve promise on the store kind instead (`retrieveSentence` in guard-core).
 *
 * That store injection is this verb's **policy**, which is why it lives here; the
 * bytes are written by `renderConfig` in `config.ts`, the one writer, so a key added
 * to the schema reaches this file and `init`'s together or not at all.
 */
export function renderConfigWithHooks(
  existing: SmeltConfig | undefined,
  hooks: SmeltConfigHooks,
): string {
  return renderConfig({
    smeltConfig: CONFIG_VERSION,
    ...(existing?.defaultBudgetBytes === undefined
      ? {}
      : { defaultBudgetBytes: existing.defaultBudgetBytes }),
    ...(existing?.strategy === undefined ? {} : { strategy: existing.strategy }),
    store: existing?.store ?? { kind: 'directory', path: DEFAULT_STORE_DIR },
    hooks,
  });
}

/**
 * Everything `remove` would delete or strip, computed against the current disk state.
 * The mirror image of {@link planInstall}, over the same data: each install step's
 * kind is also how it comes back out — a JSON hook file is strip-merged, a marker
 * block is stripped, a file that is entirely ours is deleted.
 */
export function planRemove(
  cwd: string,
  harnesses: readonly HarnessProfile[],
): readonly PlannedRemoval[] {
  const removals = new Map<string, PlannedRemoval>();

  const planJsonStrip = (name: string): void => {
    const path = join(cwd, name);
    const existing = readIfExists(path);
    if (existing === undefined) return;
    const stripped = mergeJsonHooks(existing, {});
    if (stripped === undefined || stripped === existing) return;
    const remains: unknown = JSON.parse(stripped);
    const empty =
      typeof remains === 'object' &&
      remains !== null &&
      Object.keys(remains as Record<string, unknown>).filter((key) => key !== 'version').length ===
        0;
    removals.set(
      path,
      empty && existing.includes('hooks')
        ? { name, path, action: 'delete' }
        : { name, path, action: 'modify', content: stripped },
    );
  };

  const planBlockStrip = (name: string, start: string, end: string): void => {
    const path = join(cwd, name);
    const existing = readIfExists(path);
    if (existing === undefined || !existing.includes(start)) return;
    const stripped = stripMarkerBlock(existing, start, end);
    removals.set(
      path,
      stripped === undefined
        ? { name, path, action: 'delete' }
        : { name, path, action: 'modify', content: stripped },
    );
  };

  const planWholeFileDelete = (name: string): void => {
    const path = join(cwd, name);
    const existing = readIfExists(path);
    if (existing === undefined || !existing.includes(OURS_TOKEN)) return;
    removals.set(path, { name, path, action: 'delete' });
  };

  for (const profile of harnesses) {
    for (const step of profile.install) {
      switch (step.kind) {
        case 'json-hooks':
          planJsonStrip(step.file);
          break;
        case 'marker-block':
          planBlockStrip(step.file, step.start, step.end);
          break;
        case 'own-file':
          planWholeFileDelete(step.file);
          break;
      }
    }
    if (profile.instructions === 'snippet') {
      planBlockStrip(profile.instructionFile, SNIPPET_START_MD, SNIPPET_END_MD);
    } else {
      planWholeFileDelete(profile.instructionFile);
    }
  }

  return [...removals.values()];
}

/* ------------------------------------------------------------------------------------
 * The wizard
 * ---------------------------------------------------------------------------------- */

type Asker = (prompt: string) => Promise<string>;

/**
 * `smelt hooks <install|remove>`, start to finish. The same testability pattern as
 * `runInit`: a pure function over an input/output pair, exit code returned.
 */
export async function runHooks(
  action: 'install' | 'remove',
  harnessFlag: string | undefined,
  io: HooksIo,
): Promise<number> {
  // Same adapter, same reason, as `runInit` — see the note there.
  const input = Readable.from(io.input);
  const rl = createInterface({ input });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (prompt: string): Promise<string> => {
    io.output(prompt);
    const next = await lines.next();
    if (next.done === true) {
      throw new CliUsageError(
        `${CLI_NAME} hooks: input ended before the wizard finished. ` +
          `Files already confirmed and written stay; nothing further was written.`,
      );
    }
    return next.value.trim();
  };

  try {
    return action === 'install'
      ? await installFlow(io, ask, harnessFlag)
      : await removeFlow(io, ask, harnessFlag);
  } finally {
    rl.close();
    input.destroy();
  }
}

function resolveHarnessFlag(flag: string): HarnessProfile {
  const profile = harnessById(flag);
  if (profile === undefined) {
    throw new CliUsageError(
      `${CLI_NAME} hooks: unknown harness "${flag}". ` +
        `Known: ${HARNESSES.map((h) => h.id).join(', ')}.`,
    );
  }
  return profile;
}

function tierLabel(profile: HarnessProfile): string {
  return `${profile.id.padEnd(12)} ${profile.name.padEnd(14)} [${profile.tier}] — ${TIER_HONESTY[profile.tier]}`;
}

async function installFlow(
  io: HooksIo,
  ask: Asker,
  harnessFlag: string | undefined,
): Promise<number> {
  const home = io.home ?? homedir();
  const detected = detectedHarnesses(io.cwd, home);

  io.output(
    `${CLI_NAME} hooks install — wires the smelt guard into agent-harness hooks.\n` +
      `Answer \`back\` at any step to return to the previous one. Nothing is written ` +
      `until you confirm at the end.\n\n`,
  );

  const choices: HooksChoices = {
    harnesses: harnessFlag !== undefined ? [resolveHarnessFlag(harnessFlag)] : [...detected],
    ...presetToggles(io.cwd),
    enforcement: 'deny',
    thresholdBytes: DEFAULT_THRESHOLD_BYTES,
  };

  // With --harness the selection step is skipped, so the tier label — and its one
  // line of honesty about what the tier means — is printed here instead.
  if (harnessFlag !== undefined) {
    for (const profile of choices.harnesses) io.output(`  ${tierLabel(profile)}\n`);
  }

  const steps: readonly ((io_: HooksIo, ask_: Asker) => Promise<'ok' | 'back'>)[] = [
    async (io_, ask_) =>
      harnessFlag !== undefined ? 'ok' : stepHarnesses(io_, ask_, choices, detected),
    async (io_, ask_) =>
      stepToggle(io_, ask_, 'PreToolUse size-guard', guardCopy(), choices.guard, (on) => {
        choices.guard = on;
      }),
    async (io_, ask_) =>
      stepToggle(
        io_,
        ask_,
        'stats on Stop',
        `\`smelt stats\` runs when a session ends — the honest signal (expansion rate) ` +
          `surfaced where the turn ends. Observation only; never blocks. Wired for ` +
          `verified-tier harnesses (Claude Code, Codex).`,
        choices.statsOnStop,
        (on) => {
          choices.statsOnStop = on;
        },
      ),
    async (io_, ask_) =>
      stepToggle(
        io_,
        ask_,
        'repo map on SessionStart',
        `\`smelt map . --budget …\` runs at session start and its output opens the ` +
          `context — the agent starts oriented. Costs one map build per session. ` +
          `Wired for verified-tier harnesses (Claude Code, Codex).`,
        choices.mapOnStart,
        (on) => {
          choices.mapOnStart = on;
        },
      ),
    async (io_, ask_) => stepEnforcement(io_, ask_, choices),
    async (io_, ask_) => stepThreshold(io_, ask_, choices),
  ];

  let index = 0;
  for (;;) {
    while (index < steps.length) {
      const outcome = await steps[index]!(io, ask);
      if (outcome === 'back') {
        if (index === 0) io.output(`This is the first step — there is nothing before it.\n`);
        else index -= 1;
      } else {
        index += 1;
      }
    }
    if (choices.harnesses.length === 0) {
      io.output(`No harness selected. Nothing to do; nothing was written.\n`);
      return 0;
    }
    const verdict = await confirmAndInstall(io, ask, choices);
    if (verdict !== 'back') return 0;
    index = steps.length - 1;
  }
}

function guardCopy(): string {
  return (
    `Denies raw Reads (and simple \`cat\`s) of files over the size threshold, with a ` +
    `reason naming the exact \`smelt\` replacement — the model still sees everything: ` +
    `smelted first, \`smelt retrieve\` for the rest. Windowed reads (offset/limit) ` +
    `always pass.`
  );
}

async function stepHarnesses(
  io: HooksIo,
  ask: Asker,
  choices: HooksChoices,
  detected: readonly HarnessProfile[],
): Promise<'ok' | 'back'> {
  io.output(`\nHarnesses — detected by their config directories (project or home):\n`);
  for (const profile of HARNESSES) {
    const mark = detected.includes(profile) ? '*' : ' ';
    io.output(`  ${mark} ${tierLabel(profile)}\n`);
  }
  io.output(`(* = detected here)\n`);
  for (;;) {
    const current = choices.harnesses.map((profile) => profile.id).join(',') || '(none)';
    const answer = await ask(
      `install for which? (comma-separated ids, Enter = ${current}, or back)\n> `,
    );
    if (answer === 'back') return 'back';
    if (answer === '') return 'ok';
    const ids = answer
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id !== '');
    const chosen: HarnessProfile[] = [];
    let bad: string | undefined;
    for (const id of ids) {
      const profile = harnessById(id);
      if (profile === undefined) bad = id;
      else if (!chosen.includes(profile)) chosen.push(profile);
    }
    if (bad !== undefined) {
      io.output(`Unknown harness "${bad}". Known: ${HARNESSES.map((h) => h.id).join(', ')}.\n`);
      continue;
    }
    choices.harnesses = chosen;
    return 'ok';
  }
}

async function stepToggle(
  io: HooksIo,
  ask: Asker,
  name: string,
  copy: string,
  current: boolean,
  set: (on: boolean) => void,
): Promise<'ok' | 'back'> {
  io.output(`\n${name} — ${copy}\n`);
  for (;;) {
    const answer = await ask(`${name}? (on/off) [${current ? 'on' : 'off'}] (or back)> `);
    if (answer === 'back') return 'back';
    if (answer === '') return 'ok';
    if (answer === 'on' || answer === 'off') {
      set(answer === 'on');
      return 'ok';
    }
    io.output(`on, off, or back.\n`);
  }
}

async function stepEnforcement(
  io: HooksIo,
  ask: Asker,
  choices: HooksChoices,
): Promise<'ok' | 'back'> {
  io.output(
    `\nEnforcement — what happens when the guard catches an oversized raw read:\n` +
      `  1. deny     — refuse with a reason naming the exact replacement command. The\n` +
      `                transcript stays truthful; the model runs the replacement itself.\n` +
      `  2. rewrite  — on harnesses whose hooks can modify tool input, substitute the\n` +
      `                replacement in-flight (grep/cat piped through smelt). Never\n` +
      `                silent: the substitution is announced in the decision reason\n` +
      `                where the harness has one, on stderr where it does not.\n` +
      `                Harnesses that cannot rewrite fall back to deny.\n`,
  );
  for (;;) {
    const current = choices.enforcement === 'deny' ? '1' : '2';
    const answer = await ask(`enforcement (1/2) [${current}] (or back)> `);
    if (answer === 'back') return 'back';
    const pick = answer === '' ? current : answer;
    if (pick === '1' || pick === '2') {
      choices.enforcement = pick === '1' ? 'deny' : 'rewrite';
      return 'ok';
    }
    io.output(`1 for deny, 2 for rewrite, or back.\n`);
  }
}

async function stepThreshold(
  io: HooksIo,
  ask: Asker,
  choices: HooksChoices,
): Promise<'ok' | 'back'> {
  io.output(
    `\nSize threshold — reads at or under this many bytes always pass. The ${String(
      DEFAULT_THRESHOLD_BYTES,
    )}-byte default comes from the measured validation in ` +
      `docs/research/2026-09-02-agent-enforcement.md § 5.\n`,
  );
  for (;;) {
    const answer = await ask(`threshold in bytes [${String(choices.thresholdBytes)}] (or back)> `);
    if (answer === 'back') return 'back';
    if (answer === '') return 'ok';
    if (/^\d+$/.test(answer) && Number(answer) > 0) {
      choices.thresholdBytes = Number(answer);
      return 'ok';
    }
    io.output(`A whole number of bytes greater than zero, e.g. 8192.\n`);
  }
}

/**
 * A re-run reads the toggles back off what is actually installed — every JSON hook
 * file this installer writes, plus the guard-only shim files, both derived from the
 * registry — so it edits instead of resetting. Harnesses that only wire the guard
 * (gemini, grok, cursor, hermes, opencode, cline) persist no stats/map entries, so
 * after a re-run scoped to them those toggles read back as off; the defaults below
 * apply only when nothing of smelt's is installed at all.
 */
function presetToggles(cwd: string): Pick<HooksChoices, 'guard' | 'statsOnStop' | 'mapOnStart'> {
  const defaults = { guard: true, statsOnStop: true, mapOnStart: false };
  let anyOurs = false;
  let guard = false;
  let statsOnStop = false;
  let mapOnStart = false;

  for (const name of JSON_HOOK_FILES) {
    const text = readIfExists(join(cwd, name));
    if (text === undefined) continue;
    let hooks: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = JSON.parse(text);
      const hooksValue =
        typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)['hooks']
          : undefined;
      hooks =
        typeof hooksValue === 'object' && hooksValue !== null && !Array.isArray(hooksValue)
          ? (hooksValue as Record<string, unknown>)
          : undefined;
    } catch {
      hooks = undefined;
    }
    if (hooks === undefined) continue;
    const installed = hooks;
    const hasOurs = (event: string): boolean =>
      Array.isArray(installed[event]) &&
      (installed[event] as unknown[]).some((entry) => isOursEntry(entry));
    if (!MANAGED_EVENTS.some((event) => hasOurs(event))) continue;
    anyOurs = true;
    guard ||= GUARD_EVENTS.some((event) => hasOurs(event));
    statsOnStop ||= hasOurs('Stop');
    mapOnStart ||= hasOurs('SessionStart');
  }

  for (const name of GUARD_ONLY_FILES) {
    const text = readIfExists(join(cwd, name));
    if (text !== undefined && text.includes(OURS_TOKEN)) {
      anyOurs = true;
      guard = true;
    }
  }

  return anyOurs ? { guard, statsOnStop, mapOnStart } : defaults;
}

const fileLabel = (file: PlannedFile): string => {
  if (file.unchanged) return 'unchanged — nothing to write';
  return file.exists ? 'exists — will ask before overwriting' : 'new';
};

async function confirmAndInstall(
  io: HooksIo,
  ask: Asker,
  choices: HooksChoices,
): Promise<'done' | 'back'> {
  const plan = planInstall(io.cwd, choices);

  io.output(
    `\nAbout to write, into ${io.cwd}:\n` +
      plan.files.map((file) => `  ${file.name.padEnd(32)} (${fileLabel(file)})\n`).join('') +
      plan.skipped.map((skip) => `  ${skip.name.padEnd(32)} (SKIPPED: ${skip.why})\n`).join('') +
      `Nothing has been written yet.\n`,
  );

  for (;;) {
    const answer = await ask(`confirm (yes / no / back)> `);
    if (answer === 'back') return 'back';
    if (answer === 'no') {
      io.output(`Nothing was written.\n`);
      return 'done';
    }
    if (answer === 'yes') break;
    io.output(`yes to write, no to leave everything untouched, back to change a setting.\n`);
  }

  for (const file of plan.files) {
    if (file.unchanged) {
      io.output(`  ${file.name} — unchanged, not rewritten\n`);
      continue;
    }
    if (file.exists) {
      // The one hard rule, same as `smelt init`: an existing file is never touched
      // without an explicit per-file yes — not `y`, not Enter, a literal `yes`.
      const answer = await ask(`  ${file.name} exists — overwrite it? (yes/no)> `);
      if (answer !== 'yes') {
        io.output(`  skipped ${file.name} — the existing file was not touched\n`);
        continue;
      }
    }
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.content);
    if (file.mode !== undefined) chmodSync(file.path, file.mode);
    io.output(`  wrote ${file.name}\n`);
  }

  for (const note of plan.notes) io.output(`note: ${note}\n`);
  io.output(
    `Done. Re-run \`${CLI_NAME} hooks install\` to edit toggles; ` +
      `\`${CLI_NAME} hooks remove\` takes it all back out.\n`,
  );
  return 'done';
}

async function removeFlow(
  io: HooksIo,
  ask: Asker,
  harnessFlag: string | undefined,
): Promise<number> {
  const harnesses = harnessFlag !== undefined ? [resolveHarnessFlag(harnessFlag)] : [...HARNESSES];
  const removals = planRemove(io.cwd, harnesses);

  if (removals.length === 0) {
    io.output(`${CLI_NAME} hooks remove: nothing of smelt's found to remove in ${io.cwd}.\n`);
    return 0;
  }

  io.output(
    `${CLI_NAME} hooks remove — takes smelt's hook wiring back out.\n\nPlanned:\n` +
      removals
        .map(
          (removal) =>
            `  ${removal.name.padEnd(32)} (${
              removal.action === 'delete' ? 'delete' : 'remove smelt entries, keep the rest'
            })\n`,
        )
        .join('') +
      `${CONFIG_FILE_NAME} is left untouched — its hooks block is your config now; ` +
      `edit or remove it there.\nNothing has been changed yet.\n`,
  );

  for (;;) {
    const answer = await ask(`confirm (yes / no)> `);
    if (answer === 'no') {
      io.output(`Nothing was changed.\n`);
      return 0;
    }
    if (answer === 'yes') break;
    io.output(`yes to proceed, no to leave everything untouched.\n`);
  }

  for (const removal of removals) {
    const verb = removal.action === 'delete' ? 'delete' : 'modify';
    const answer = await ask(`  ${removal.name} — ${verb} it? (yes/no)> `);
    if (answer !== 'yes') {
      io.output(`  skipped ${removal.name} — not touched\n`);
      continue;
    }
    if (removal.action === 'delete') {
      unlinkSync(removal.path);
      io.output(`  deleted ${removal.name}\n`);
    } else {
      writeFileSync(removal.path, removal.content ?? '');
      io.output(`  cleaned ${removal.name}\n`);
    }
  }
  io.output(`Done.\n`);
  return 0;
}
