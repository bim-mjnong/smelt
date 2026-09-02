import process from 'node:process';

import {
  decide,
  isMainModule,
  parseGuardRequest,
  readAllOfStdin,
  readGuardSettings,
} from './guard-core.ts';
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
 *    weakens into nothing. And a shim never rewrites in deny mode: a silent rewrite
 *    changes what the model asked for without telling it, which is this project's
 *    signature failure shape applied to the harness (founder ruling, KOT-212).
 */

/** What one harness shim supplies. Everything else is {@link runShim}'s. */
export interface ShimAdapter {
  /** Map the harness's raw stdin JSON to a guard request; `undefined` = pass through. */
  readonly toRequest: (raw: unknown) => GuardRequest | undefined;
  /** Render an allow. Most harnesses: empty stdout, exit 0. */
  readonly pass: () => ShimOutput;
  /** Render a deny, in the harness's schema. */
  readonly deny: (raw: unknown, request: GuardRequest, decision: GuardDecision) => ShimOutput;
  /**
   * Render an input rewrite (only ever called for a Bash-shaped request whose
   * decision carries a faithful `suggestion`, and only in rewrite mode). Omit on
   * harnesses whose hook schema cannot modify tool input — they deny instead.
   */
  readonly rewrite?: (raw: unknown, request: GuardRequest, decision: GuardDecision) => ShimOutput;
}

/** What a shim writes and how it exits. `stdout` is a complete JSON line or ''. */
export interface ShimOutput {
  readonly stdout: string;
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
  const decision =
    statFile === undefined
      ? decide(request, settings, cwd)
      : decide(request, settings, cwd, statFile);
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

export { isMainModule, parseGuardRequest };
