import { CLI_NAME } from './shell.ts';
import { CLI_FLAGS, FLAG_HELP } from './subcommands/flags.ts';
import type { FlagName } from './subcommands/flags.ts';
import { ownersOf, SUBCOMMAND_LIST } from './subcommands/registry.ts';
import { DEFAULT_VERB } from './subcommands/subcommand.ts';

/**
 * The help text — rendered from the registries, never hand-arranged.
 *
 * `--strategy` has rendered `STRATEGIES` and `--harness` `HARNESS_PROFILES` for a
 * while; this module finishes the job for the rest of the page. Every subcommand's
 * USAGE line, its section, and the `map only.` / `hooks only.` prefix on the flags it
 * owns come from `SUBCOMMANDS` and `CLI_FLAGS`, so a seventh verb or an eleventh flag
 * reaches the help by existing. The help text is also the closest thing the CLI has to
 * documentation, which is exactly why it must not be able to fall behind the parser.
 *
 * `test/__snapshots__/cli-usage.help.txt` pins the rendered bytes: a help change is a
 * reviewable diff, not a thing that happens.
 */

/** The column an OPTIONS entry's description starts at. */
const OPTION_INDENT = ' '.repeat(23);

/** The USAGE block: every command's everyday forms, then the occasional ones. */
function renderSynopsis(): string {
  const everyday = SUBCOMMAND_LIST.flatMap((command) => command.usage.synopsis);
  const occasional = SUBCOMMAND_LIST.flatMap((command) => command.usage.occasional ?? []);
  return [...everyday, ...occasional].map((form) => `  ${CLI_NAME} ${form}`).join('\n');
}

/**
 * The named sections, in registry order. Two verbs may declare the same heading —
 * `retrieve` and `stats` share RETRIEVE & STATS, because the loop is one story — and
 * their bodies are joined under the single heading rather than repeating it.
 */
function renderSections(): string {
  const sections = new Map<string, string[]>();
  for (const command of SUBCOMMAND_LIST) {
    const section = command.usage.section;
    if (section === undefined) continue;
    const bodies = sections.get(section.heading);
    if (bodies === undefined) sections.set(section.heading, [section.body]);
    else bodies.push(section.body);
  }
  return [...sections]
    .map(([heading, bodies]) => `${heading}\n${bodies.join('\n\n')}`)
    .join('\n\n');
}

/**
 * The OPTIONS block. The description is the flag's own; the ownership sentence in
 * front of it is generated — a flag exactly one *named* verb owns reads `map only.`
 * or `hooks only.`, and one the default verb or several verbs share reads nothing,
 * because "which verb owns this flag" is a fact the registry already holds.
 */
function renderOptions(): string {
  return (Object.keys(CLI_FLAGS) as FlagName[])
    .map((name) => {
      const help = FLAG_HELP[name];
      const [first, ...rest] = [`${ownedBy(name)}${help.body()[0] ?? ''}`, ...help.body().slice(1)];
      return [
        `  ${help.label.padEnd(21)}${first ?? ''}`,
        ...rest.map((line) => `${OPTION_INDENT}${line}`),
      ].join('\n');
    })
    .join('\n');
}

/** `map only. ` for a flag one named verb owns alone; nothing for anything else. */
function ownedBy(name: FlagName): string {
  const owners = ownersOf(name);
  const only = owners.length === 1 ? owners[0] : undefined;
  return only === undefined || only.name === DEFAULT_VERB ? '' : `${only.name} only. `;
}

/** The help text. Also the closest thing the CLI has to documentation. */
export function cliUsage(): string {
  return `${CLI_NAME} — shrink text for a model, without lying about what was removed.

USAGE
${renderSynopsis()}

Smelted text goes to stdout and the report goes to stderr, so the two can be piped
apart:  ${CLI_NAME} big.log --budget 4000 > small.log

${renderSections()}

OPTIONS
${renderOptions()}

EXIT CODES
  0  under budget (map is always under budget by construction)
  1  over budget — the plan did not fit, and the report says so. Never silent.
     map never exits 1; see MAP above.
  2  usage error
  3  ${CLI_NAME} refused (a SmeltError: an unbuilt planner, an unknown hash, a corrupt store)
  4  unexpected internal error
`;
}
