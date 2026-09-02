import { asRecord, isMainModule, runShimMain, toolCallRequest } from '../shim.ts';
import type { ShimAdapter } from '../shim.ts';

/**
 * Cline shim — EXPERIMENTAL tier: schema mapped from the capability matrix
 * (docs/research/2026-09-02-harness-capability-matrix.md, Cline row; primary source
 * <https://docs.cline.bot/features/hooks>), not yet smoke-tested against the real
 * binary.
 *
 *  - event: `PreToolUse`, delivered to an executable under `.clinerules/hooks/`;
 *    stdin carries the tool call (accepted spellings: `tool_name`/`tool_input`,
 *    `toolName`/`toolInput`, or nested under `preToolUse`).
 *  - deny: `{ "cancel": true, "errorMessage": … }`. **Deny-only**: the response
 *    schema has no input-modification field, so under
 *    `hooks.enforcement: "rewrite"` this harness falls back to the deny, whose
 *    reason still carries the exact replacement pipeline.
 */
export const adapter: ShimAdapter = {
  toRequest: (raw) => {
    const fields = asRecord(raw);
    const nested = asRecord(fields['preToolUse']);
    const name = fields['tool_name'] ?? fields['toolName'] ?? nested['toolName'] ?? nested['tool'];
    const input =
      fields['tool_input'] ?? fields['toolInput'] ?? nested['toolInput'] ?? nested['input'];
    return toolCallRequest(name, input, {
      read: ['Read', 'read_file', 'readFile'],
      bash: ['Bash', 'execute_command', 'executeCommand', 'shell'],
    });
  },
  pass: () => ({ stdout: '', exitCode: 0 }),
  deny: (_raw, _request, decision) => ({
    stdout: `${JSON.stringify({
      cancel: true,
      errorMessage: decision.reason ?? 'denied by the smelt guard',
    })}\n`,
    exitCode: 0,
  }),
  // No `rewrite`: Cline's PreToolUse response cannot modify tool input (deny-only).
};

if (isMainModule(import.meta.url)) runShimMain(adapter);
