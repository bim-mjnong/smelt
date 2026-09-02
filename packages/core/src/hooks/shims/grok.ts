import { asRecord, isMainModule, runShimMain, toolCallRequest } from '../shim.ts';
import type { ShimAdapter } from '../shim.ts';

/**
 * Grok CLI shim — EXPERIMENTAL tier: schema mapped from the capability matrix
 * (docs/research/2026-09-02-harness-capability-matrix.md, Grok CLI row; primary
 * source <https://docs.x.ai/build/features/hooks>), not yet smoke-tested against
 * the real binary. Note the matrix's provenance warning: the official CLI is
 * `xai-org/grok-build` (binary `grok`) — `superagent-ai/grok-cli` is a third-party
 * clone with a different hook surface.
 *
 *  - event: `PreToolUse`; stdin `{ tool_name, tool_input }` (Claude-Code-like tool
 *    names).
 *  - deny: `{ "decision": "deny", "reason": … }` or exit 2. **Deny-only**: the input
 *    is read-only to hooks, so there is no rewrite here — under
 *    `hooks.enforcement: "rewrite"` this harness falls back to the deny, whose
 *    reason still carries the exact replacement pipeline.
 */
export const adapter: ShimAdapter = {
  toRequest: (raw) => {
    const fields = asRecord(raw);
    return toolCallRequest(fields['tool_name'], fields['tool_input'], {
      read: ['Read', 'read_file', 'ReadFile'],
      bash: ['Bash', 'shell', 'run_shell_command'],
    });
  },
  pass: () => ({ stdout: '', exitCode: 0 }),
  deny: (_raw, _request, decision) => ({
    stdout: `${JSON.stringify({
      decision: 'deny',
      reason: decision.reason ?? 'denied by the smelt guard',
    })}\n`,
    exitCode: 0,
  }),
  // No `rewrite`: Grok's PreToolUse cannot modify tool input (deny-only harness).
};

if (isMainModule(import.meta.url)) runShimMain(adapter);
