import { asRecord, isMainModule, runShimMain, toolCallRequest } from '../shim.ts';
import type { ShimAdapter } from '../shim.ts';

/**
 * Gemini CLI shim — EXPERIMENTAL tier: the schema below is mapped from the
 * capability matrix (docs/research/2026-09-02-harness-capability-matrix.md, Gemini
 * CLI row; primary source <https://geminicli.com/docs/hooks/reference/>), and the
 * field names were additionally checked 2026-09-02 against the shipped
 * `@google/gemini-cli` 0.58.0 bundle (installed headlessly for KOT-212's
 * verification pass): the BeforeTool stdin payload is `{ tool_name, tool_input }`,
 * `read_file` takes `file_path` with `start_line`/`end_line` windows, the shell
 * tool is `run_shell_command` with `command`, denial is `{ "decision": "deny",
 * "reason": … }`, and `hookSpecificOutput.tool_input` substitutes the input. What
 * has NOT run is a live end-to-end session (needs credentials this environment does
 * not have), so the tier stays experimental — treat surprises as shim bugs and
 * please report them.
 *
 * Carried caveat from the matrix: Gemini's policy engine has an open bug where an
 * `allow` policy is ignored in non-interactive runs
 * (<https://github.com/google-gemini/gemini-cli/issues/20469>) — this preset uses
 * hooks, not the policy engine, but non-interactive behaviour is the least-tested
 * corner; verify before relying on it in CI.
 */
export const adapter: ShimAdapter = {
  toRequest: (raw) => {
    const fields = asRecord(raw);
    return toolCallRequest(fields['tool_name'], fields['tool_input'], {
      read: ['read_file', 'ReadFile', 'Read'],
      bash: ['run_shell_command', 'Shell', 'Bash'],
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
  rewrite: (raw, _request, decision) => ({
    stdout: `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'BeforeTool',
        tool_input: { ...asRecord(asRecord(raw)['tool_input']), command: decision.suggestion },
      },
    })}\n`,
    exitCode: 0,
  }),
};

if (isMainModule(import.meta.url)) runShimMain(adapter);
