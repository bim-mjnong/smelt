import { asRecord, isMainModule, runShimMain, toolCallRequest } from '../shim.ts';
import type { ShimAdapter } from '../shim.ts';

/**
 * Claude Code shim — VERIFIED tier.
 *
 * Schema per <https://code.claude.com/docs/en/hooks> (verified 2026-09-02; the deep
 * dive is docs/research/2026-09-02-agent-enforcement.md § 1):
 *
 *  - stdin: `{ hook_event_name: "PreToolUse", tool_name, tool_input, cwd }`. For
 *    `Read`, `tool_input.file_path` is already absolute and `offset`/`limit` mark a
 *    windowed read; for `Bash`, `tool_input.command` is the full command string, and
 *    a relative path in it resolves against the payload's `cwd` — the *session's*
 *    working directory, which after the model `cd`s differs from this hook
 *    process's own cwd.
 *  - deny: `hookSpecificOutput.permissionDecision: "deny"` with
 *    `permissionDecisionReason` — which is **shown to the model**, so the guard's
 *    reason (the exact replacement command, the `smelt retrieve` contract) lands in
 *    the transcript as steering.
 *  - rewrite (opt-in, `hooks.enforcement: "rewrite"`): `updatedInput` replaces the
 *    entire input object of the *same* tool (v2.0.10+), so a Bash command can be
 *    substituted but a Read can never become a Bash call — Reads deny in every mode.
 */
export const adapter: ShimAdapter = {
  toRequest: (raw) => {
    const fields = asRecord(raw);
    return toolCallRequest(fields['tool_name'], fields['tool_input'], {
      read: ['Read'],
      bash: ['Bash'],
    });
  },
  cwd: (raw) => {
    const cwd = asRecord(raw)['cwd'];
    return typeof cwd === 'string' && cwd !== '' ? cwd : undefined;
  },
  pass: () => ({ stdout: '', exitCode: 0 }),
  deny: (_raw, _request, decision) => ({
    stdout: `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: decision.reason ?? 'denied by the smelt guard',
      },
    })}\n`,
    exitCode: 0,
  }),
  rewrite: (raw, _request, decision) => ({
    stdout: `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason:
          `smelt rewrote this command (hooks.enforcement: "rewrite"): ` +
          `${decision.suggestion ?? ''}`,
        // updatedInput replaces the whole input object — unchanged fields ride along.
        updatedInput: { ...asRecord(asRecord(raw)['tool_input']), command: decision.suggestion },
      },
    })}\n`,
    exitCode: 0,
  }),
};

if (isMainModule(import.meta.url)) runShimMain(adapter);
