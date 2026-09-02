import { asRecord, isMainModule, runShimMain, toolCallRequest } from '../shim.ts';
import type { ShimAdapter } from '../shim.ts';

/**
 * Hermes Agent shim — EXPERIMENTAL tier: schema mapped from the capability matrix
 * (docs/research/2026-09-02-harness-capability-matrix.md, Hermes Agent row; primary
 * source <https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks>),
 * not yet smoke-tested against the real binary.
 *
 *  - event: `pre_tool_call`; stdin carries the tool name and its arguments
 *    (`tool_name` + `args`, with `tool_input` accepted as a fallback spelling).
 *  - deny: `{ "action": "block", "reason": … }`.
 *  - rewrite: `{ "action": "modify", "args": { … } }` — a **shallow merge** into the
 *    tool's arguments, so this shim sends only the `command` key and the harness
 *    keeps the rest.
 *
 * Carried caveat from the matrix: Hermes has a known bypass where memory tools
 * ignore `disabled_toolsets` (<https://github.com/NousResearch/hermes-agent/issues/46171>) —
 * tool gating there is leaky at the edges, so treat this hook as best-effort
 * steering, not a boundary.
 */
export const adapter: ShimAdapter = {
  toRequest: (raw) => {
    const fields = asRecord(raw);
    return toolCallRequest(fields['tool_name'], fields['args'] ?? fields['tool_input'], {
      read: ['read_file', 'Read', 'ReadFile'],
      bash: ['execute_command', 'terminal', 'bash', 'Bash', 'shell'],
    });
  },
  pass: () => ({ stdout: '', exitCode: 0 }),
  deny: (_raw, _request, decision) => ({
    stdout: `${JSON.stringify({
      action: 'block',
      reason: decision.reason ?? 'denied by the smelt guard',
    })}\n`,
    exitCode: 0,
  }),
  rewrite: (_raw, _request, decision) => ({
    stdout: `${JSON.stringify({
      action: 'modify',
      args: { command: decision.suggestion },
    })}\n`,
    exitCode: 0,
  }),
};

if (isMainModule(import.meta.url)) runShimMain(adapter);
