import { asRecord, isMainModule, runShimMain, toolCallRequest } from '../shim.ts';
import type { ShimAdapter } from '../shim.ts';

/**
 * Codex CLI shim — VERIFIED tier.
 *
 * Codex's experimental hooks (`features.hooks`, rust-v0.114.0+, on by default from
 * 0.150.1) deliberately mirror Claude Code's schema — the survey is
 * docs/research/2026-09-02-agent-enforcement.md § 3, primary source
 * <https://developers.openai.com/codex/hooks>:
 *
 *  - stdin: `{ tool_name, tool_input }`; shell input arrives as `tool_name: "Bash"`,
 *    `tool_input.command`.
 *  - deny: `hookSpecificOutput.permissionDecision: "deny"` + reason (or exit 2).
 *  - rewrite: `permissionDecision: "allow"` with `updatedInput` — for Bash,
 *    `updatedInput` **must include a string `command` field**, which this shim's
 *    rewrite always does.
 *
 * Two documented differences from Claude Code, both honoured here:
 * `permissionDecision: "ask"` is NOT supported (a parse error — the tool proceeds),
 * and this shim never emits it; project-layer hooks only run once the project is
 * trusted, which the installer's output says out loud.
 */
export const adapter: ShimAdapter = {
  toRequest: (raw) => {
    const fields = asRecord(raw);
    return toolCallRequest(fields['tool_name'], fields['tool_input'], {
      read: ['Read'],
      bash: ['Bash', 'shell'],
    });
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
        updatedInput: { ...asRecord(asRecord(raw)['tool_input']), command: decision.suggestion },
      },
    })}\n`,
    exitCode: 0,
  }),
};

if (isMainModule(import.meta.url)) runShimMain(adapter);
