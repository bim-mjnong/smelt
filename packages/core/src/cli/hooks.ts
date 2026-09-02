import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

import { CliUsageError } from '../errors.ts';
import { DEFAULT_SUGGESTION_BUDGET_BYTES, DEFAULT_THRESHOLD_BYTES } from '../hooks/guard-core.ts';
import type { EnforcementMode } from '../hooks/guard-core.ts';

import { CLI_NAME } from './args.ts';
import { CONFIG_FILE_NAME, CONFIG_VERSION, findConfigFile, parseConfig } from './config.ts';
import type { SmeltConfig, SmeltConfigHooks } from './config.ts';

/**
 * `smelt hooks install` / `smelt hooks remove` — the multi-harness guard preset.
 *
 * The design (KOT-212, founder rulings 2026-09-02): one zero-dependency guard core
 * (`src/hooks/guard-core.ts`), thin per-harness shims mapping each harness's native
 * hook schema onto it, and this installer, which writes the harness config that wires
 * a shim in — plus an instruction-file snippet as belt and braces, because the
 * snippet is also what teaches the model to run `smelt retrieve` after a deny.
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
  readonly input: NodeJS.ReadableStream;
  readonly output: (text: string) => void;
  /** Project directory: detection, config discovery, and every write are relative to it. */
  readonly cwd: string;
  /** Home directory for detection only. Tests point it at a temp dir; nothing writes here. */
  readonly home?: string;
}

export type HarnessTier = 'verified' | 'experimental' | 'advisory';

export type HarnessId =
  | 'claude-code'
  | 'codex'
  | 'gemini'
  | 'grok'
  | 'hermes'
  | 'cursor'
  | 'opencode'
  | 'cline'
  | 'kilocode'
  | 'aider';

export interface HarnessSpec {
  readonly id: HarnessId;
  readonly name: string;
  readonly tier: HarnessTier;
  /** Paths (relative to the project) whose existence means "this harness is in use here". */
  readonly detect: readonly string[];
  /** Paths relative to the user's home directory — "installed on this machine". */
  readonly detectHome: readonly string[];
  /** The standing-instructions file this harness reads (capability matrix column d). */
  readonly instructionFile: string;
  /** Caveats carried from the capability matrix, shown at install time. */
  readonly caveats: readonly string[];
}

/** One line of honesty per tier, shown wherever a tier label appears. */
export const TIER_HONESTY: Record<HarnessTier, string> = {
  verified: 'schema verified against primary docs and pinned by fixtures',
  experimental:
    'schema mapped from the 2026-09-02 capability matrix, not yet smoke-tested against the real binary',
  advisory: 'no usable hook API — instructions only, nothing enforces them',
};

export const HARNESSES: readonly HarnessSpec[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    tier: 'verified',
    detect: ['.claude'],
    detectHome: ['.claude'],
    instructionFile: 'CLAUDE.md',
    caveats: [],
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    tier: 'verified',
    detect: ['.codex'],
    detectHome: ['.codex'],
    instructionFile: 'AGENTS.md',
    caveats: [
      'project-level Codex hooks run only once the project is trusted (features.hooks; see docs/research/2026-09-02-agent-enforcement.md § 3)',
    ],
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    tier: 'experimental',
    detect: ['.gemini'],
    detectHome: ['.gemini'],
    instructionFile: 'GEMINI.md',
    caveats: [
      'Gemini policy-engine allow rules are ignored in non-interactive runs (google-gemini/gemini-cli#20469) — verify hook behaviour in CI before relying on it',
    ],
  },
  {
    id: 'grok',
    name: 'Grok CLI',
    tier: 'experimental',
    detect: ['.grok'],
    detectHome: ['.grok'],
    instructionFile: 'AGENTS.md',
    caveats: [
      'deny-only hooks: input rewrite is not supported, so rewrite mode falls back to deny',
    ],
  },
  {
    id: 'hermes',
    name: 'Hermes Agent',
    tier: 'experimental',
    detect: ['.hermes', '.hermes.md'],
    detectHome: ['.hermes'],
    instructionFile: 'AGENTS.md',
    caveats: [
      'Hermes memory tools bypass disabled_toolsets (NousResearch/hermes-agent#46171) — treat tool gating there as leaky',
      'hook config may need merging into ~/.hermes/config.yaml by hand; the written file says how',
    ],
  },
  {
    id: 'cursor',
    name: 'Cursor',
    tier: 'experimental',
    detect: ['.cursor'],
    detectHome: ['.cursor'],
    instructionFile: 'AGENTS.md',
    caveats: ['Cursor has no static permission config — gating is entirely hook code'],
  },
  {
    id: 'opencode',
    name: 'opencode',
    tier: 'experimental',
    detect: ['.opencode', 'opencode.json'],
    detectHome: ['.config/opencode'],
    instructionFile: 'AGENTS.md',
    caveats: [
      'MCP tools can bypass opencode plugin hooks (sst/opencode#2319) — the guard sees built-in tools only',
    ],
  },
  {
    id: 'cline',
    name: 'Cline',
    tier: 'experimental',
    detect: ['.clinerules'],
    detectHome: [],
    instructionFile: '.clinerules/smelt.md',
    caveats: [
      'deny-only hooks: input rewrite is not supported, so rewrite mode falls back to deny',
    ],
  },
  {
    id: 'kilocode',
    name: 'KiloCode',
    tier: 'advisory',
    detect: ['.kilocode'],
    detectHome: ['.config/kilo'],
    instructionFile: '.kilocode/rules/smelt.md',
    caveats: [
      'no first-class hooks (Kilo-Org/kilocode#5827): enforcement is permissions config + MCP, both manual',
    ],
  },
  {
    id: 'aider',
    name: 'Aider',
    tier: 'advisory',
    detect: ['.aider.conf.yml'],
    detectHome: ['.aider.conf.yml'],
    instructionFile: 'CONVENTIONS.md',
    caveats: [
      'Aider auto-reads no rules file: add `read: CONVENTIONS.md` to .aider.conf.yml (or pass --read CONVENTIONS.md) yourself',
    ],
  },
];

export function harnessById(id: string): HarnessSpec | undefined {
  return HARNESSES.find((spec) => spec.id === id);
}

/** A harness whose config directory exists in the project or the home directory. */
export function detectedHarnesses(cwd: string, home: string): readonly HarnessSpec[] {
  return HARNESSES.filter(
    (spec) =>
      spec.detect.some((path) => existsSync(join(cwd, path))) ||
      spec.detectHome.some((path) => existsSync(join(home, path))),
  );
}

/* ------------------------------------------------------------------------------------
 * Paths and commands
 * ---------------------------------------------------------------------------------- */

/**
 * The `dist` directory of this installed package — where the shipped guard-core and
 * shim scripts live. Computed from this module's own location, which is
 * `<pkg>/dist/cli/` in every real run (the CLI executes from `dist`); under the test
 * runner it is `<pkg>/src/cli/`, and the substitution still points at `dist`, which
 * is where the scripts will exist once built — the paths are written into config
 * files for *node* to execute, never imported.
 */
function packageDistDir(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // <pkg>/(dist|src)/cli
  return join(dirname(dirname(here)), 'dist');
}

function shimScriptPath(id: HarnessId): string {
  return join(packageDistDir(), 'hooks', 'shims', `${id}.js`);
}

function guardCoreScriptPath(): string {
  return join(packageDistDir(), 'hooks', 'guard-core.js');
}

function smeltBinPath(): string {
  return join(packageDistDir(), 'cli', 'bin.js');
}

/** Inside the project, a project-relative path travels with the repo; outside, absolute. */
function portablePath(cwd: string, absolute: string): string {
  const rel = relative(cwd, absolute);
  return rel.startsWith('..') || isAbsolute(rel) ? absolute : rel.split(sep).join('/');
}

function nodeCommand(cwd: string, script: string, args = ''): string {
  return `node "${portablePath(cwd, script)}"${args === '' ? '' : ` ${args}`}`;
}

/* ------------------------------------------------------------------------------------
 * Generated content
 * ---------------------------------------------------------------------------------- */

/** Marker lines bracketing every block this installer owns inside a shared file. */
export const SNIPPET_START_MD = '<!-- smelt:hooks v1 start -->';
export const SNIPPET_END_MD = '<!-- smelt:hooks v1 end -->';
const SNIPPET_START_HASH = '# smelt:hooks v1 start';
const SNIPPET_END_HASH = '# smelt:hooks v1 end';

/** Substring that identifies a file (or JSON hook entry) as written by this installer. */
const OURS_TOKEN = 'smelt:hooks';

/**
 * The instruction snippet — belt and braces under every shim, and the *only* layer
 * for advisory harnesses. It teaches the three commands, and in particular what to do
 * after a guard deny: run the named replacement, then `smelt retrieve` per marker.
 */
export function instructionSnippet(thresholdBytes: number, budgetBytes: number): string {
  return `${SNIPPET_START_MD}

## smelt — context discipline

This project uses [smelt](https://github.com/smeltjs/smelt) to keep large tool output
out of the context window, reversibly.

- Do not read files over ${String(thresholdBytes)} bytes raw. Run
  \`smelt <file> --budget ${String(budgetBytes)} --focus <what you are looking for>\`
  instead (repeat \`--focus\` per term). Focused regions survive verbatim; everything
  else collapses into a one-line marker stating what was removed.
- Every marker ends in \`retrieve("hash")\`. \`smelt retrieve <hash>\` prints the
  exact original bytes back. Retrieve what you actually need — retrievals are counted,
  and \`smelt stats\` reports the honest expansion rate.
- For orientation, \`smelt map . --budget ${String(budgetBytes)}\` prints a ranked
  symbol map of the repository.
- If a smelt guard hook denies a raw read, run the exact replacement command named in
  the denial, then \`smelt retrieve\` any marker you need expanded.

${SNIPPET_END_MD}
`;
}

/** Claude-style hook entry: one command under an optional matcher. */
function commandEntry(matcher: string | undefined, command: string): unknown {
  return {
    ...(matcher === undefined ? {} : { matcher }),
    hooks: [{ type: 'command', command }],
  };
}

interface PresetContext {
  readonly cwd: string;
  readonly guard: boolean;
  readonly statsOnStop: boolean;
  readonly mapOnStart: boolean;
  readonly budgetBytes: number;
}

/** The three preset hooks in Claude Code's schema; Codex's hooks.json mirrors it. */
function claudeStyleEvents(
  ctx: PresetContext,
  shim: HarnessId,
  preToolEvent: string,
  matchers: { readonly read: string; readonly bash: string },
): Record<string, readonly unknown[]> {
  const shimCommand = nodeCommand(ctx.cwd, shimScriptPath(shim));
  const stats = `${nodeCommand(ctx.cwd, smeltBinPath(), 'stats')} 2>/dev/null || true`;
  const map = `${nodeCommand(
    ctx.cwd,
    smeltBinPath(),
    `map . --budget ${String(ctx.budgetBytes)} --cache .smelt/tags`,
  )} 2>/dev/null || true`;

  return {
    ...(ctx.guard
      ? {
          [preToolEvent]: [
            commandEntry(matchers.read, shimCommand),
            commandEntry(matchers.bash, shimCommand),
          ],
        }
      : {}),
    ...(ctx.statsOnStop ? { Stop: [commandEntry(undefined, stats)] } : {}),
    ...(ctx.mapOnStart
      ? { SessionStart: [commandEntry('startup|resume|clear|compact', map)] }
      : {}),
  };
}

/** True for a hook entry this installer wrote (its command names our shipped scripts). */
function isOursEntry(entry: unknown): boolean {
  const text = JSON.stringify(entry) ?? '';
  return (
    text.includes('hooks/shims/') ||
    text.includes('hooks/guard-core.js') ||
    text.includes('cli/bin.js')
  );
}

/** The events this installer manages; foreign entries under them are always preserved. */
const MANAGED_EVENTS = ['PreToolUse', 'Stop', 'SessionStart', 'BeforeTool', 'preToolUse'];

/**
 * Merge our hook entries into a JSON settings file, preserving everything foreign:
 * unknown top-level keys, unmanaged events, and other people's entries under managed
 * events all ride through byte-comparable. Our previous entries are replaced (that is
 * what makes a re-run edit toggles), and events left with no entries disappear.
 * Returns `undefined` when the existing file is not a JSON object — the caller skips
 * the file rather than clobbering something it cannot understand.
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
  const hooks =
    typeof hooksValue === 'object' && hooksValue !== null && !Array.isArray(hooksValue)
      ? { ...(hooksValue as Record<string, unknown>) }
      : {};

  for (const event of MANAGED_EVENTS) {
    const existing = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    const foreign = existing.filter((entry) => !isOursEntry(entry));
    const ours = events[event] ?? [];
    const merged = [...foreign, ...ours];
    if (merged.length > 0) hooks[event] = merged;
    else delete hooks[event];
  }

  if (Object.keys(hooks).length > 0) root['hooks'] = hooks;
  else delete root['hooks'];
  if (shape.version !== undefined && root['version'] === undefined) root['version'] = shape.version;
  return `${JSON.stringify(root, null, 2)}\n`;
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

/** The Codex `config.toml` block: enables the hooks feature, marker-bracketed. */
function codexConfigTomlBlock(): string {
  return `${SNIPPET_START_HASH}
# Enables Codex's hooks feature so .codex/hooks.json is honored. Project-level hooks
# run only once this project is trusted. Written by \`smelt hooks install\`.
[features]
hooks = true
${SNIPPET_END_HASH}
`;
}

/** The opencode plugin — the shim for a harness whose hooks are a JS plugin API. */
function opencodePluginSource(cwd: string): string {
  const guardCore = portablePath(cwd, guardCoreScriptPath());
  return `// smelt:hooks v1 — opencode plugin shim. EXPERIMENTAL tier: mapped from the
// capability matrix (docs/research/2026-09-02-harness-capability-matrix.md, opencode
// row; https://opencode.ai/docs/plugins/). This template's deny/pass/window paths
// were exercised directly against the built guard core (KOT-212 verification,
// 2026-09-02), but a live opencode session has not been smoke-tested — that needs
// provider credentials. Caveat carried from the matrix: MCP tools can bypass plugin
// hooks (sst/opencode#2319) — this guard sees built-in tools only.
//
// Thin adapter: maps tool.execute.before onto the smelt guard core (zero
// dependencies), which owns every decision. Deny mode throws (opencode surfaces the
// reason to the model); rewrite mode substitutes the faithful replacement command.
import { pathToFileURL } from 'node:url';

const GUARD_CORE = ${JSON.stringify(guardCore)};
const core = await import(pathToFileURL(GUARD_CORE).href);

export const SmeltGuard = async () => ({
  'tool.execute.before': async (input, output) => {
    const tool = input?.tool;
    const args = output?.args ?? {};
    let request;
    if (tool === 'read' && typeof args.filePath === 'string') {
      request = {
        tool: 'Read',
        input: {
          path: args.filePath,
          offsetLimited: args.offset !== undefined || args.limit !== undefined,
        },
      };
    } else if (tool === 'bash' && typeof args.command === 'string') {
      request = { tool: 'Bash', input: { command: args.command } };
    } else {
      return;
    }
    const warn = (text) => process.stderr.write(text + '\\n');
    const settings = core.readGuardSettings(process.cwd(), warn);
    const decision = core.decide(request, settings, process.cwd());
    if (decision.action !== 'deny') return;
    if (
      settings.enforcement === 'rewrite' &&
      request.tool === 'Bash' &&
      decision.suggestion !== undefined
    ) {
      output.args.command = decision.suggestion;
      return;
    }
    throw new Error(decision.reason ?? 'denied by the smelt guard');
  },
});
`;
}

/** Cline's hook is an executable file; this two-liner hands it to the cline shim. */
function clineHookSource(cwd: string): string {
  return `#!/bin/sh
# smelt:hooks v1 — Cline PreToolUse hook. EXPERIMENTAL tier: schema mapped from the
# capability matrix (docs/research/2026-09-02-harness-capability-matrix.md, Cline row),
# not yet smoke-tested against the real binary. Written by \`smelt hooks install\`.
exec node "${portablePath(cwd, shimScriptPath('cline'))}"
`;
}

/** Hermes hook config, as a mergeable snippet — their config is a home-level YAML. */
function hermesHooksYaml(cwd: string): string {
  return `${SNIPPET_START_HASH}
# Hermes Agent hook config for the smelt guard. EXPERIMENTAL tier: schema mapped from
# the capability matrix (docs/research/2026-09-02-harness-capability-matrix.md, Hermes
# row), not yet smoke-tested against the real binary. If Hermes does not read this
# file directly, merge the \`hooks:\` section into ~/.hermes/config.yaml.
hooks:
  pre_tool_call:
    - command: node "${portablePath(cwd, shimScriptPath('hermes'))}"
${SNIPPET_END_HASH}
`;
}

/** KiloCode's advisory rules file: the snippet plus the two manual enforcement legs. */
function kilocodeRulesSource(thresholdBytes: number, budgetBytes: number): string {
  return `${instructionSnippet(thresholdBytes, budgetBytes)}
<!-- smelt:hooks v1 advisory notes -->

KiloCode has no first-class hook API (Kilo-Org/kilocode#5827), so nothing above is
enforced — it is advisory. Two manual legs make it harder to bypass:

1. Permissions: in your KiloCode per-tool permission config, set raw-read/execute
   tools to "ask" so oversized reads surface for review instead of passing silently.
2. MCP: expose smelt through an MCP server and prefer its tools; a resident server
   also keeps smelt's grammar cache warm across calls.
`;
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
  harnesses: HarnessSpec[];
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
 * planning, nothing written. Shared instruction files (several harnesses read
 * AGENTS.md) are planned once.
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

  const ctx: PresetContext = {
    cwd,
    guard: choices.guard,
    statsOnStop: choices.statsOnStop,
    mapOnStart: choices.mapOnStart,
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

  const planSnippetFile = (name: string): void => {
    const path = join(cwd, name);
    if (files.has(path)) return; // shared instruction file, already planned
    files.set(
      path,
      planFile(
        cwd,
        name,
        upsertMarkerBlock(readIfExists(path), snippet, SNIPPET_START_MD, SNIPPET_END_MD),
      ),
    );
  };

  for (const spec of choices.harnesses) {
    switch (spec.id) {
      case 'claude-code': {
        planJsonHooks(
          '.claude/settings.json',
          claudeStyleEvents(ctx, 'claude-code', 'PreToolUse', { read: 'Read', bash: 'Bash' }),
        );
        break;
      }
      case 'codex': {
        planJsonHooks(
          '.codex/hooks.json',
          claudeStyleEvents(ctx, 'codex', 'PreToolUse', { read: 'Read', bash: 'Bash' }),
        );
        const tomlPath = join(cwd, '.codex/config.toml');
        const existingToml = readIfExists(tomlPath);
        if (
          existingToml !== undefined &&
          !existingToml.includes(SNIPPET_START_HASH) &&
          existingToml.includes('[features]')
        ) {
          skipped.push({
            name: '.codex/config.toml',
            why: 'already has a [features] table — add `hooks = true` to it yourself',
          });
        } else {
          files.set(
            tomlPath,
            planFile(
              cwd,
              '.codex/config.toml',
              upsertMarkerBlock(
                existingToml,
                codexConfigTomlBlock(),
                SNIPPET_START_HASH,
                SNIPPET_END_HASH,
              ),
            ),
          );
        }
        break;
      }
      case 'gemini': {
        planJsonHooks(
          '.gemini/settings.json',
          ctx.guard
            ? {
                BeforeTool: [
                  commandEntry('read_file', nodeCommand(cwd, shimScriptPath('gemini'))),
                  commandEntry('run_shell_command', nodeCommand(cwd, shimScriptPath('gemini'))),
                ],
              }
            : {},
        );
        break;
      }
      case 'grok': {
        planJsonHooks(
          '.grok/hooks.json',
          ctx.guard
            ? {
                PreToolUse: [
                  commandEntry('Read', nodeCommand(cwd, shimScriptPath('grok'))),
                  commandEntry('Bash', nodeCommand(cwd, shimScriptPath('grok'))),
                ],
              }
            : {},
        );
        break;
      }
      case 'hermes': {
        if (ctx.guard) {
          files.set(
            join(cwd, '.hermes/hooks.yaml'),
            planFile(cwd, '.hermes/hooks.yaml', hermesHooksYaml(cwd)),
          );
        }
        break;
      }
      case 'cursor': {
        planJsonHooks(
          '.cursor/hooks.json',
          ctx.guard
            ? { preToolUse: [{ command: nodeCommand(cwd, shimScriptPath('cursor')) }] }
            : {},
          { version: 1 },
        );
        break;
      }
      case 'opencode': {
        if (ctx.guard) {
          files.set(
            join(cwd, '.opencode/plugin/smelt-guard.js'),
            planFile(cwd, '.opencode/plugin/smelt-guard.js', opencodePluginSource(cwd)),
          );
        }
        break;
      }
      case 'cline': {
        if (ctx.guard) {
          files.set(
            join(cwd, '.clinerules/hooks/PreToolUse'),
            planFile(cwd, '.clinerules/hooks/PreToolUse', clineHookSource(cwd), 0o755),
          );
        }
        break;
      }
      case 'kilocode': {
        files.set(
          join(cwd, spec.instructionFile),
          planFile(
            cwd,
            spec.instructionFile,
            kilocodeRulesSource(choices.thresholdBytes, budgetBytes),
          ),
        );
        break;
      }
      case 'aider':
        break; // instruction file only, planned below
    }
    if (spec.id !== 'kilocode') planSnippetFile(spec.instructionFile);

    for (const caveat of spec.caveats) notes.push(`${spec.name}: ${caveat}`);
  }

  return { files: [...files.values()], skipped, notes };
}

/** Existing config re-rendered with the hooks block, other fields carried verbatim. */
export function renderConfigWithHooks(
  existing: SmeltConfig | undefined,
  hooks: SmeltConfigHooks,
): string {
  const config: SmeltConfig = {
    smeltConfig: CONFIG_VERSION,
    ...(existing?.defaultBudgetBytes === undefined
      ? {}
      : { defaultBudgetBytes: existing.defaultBudgetBytes }),
    ...(existing?.strategy === undefined ? {} : { strategy: existing.strategy }),
    ...(existing?.store === undefined ? {} : { store: existing.store }),
    hooks,
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** Everything `remove` would delete or strip, computed against the current disk state. */
export function planRemove(
  cwd: string,
  harnesses: readonly HarnessSpec[],
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

  for (const spec of harnesses) {
    switch (spec.id) {
      case 'claude-code':
        planJsonStrip('.claude/settings.json');
        break;
      case 'codex':
        planJsonStrip('.codex/hooks.json');
        planBlockStrip('.codex/config.toml', SNIPPET_START_HASH, SNIPPET_END_HASH);
        break;
      case 'gemini':
        planJsonStrip('.gemini/settings.json');
        break;
      case 'grok':
        planJsonStrip('.grok/hooks.json');
        break;
      case 'hermes':
        planWholeFileDelete('.hermes/hooks.yaml');
        break;
      case 'cursor':
        planJsonStrip('.cursor/hooks.json');
        break;
      case 'opencode':
        planWholeFileDelete('.opencode/plugin/smelt-guard.js');
        break;
      case 'cline':
        planWholeFileDelete('.clinerules/hooks/PreToolUse');
        break;
      case 'kilocode':
      case 'aider':
        break;
    }
    if (spec.id === 'kilocode') planWholeFileDelete(spec.instructionFile);
    else planBlockStrip(spec.instructionFile, SNIPPET_START_MD, SNIPPET_END_MD);
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
  const rl = createInterface({ input: io.input });
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
  }
}

function resolveHarnessFlag(flag: string): HarnessSpec {
  const spec = harnessById(flag);
  if (spec === undefined) {
    throw new CliUsageError(
      `${CLI_NAME} hooks: unknown harness "${flag}". ` +
        `Known: ${HARNESSES.map((h) => h.id).join(', ')}.`,
    );
  }
  return spec;
}

function tierLabel(spec: HarnessSpec): string {
  return `${spec.id.padEnd(12)} ${spec.name.padEnd(14)} [${spec.tier}] — ${TIER_HONESTY[spec.tier]}`;
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
    for (const spec of choices.harnesses) io.output(`  ${tierLabel(spec)}\n`);
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
  detected: readonly HarnessSpec[],
): Promise<'ok' | 'back'> {
  io.output(`\nHarnesses — detected by their config directories (project or home):\n`);
  for (const spec of HARNESSES) {
    const mark = detected.includes(spec) ? '*' : ' ';
    io.output(`  ${mark} ${tierLabel(spec)}\n`);
  }
  io.output(`(* = detected here)\n`);
  for (;;) {
    const current = choices.harnesses.map((spec) => spec.id).join(',') || '(none)';
    const answer = await ask(
      `install for which? (comma-separated ids, Enter = ${current}, or back)\n> `,
    );
    if (answer === 'back') return 'back';
    if (answer === '') return 'ok';
    const ids = answer
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id !== '');
    const specs: HarnessSpec[] = [];
    let bad: string | undefined;
    for (const id of ids) {
      const spec = harnessById(id);
      if (spec === undefined) bad = id;
      else if (!specs.includes(spec)) specs.push(spec);
    }
    if (bad !== undefined) {
      io.output(`Unknown harness "${bad}". Known: ${HARNESSES.map((h) => h.id).join(', ')}.\n`);
      continue;
    }
    choices.harnesses = specs;
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
      `                silent: the substitution is announced in the decision reason.\n` +
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

/** A re-run reads the toggles back off `.claude/settings.json`, so it edits, not resets. */
function presetToggles(cwd: string): Pick<HooksChoices, 'guard' | 'statsOnStop' | 'mapOnStart'> {
  const defaults = { guard: true, statsOnStop: true, mapOnStart: false };
  const text = readIfExists(join(cwd, '.claude/settings.json'));
  if (text === undefined) return defaults;
  try {
    const parsed: unknown = JSON.parse(text);
    const hooks =
      typeof parsed === 'object' && parsed !== null
        ? ((parsed as Record<string, unknown>)['hooks'] as Record<string, unknown> | undefined)
        : undefined;
    if (hooks === undefined || typeof hooks !== 'object') return defaults;
    const hasOurs = (event: string): boolean =>
      Array.isArray(hooks[event]) &&
      (hooks[event] as unknown[]).some((entry) => isOursEntry(entry));
    const anyOurs = MANAGED_EVENTS.some((event) => hasOurs(event));
    if (!anyOurs) return defaults;
    return {
      guard: hasOurs('PreToolUse'),
      statsOnStop: hasOurs('Stop'),
      mapOnStart: hasOurs('SessionStart'),
    };
  } catch {
    return defaults;
  }
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
