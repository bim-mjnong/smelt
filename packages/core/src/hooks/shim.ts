import process from 'node:process';

import { decide, isMainModule, readAllOfStdin, readGuardSettings } from './guard-core.ts';
import type { GuardDecision, GuardRequest, GuardSettings } from './guard-core.ts';

/**
 * The shim runtime — the one loop every per-harness shim runs.
 *
 * A shim is a thin adapter: it maps its harness's native PreToolUse stdin schema
 * onto a {@link GuardRequest}, hands that to the guard core, and renders the
 * {@link GuardDecision} back in the harness's native output schema. All policy —
 * threshold, windows, suggestion rendering, enforcement mode — lives in
 * `guard-core.ts`; a shim that grew an opinion of its own would be a second guard
 * that drifts from the first.
 *
 * Most of a shim is a *table*, not code: which tool names mean read and shell, which
 * payload keys carry them, and the two documents the harness's schema wants back. That
 * table is a {@link HarnessHookSchema}, `shimFromSchema` turns one into a
 * {@link ShimAdapter}, and every harness's schema lives in its profile
 * (`src/harness/<id>.ts`). {@link ShimAdapter} stays public as the escape hatch for a
 * harness a table cannot express.
 *
 * The enforcement gate lives here, once, because it is the same for every harness:
 *
 *  - **deny mode (the default)**: a deny is rendered as the harness's deny, with the
 *    guard's steering reason. The transcript stays truthful — the model sees what it
 *    asked for refused and why, and learns to run the replacement (and
 *    `smelt retrieve`) itself.
 *  - **rewrite mode (`hooks.enforcement: "rewrite"` in smelt.config.json)**: when the
 *    denied call is a Bash command, the guard produced a faithful executable
 *    `suggestion`, and this harness can modify tool input, the shim substitutes the
 *    suggestion instead of denying. A harness that cannot rewrite falls back to the
 *    deny — with the exact command in the reason — so rewrite mode never silently
 *    weakens into nothing. A substitution is always announced: in the decision
 *    reason where the harness's rewrite schema carries one (Claude Code, Codex),
 *    and on stderr where it does not (Gemini, Cursor, Hermes, the opencode
 *    plugin) — a rewrite nobody can see would change what the model asked for
 *    without telling anyone. And a shim never rewrites in deny mode: a silent
 *    rewrite changes what the model asked for without telling it, which is this
 *    project's signature failure shape applied to the harness.
 */

/** What one harness shim supplies. Everything else is {@link runShim}'s. */
export interface ShimAdapter {
  /** Map the harness's raw stdin JSON to a guard request; `undefined` = pass through. */
  readonly toRequest: (raw: unknown) => GuardRequest | undefined;
  /**
   * The working directory tool-relative paths resolve against, read from the raw
   * payload when the harness sends one (Claude Code's hook stdin carries `cwd`: the
   * *session's* Bash cwd, which after a `cd` differs from this hook process's own).
   * `undefined` falls back to the shim process's cwd.
   */
  readonly cwd?: (raw: unknown) => string | undefined;
  /** Render an allow. Most harnesses: empty stdout, exit 0. */
  readonly pass: () => ShimOutput;
  /** Render a deny, in the harness's schema. */
  readonly deny: (raw: unknown, request: GuardRequest, decision: GuardDecision) => ShimOutput;
  /**
   * Render an input rewrite (only ever called for a Bash-shaped request whose
   * decision carries a faithful `suggestion`, and only in rewrite mode). Omit on
   * harnesses whose hook schema cannot modify tool input — they deny instead. A
   * schema with no reason channel must announce the substitution via `stderr`.
   */
  readonly rewrite?: (raw: unknown, request: GuardRequest, decision: GuardDecision) => ShimOutput;
}

/** What a shim writes and how it exits. `stdout` is a complete JSON line or ''. */
export interface ShimOutput {
  readonly stdout: string;
  /** Written to the shim process's stderr — the announcement channel for harnesses
   * whose rewrite schema has no reason field. Never a decision by itself. */
  readonly stderr?: string;
  readonly exitCode: number;
}

/** The pure half of the shim loop, for tests: raw harness input → rendered output. */
export function renderShimDecision(
  adapter: ShimAdapter,
  raw: unknown,
  settings: GuardSettings,
  cwd: string,
  statFile?: Parameters<typeof decide>[3],
): ShimOutput {
  const request = adapter.toRequest(raw);
  if (request === undefined) return adapter.pass();
  const effectiveCwd = adapter.cwd?.(raw) ?? cwd;
  const decision =
    statFile === undefined
      ? decide(request, settings, effectiveCwd)
      : decide(request, settings, effectiveCwd, statFile);
  if (decision.action === 'allow') return adapter.pass();
  if (
    settings.enforcement === 'rewrite' &&
    adapter.rewrite !== undefined &&
    request.tool === 'Bash' &&
    decision.suggestion !== undefined
  ) {
    return adapter.rewrite(raw, request, decision);
  }
  return adapter.deny(raw, request, decision);
}

/**
 * The whole shim as a process: read the harness's stdin, decide, render, exit.
 * Fail open exactly like the guard core — unparseable stdin passes with a stderr
 * warning, and an unexpected error passes too. A shim crash must never read as a
 * policy decision.
 */
export function runShimMain(adapter: ShimAdapter): void {
  let output: ShimOutput;
  try {
    const text = readAllOfStdin();
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      process.stderr.write(
        `smelt shim: stdin was not JSON — allowing the call. Fix the hook wiring.\n`,
      );
      raw = undefined;
    }
    if (raw === undefined) {
      output = adapter.pass();
    } else {
      const settings = readGuardSettings(process.cwd(), (text_) =>
        process.stderr.write(`${text_}\n`),
      );
      output = renderShimDecision(adapter, raw, settings, process.cwd());
    }
  } catch (error) {
    process.stderr.write(
      `smelt shim: unexpected error — allowing the call. ` +
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    output = adapter.pass();
  }
  if (output.stderr !== undefined && output.stderr !== '') process.stderr.write(output.stderr);
  if (output.stdout !== '') process.stdout.write(output.stdout);
  process.exitCode = output.exitCode;
}

/**
 * Map one `{tool name, tool input}` pair — the shape every surveyed harness feeds its
 * pre-tool hook, under varying key spellings — onto a {@link GuardRequest}.
 * `undefined` for tools the guard has no opinion on: pass through.
 */
export function toolCallRequest(
  toolName: unknown,
  toolInput: unknown,
  names: { readonly read: readonly string[]; readonly bash: readonly string[] },
): GuardRequest | undefined {
  if (typeof toolName !== 'string') return undefined;
  const input =
    typeof toolInput === 'object' && toolInput !== null && !Array.isArray(toolInput)
      ? (toolInput as Record<string, unknown>)
      : {};

  if (names.read.includes(toolName)) {
    const path = firstString(input, ['file_path', 'path', 'absolute_path', 'filePath']);
    if (path === undefined) return undefined;
    const offsetLimited =
      firstDefined(input, ['offset', 'limit', 'start_line', 'end_line']) !== undefined;
    return { tool: 'Read', input: { path, offsetLimited } };
  }
  if (names.bash.includes(toolName)) {
    const command = firstString(input, ['command']);
    if (command === undefined) return undefined;
    return { tool: 'Bash', input: { command } };
  }
  return undefined;
}

function firstString(input: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

function firstDefined(input: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (input[key] !== undefined && input[key] !== null) return input[key];
  }
  return undefined;
}

/** The raw stdin as a keyed record, or an empty record when it is not object-shaped. */
export function asRecord(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

/* ------------------------------------------------------------------------------------
 * The hook schema, as data
 * ---------------------------------------------------------------------------------- */

/**
 * One harness's pre-tool hook schema — everything that varies between shims, as a
 * table. Everything that does not vary (the tool mapping, the rewrite-input splice,
 * the announcement, the deny fallback) belongs to {@link shimFromSchema} and exists
 * exactly once.
 *
 * A schema states capability, never invents it: a harness whose hook cannot modify
 * tool input simply omits {@link rewrite}, and `renderShimDecision` then falls back to
 * the deny — whose reason still carries the exact replacement command.
 */
export interface HarnessHookSchema {
  /** Tool names this harness spells a file read with. */
  readonly readTools: readonly string[];
  /** Tool names this harness spells a shell command with. */
  readonly bashTools: readonly string[];
  /**
   * Where the tool name lives in the raw payload, in priority order — harnesses
   * disagree about the spelling (`tool_name`, `toolName`), and some nest the call.
   * A dotted key reads through one level of nesting (`preToolUse.toolName`).
   */
  readonly toolNameKeys: readonly string[];
  /** Where the tool's input object lives, same rules as {@link toolNameKeys}. */
  readonly toolInputKeys: readonly string[];
  /**
   * The payload key carrying the working directory relative paths resolve against,
   * for the harnesses that send one (Claude Code's hook stdin carries the *session's*
   * cwd, which after a `cd` differs from the hook process's own). Absent = the shim
   * process's cwd.
   */
  readonly cwdKey?: string;
  /** The harness's deny document, with the guard's steering reason in its one slot. */
  readonly deny: (reason: string) => unknown;
  /** The harness's input-rewrite document. Absent on a deny-only harness. */
  readonly rewrite?: HarnessRewriteSchema;
}

/** What a rewrite renders, and where the substitution is announced. */
export interface HarnessRewriteSchema {
  /** The rewrite document this harness's schema wants back. */
  readonly document: (rewrite: RewriteSlots) => unknown;
  /**
   * Where the substitution is announced. `'reason'` when the document carries a
   * reason channel the model reads (the template puts {@link RewriteSlots.announcement}
   * there); `'stderr'` when it does not — a rewrite nobody can see would change what
   * the model asked for without telling anyone.
   */
  readonly announce: 'reason' | 'stderr';
}

/** What a rewrite document is built from. Filled in by {@link shimFromSchema}. */
export interface RewriteSlots {
  /**
   * The tool's own input with `command` replaced by the suggestion — the splice every
   * rewriting harness needs, and which four shims used to carry verbatim. Harnesses
   * whose rewrite is a shallow merge send only the changed key instead.
   */
  readonly input: Record<string, unknown>;
  /** The replacement command itself. */
  readonly suggestion: string;
  /** The announcement, for a document with a reason channel. */
  readonly announcement: string;
}

/** What a deny says when the decision carries no reason — never an empty message. */
export const DENIED_WITHOUT_REASON = 'denied by the smelt guard';

/**
 * The announcement for a rewrite whose document carries a reason channel the model
 * reads (Claude Code, Codex): the model is told, in its own transcript, that the
 * command it asked for is not the command that ran.
 */
export function rewroteReason(suggestion: string): string {
  return `smelt rewrote this command (hooks.enforcement: "rewrite"): ${suggestion}`;
}

/**
 * The stderr announcement, in two halves so a *generated* consumer can splice values
 * between them: the opencode plugin this installer writes is JavaScript source, and
 * its copy of this sentence used to be hand-typed inside a string template where
 * nothing could see it drift from the shims'. Both halves are pinned by
 * `test/guards/harness-registry.test.ts`.
 */
export const REWRITE_ANNOUNCEMENT_OPENING =
  'smelt guard (rewrite mode): substituted the command in-flight with `';
export const REWRITE_ANNOUNCEMENT_JOIN = '`. ';

/** The one stderr announcement, for a rewrite schema with no reason channel. */
export function rewriteAnnouncement(suggestion: string, reason: string): string {
  return `${REWRITE_ANNOUNCEMENT_OPENING}${suggestion}${REWRITE_ANNOUNCEMENT_JOIN}${reason}`;
}

/**
 * The first of `keys` the raw payload carries, `undefined` when it carries none — the
 * `a ?? b ?? c` every shim used to spell by hand, with dotted keys for the harnesses
 * that nest the tool call one level down.
 */
function payloadValue(raw: unknown, keys: readonly string[]): unknown {
  const fields = asRecord(raw);
  for (const key of keys) {
    const dot = key.indexOf('.');
    const value =
      dot === -1 ? fields[key] : asRecord(fields[key.slice(0, dot)])[key.slice(dot + 1)];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/**
 * The adapter a {@link HarnessHookSchema} describes. Everything shared lives here
 * once: the tool mapping, the rewrite-input splice, both announcements, the deny
 * fallback, and the rule that a schema with no `rewrite` renders a deny instead.
 */
export function shimFromSchema(schema: HarnessHookSchema): ShimAdapter {
  const { cwdKey, rewrite } = schema;
  return {
    toRequest: (raw) =>
      toolCallRequest(
        payloadValue(raw, schema.toolNameKeys),
        payloadValue(raw, schema.toolInputKeys),
        { read: schema.readTools, bash: schema.bashTools },
      ),
    ...(cwdKey === undefined
      ? {}
      : {
          cwd: (raw: unknown): string | undefined => {
            const cwd = asRecord(raw)[cwdKey];
            return typeof cwd === 'string' && cwd !== '' ? cwd : undefined;
          },
        }),
    pass: () => ({ stdout: '', exitCode: 0 }),
    deny: (_raw, _request, decision) => ({
      stdout: `${JSON.stringify(schema.deny(decision.reason ?? DENIED_WITHOUT_REASON))}\n`,
      exitCode: 0,
    }),
    ...(rewrite === undefined
      ? {}
      : {
          rewrite: (raw: unknown, _request: GuardRequest, decision: GuardDecision): ShimOutput => {
            const suggestion = decision.suggestion ?? '';
            const input = {
              ...asRecord(payloadValue(raw, schema.toolInputKeys)),
              command: decision.suggestion,
            };
            const document = rewrite.document({
              input,
              suggestion,
              announcement: rewroteReason(suggestion),
            });
            return {
              stdout: `${JSON.stringify(document)}\n`,
              ...(rewrite.announce === 'stderr'
                ? { stderr: `${rewriteAnnouncement(suggestion, decision.reason ?? '')}\n` }
                : {}),
              exitCode: 0,
            };
          },
        }),
  };
}

export { isMainModule };
