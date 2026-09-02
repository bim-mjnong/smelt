import process from 'node:process';

import { CliUsageError } from '../../errors.ts';
import { runHooks } from '../hooks.ts';
import { CLI_NAME } from '../shell.ts';
import type { CliIo } from '../shell.ts';

import type { FlagValues } from './flags.ts';
import type { Subcommand } from './subcommand.ts';

/**
 * `smelt hooks install` / `smelt hooks remove` — the harness-hooks installer's front
 * door. The installer itself is `cli/hooks.ts`; this file is only the verb.
 *
 * Like `init`, it is interactive — the wizard asks everything except which harness —
 * so `--harness` is the one flag it owns, and the registry refuses the rest. The id
 * itself is validated in `cli/hooks.ts` against the harness registry in `src/harness/`,
 * which is also where the `--harness` help list comes from.
 */

/** `smelt hooks <install|remove> [--harness <id>]` — parsed. */
export interface HooksInvocation {
  readonly mode: 'hooks';
  readonly action: 'install' | 'remove';
  readonly harness?: string;
}

export const hooksCommand: Subcommand<HooksInvocation, HooksInvocation> = {
  name: 'hooks',
  flags: ['harness'],
  refusal: `hooks is interactive; the wizard asks the rest.`,
  usage: {
    synopsis: ['hooks install [--harness <id>]', 'hooks remove [--harness <id>]'],
    section: {
      heading: 'HOOKS',
      body:
        `  ${CLI_NAME} hooks install wires the smelt guard into agent-harness hooks: a\n` +
        `  PreToolUse size-guard that refuses oversized raw reads with the exact ${CLI_NAME}\n` +
        `  replacement command (default on), \`${CLI_NAME} stats\` at session end (default\n` +
        `  on), and an opening \`${CLI_NAME} map\` at session start (opt-in) — plus an\n` +
        `  instruction-file snippet that teaches \`${CLI_NAME} retrieve\` after a deny.\n` +
        `  Harnesses are tiered honestly: verified (Claude Code, Codex), experimental\n` +
        `  (Gemini, Grok, Hermes, Cursor, opencode, Cline — schemas from the capability\n` +
        `  matrix, not yet smoke-tested), advisory (KiloCode, Aider — instructions only,\n` +
        `  nothing enforced). Same discipline as init: every file listed before a final\n` +
        `  confirm, no existing file overwritten without a per-file yes, re-runs edit\n` +
        `  toggles. ${CLI_NAME} hooks remove takes it back out. Guard settings live in\n` +
        `  smelt.config.json ("hooks": {"thresholdBytes", "enforcement": "deny"|"rewrite"});\n` +
        `  deny is the default — rewrite substitutes commands in-flight only where a\n` +
        `  harness supports it, and never silently.`,
    },
  },

  parse(values: FlagValues, positionals: readonly string[]): HooksInvocation {
    const action = positionals[1];
    if (action !== 'install' && action !== 'remove') {
      throw new CliUsageError(
        `${CLI_NAME}: hooks needs an action — install or remove.\n` +
          `  ${CLI_NAME} hooks install [--harness <id>]\n` +
          `  ${CLI_NAME} hooks remove [--harness <id>]`,
      );
    }
    if (positionals.length > 2) {
      throw new CliUsageError(
        `${CLI_NAME}: hooks ${action} takes no further arguments, got ` +
          `${positionals.slice(2).join(', ')}.`,
      );
    }
    return {
      mode: 'hooks',
      action,
      ...(values.harness === undefined ? {} : { harness: values.harness }),
    };
  },

  /** Nothing to merge: the wizard asks, and reads `smelt.config.json` itself. */
  resolve(invocation: HooksInvocation): HooksInvocation {
    return invocation;
  },

  /** Interactive like `init`, so it needs the same stream, and refuses without one. */
  async run(resolved: HooksInvocation, io: CliIo): Promise<number> {
    if (io.initInput === undefined) {
      throw new CliUsageError(
        `${CLI_NAME}: hooks ${resolved.action} is interactive, and this invocation has ` +
          `no interactive input stream. Run \`${CLI_NAME} hooks ${resolved.action}\` ` +
          `from a terminal.`,
      );
    }
    return await runHooks(resolved.action, resolved.harness, {
      input: io.initInput,
      output: io.stdout,
      cwd: io.cwd ?? process.cwd(),
    });
  },
};
