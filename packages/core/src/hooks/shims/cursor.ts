import { asRecord, isMainModule, runShimMain, toolCallRequest } from '../shim.ts';
import type { ShimAdapter } from '../shim.ts';

/**
 * Cursor CLI/agent shim — EXPERIMENTAL tier: schema mapped from the capability
 * matrix (docs/research/2026-09-02-harness-capability-matrix.md, Cursor row; primary
 * source <https://cursor.com/docs/agent/hooks>), not yet smoke-tested against the
 * real binary.
 *
 *  - event: `preToolUse` (the broad hook — unlike `beforeShellExecution`, it
 *    supports input rewrite); stdin `{ tool_name, tool_input }`.
 *  - deny: `{ "permission": "deny", "agentMessage": … }` — `agentMessage` reaches
 *    the model, `userMessage` the human; the guard's steering text goes to the model.
 *  - rewrite: `{ "permission": "allow", "updated_input": { … } }` (snake_case, the
 *    whole input object).
 *
 * Cursor has no static permission-config file — gating is entirely hook code — so
 * this shim plus the instruction file is the whole enforcement story there.
 */
export const adapter: ShimAdapter = {
  toRequest: (raw) => {
    const fields = asRecord(raw);
    return toolCallRequest(fields['tool_name'], fields['tool_input'], {
      read: ['read_file', 'Read', 'ReadFile'],
      bash: ['run_terminal_cmd', 'Shell', 'Bash', 'shell'],
    });
  },
  pass: () => ({ stdout: '', exitCode: 0 }),
  deny: (_raw, _request, decision) => ({
    stdout: `${JSON.stringify({
      permission: 'deny',
      agentMessage: decision.reason ?? 'denied by the smelt guard',
    })}\n`,
    exitCode: 0,
  }),
  rewrite: (raw, _request, decision) => ({
    stdout: `${JSON.stringify({
      permission: 'allow',
      updated_input: { ...asRecord(asRecord(raw)['tool_input']), command: decision.suggestion },
    })}\n`,
    exitCode: 0,
  }),
};

if (isMainModule(import.meta.url)) runShimMain(adapter);
