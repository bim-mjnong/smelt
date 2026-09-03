import { useState } from 'react';
import facts from '@/generated/facts.json';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { Tabs } from '@/components/ui/Tabs';
import { CopyButton } from '@/components/ui/CopyButton';
import { Frame, FrameBar } from '@/components/ui/Frame';
import { Reveal } from '@/components/ui/Reveal';

/**
 * The headline feature: a prompt the visitor pastes into their coding agent. The agent
 * does the setup. Every step below states only what the README states: the init wizard
 * confirms before writing, the hooks installer lists files before a final confirm, and
 * the verification is a real smelt → retrieve → stats round trip.
 */
const PROMPTS = {
  'claude-code': `Set up smelt (https://github.com/smeltjs/smelt) in this project so oversized files and tool outputs stop flooding your context window:

1. Install the CLI: \`npm install -g @smeltjs/core\` (or use \`npx @smeltjs/core\` everywhere a step says \`smelt\`).
2. Run \`smelt init\` and choose a directory store (e.g. \`.smelt/store\`) — retrieval across turns and processes needs one. The wizard shows every file before a final confirm and never overwrites without a per-file yes.
3. Run \`smelt hooks install --harness claude-code\`. Review what it offers: a PreToolUse size-guard that refuses raw reads above the threshold and names the exact \`smelt\` replacement command, \`smelt stats\` on Stop, an opt-in repo map on SessionStart, and the instruction snippet in CLAUDE.md.
4. Verify the round trip on a real file:
   - \`smelt <a large file in this repo> --budget 4000 --focus <a symbol the task cares about>\`
   - take a hash from a \`retrieve("…")\` marker in the output and run \`smelt retrieve <that hash>\` — the exact original bytes come back
   - \`smelt stats\` — retrieveCalls and expansionRate moved, so the honesty loop is live
From now on: read big files through \`smelt <file> --budget 4000 --focus <what you are looking for>\`, orient with \`smelt map <dir> --budget 4000\`, and when a marker's bytes are needed, run \`smelt retrieve <hash>\`.`,

  codex: `Set up smelt (https://github.com/smeltjs/smelt) in this project so oversized files and tool outputs stop flooding your context window:

1. Install the CLI: \`npm install -g @smeltjs/core\` (or use \`npx @smeltjs/core\` everywhere a step says \`smelt\`).
2. Run \`smelt init\` and choose a directory store (e.g. \`.smelt/store\`) — retrieval across turns and processes needs one. The wizard shows every file before a final confirm and never overwrites without a per-file yes.
3. Run \`smelt hooks install --harness codex\`. Review what it offers: the size-guard that refuses raw reads above the threshold and names the exact \`smelt\` replacement command, stats at session end, and the instruction snippet in AGENTS.md.
4. Verify the round trip on a real file:
   - \`smelt <a large file in this repo> --budget 4000 --focus <a symbol the task cares about>\`
   - take a hash from a \`retrieve("…")\` marker in the output and run \`smelt retrieve <that hash>\` — the exact original bytes come back
   - \`smelt stats\` — retrieveCalls and expansionRate moved, so the honesty loop is live
From now on: read big files through \`smelt <file> --budget 4000 --focus <what you are looking for>\`, orient with \`smelt map <dir> --budget 4000\`, and when a marker's bytes are needed, run \`smelt retrieve <hash>\`.`,

  mcp: `Wire smelt (https://github.com/smeltjs/smelt) into this project over MCP:

1. Install the CLI: \`npm install -g @smeltjs/core\` — the store and config live with the project either way.
2. Run \`smelt init\` and choose a directory store (e.g. \`.smelt/store\`). The MCP server discovers the same store through \`smelt.config.json\`, so \`smelt retrieve <hash>\` from a shell and the model's \`smelt_retrieve\` hit one store and move one set of counters.
3. Add the server — Claude Code shown; Codex and Grok TOML snippets are in packages/mcp/README.md:
   \`claude mcp add smelt -- npx @smeltjs/mcp\`
4. Use the four tools: \`smelt_file\` to shrink a file under a byte budget with a focus, \`repo_map\` for orientation in an unfamiliar tree, \`smelt_retrieve\` to get elided bytes back, \`smelt_stats\` to watch the expansion rate.
5. Verify: \`smelt_file\` on a large file, then \`smelt_retrieve\` with a hash from a marker — the exact original bytes come back, and \`smelt_stats\` counts the round trip.`,
} as const;

type PromptId = keyof typeof PROMPTS;

/**
 * Each tab's download name and its one-line badge.
 *
 * The badge for a harness tab is its **tier**, and a tier is a package fact
 * (`HarnessProfile.tier`, grouped by `harnessesByTier()`): it is looked up in
 * `facts.json` by harness id, never typed here. It was typed here — both harness tabs
 * said `hooks tier: verified` — which is the same drift the tier table below this
 * section had, and it survived the table being derived: flipping a profile to
 * `advisory` moved it in the table while this badge kept advertising the old tier on
 * the same page. `site-facts.test.ts` now refuses a tier word written into any site
 * component.
 *
 * The MCP tab names no harness, so it carries a description of the transport instead
 * of a tier — there is no `HarnessProfile` behind it to state one.
 */
const TABS: Record<PromptId, { file: string; harness?: string; note?: string }> = {
  'claude-code': { file: 'paste-into-claude-code.txt', harness: 'claude-code' },
  codex: { file: 'paste-into-codex.txt', harness: 'codex' },
  mcp: { file: 'paste-into-any-mcp-client.txt', note: 'stdio-local, guard-enforced' },
};

/**
 * The tier `facts.json` records for a harness, as a badge — or a throw. A tab whose
 * harness the registry no longer carries would otherwise render `hooks tier: undefined`,
 * and a hole rendered quietly is the failure this generator exists to end.
 */
function badge({ harness, note }: { harness?: string; note?: string }): string {
  if (harness === undefined) return note ?? '';
  const group = facts.tiers.find((tier) => tier.harnesses.some((one) => one.id === harness));
  if (group === undefined) {
    throw new Error(
      `facts.json states no tier for the harness "${harness}" — the tab would advertise a ` +
        `tier nothing measured`,
    );
  }
  return `hooks tier: ${group.tier}`;
}

/** Backtick spans render as commands (ash); prose stays slag. Copy gets the raw text. */
function PromptBody({ text }: { text: string }) {
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap p-4 font-mono text-[13px] leading-[1.7] text-slag sm:p-5">
      <code>
        {text.split('`').map((seg, i) =>
          i % 2 === 1 ? (
            <span key={i} className="text-ash">
              {seg}
            </span>
          ) : (
            <span key={i}>{seg}</span>
          ),
        )}
      </code>
    </pre>
  );
}

export function AgentPrompt() {
  const [active, setActive] = useState<PromptId>('claude-code');

  return (
    <section aria-labelledby="agent-prompt" className="border-b border-iron-dark">
      <div className="mx-auto max-w-[1120px] px-4 py-16 sm:px-6 md:py-24">
        <SectionHeader
          id="agent-prompt"
          index="01 · setup, delegated →"
          title={
            <>
              Don't set it up. <span className="text-slag">Paste this into your agent.</span>
            </>
          }
          lead={
            <>
              Copy the prompt for your harness and hand it to the agent. It installs the CLI, runs
              the{' '}
              <code className="rounded-[2px] bg-lift px-1 font-mono text-[13px] text-ash">
                smelt init
              </code>{' '}
              wizard, wires the hooks preset, and proves the loop with a real retrieve round trip —
              nothing is written without a confirm.
            </>
          }
        />
        <Reveal className="mt-10">
          <Tabs
            label="Agent quick-install prompt by harness"
            onChange={(id) => setActive(id as PromptId)}
            tabs={(Object.keys(PROMPTS) as PromptId[]).map((id) => ({
              id,
              label: id === 'claude-code' ? 'Claude Code' : id === 'codex' ? 'Codex' : 'MCP-only',
              content: (
                <Frame>
                  <FrameBar
                    label={TABS[id].file}
                    meta={badge(TABS[id])}
                    right={
                      <CopyButton
                        text={PROMPTS[id]}
                        label="Copy the full prompt for your agent"
                        className="-my-1"
                      />
                    }
                  />
                  <PromptBody text={PROMPTS[id]} />
                </Frame>
              ),
            }))}
          />
          <p className="mt-4 max-w-[72ch] text-[13px] leading-[1.6] text-slag">
            Same discipline as running it yourself: the wizard and the hooks installer list every
            file before a final confirm, re-runs edit one choice at a time, and a merge into an
            existing settings file leaves every byte outside smelt's entries untouched.{' '}
            <span className="sr-only">Active tab: {active}.</span>
          </p>
        </Reveal>
      </div>
    </section>
  );
}
