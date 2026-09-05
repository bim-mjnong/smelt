import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { CliUsageError } from '../errors.ts';
import { DEFAULT_THRESHOLD_BYTES } from '../hooks/guard-core.ts';
import { detectedHarnesses, planInstall, presetToggles } from './hooks.ts';
import type { HooksChoices } from './hooks.ts';
import {
  CONFIG_FILE_NAME,
  CONFIG_VERSION,
  findConfigFile,
  parseConfig,
  renderConfig,
} from './config.ts';
import type { SmeltConfig, SmeltConfigStore } from './config.ts';
import { HARNESSES, harnessById } from '../harness/registry.ts';
import type { HarnessProfile } from '../harness/profile.ts';
import { harnessLabel, TIER_HONESTY } from '../harness/profile.ts';
import { DirectoryElisionStore } from '../store-dir.ts';
import { createSmelter } from '../smelter.ts';
import { DEFAULT_STRATEGY } from '../plan/planners.ts';
import { SETUP_RECIPE } from '../setup/recipe.ts';
import { answerReader, CLI_NAME, EXIT } from './shell.ts';
import type { AnswerStream } from './shell.ts';

/**
 * `smelt setup` — the SetupRecipe (CONTEXT.md) applied end-to-end: config, the hooks
 * preset, the MCP registration step, and a real smelt → retrieve round trip to prove
 * the loop. The verb is `subcommands/setup.ts`; this file is the flow, a pure function
 * over an injected input/output pair — the `init`/`hooks` discipline, so the wizard is
 * guard-tested in-process and a renderer (KOT-253) slots in behind the same stream.
 *
 * The two paths share one apply path, because two apply paths would drift:
 *
 *   - `--yes` answers everything from the recipe: the budget it recommends (printed
 *     loudly, written only when the config lacks one — the `smelt` verb's own
 *     budget-required refusal is untouched), a directory store at the recipe's path
 *     when the config carries none, and the hooks preset's currently-installed
 *     defaults, read the same way `smelt hooks install` reads them.
 *   - interactive asks four questions, each with an Enter default, then confirms.
 *
 * The one hard rule is inherited unchanged from `init` and `hooks`: an existing file
 * that is not smelt's own config is never written — not by `--yes`, not by a wizard
 * answer. It is skipped with a note pointing at `smelt hooks install`, which asks per
 * file. `smelt.config.json` is smelt's own file; `setup` updates it and says exactly
 * what it added.
 *
 * Idempotent by construction: a re-run on a current machine plans `unchanged` for
 * every file, writes nothing, and exits 0.
 */

/** Where the flow's bytes come from and go. Injected, so guards run it in-process. */
export interface SetupIo {
  /**
   * Interactive input — the real stdin in `bin.ts`, a scripted stream in tests.
   * Required only for the interactive path; `--yes` never asks.
   */
  readonly input?: AnswerStream;
  readonly output: (text: string) => void;
  /** Where the recipe is applied: config discovery, hooks files, the store. */
  readonly cwd: string;
  /** The home directory, for harness detection. Defaults to the real one. */
  readonly home?: string;
  /** The release running setup — stamped into the instruction block for `smelt doctor`. */
  readonly version?: string;
}

/** Everything the verb resolved before the flow ran. Pure data, both paths. */
export interface SetupOptions {
  /** Validated harness ids — `--harness`, repeatable. Empty means none was named. */
  readonly harnessIds: readonly string[];
  readonly yes: boolean;
  readonly noMcp: boolean;
  readonly json: boolean;
}

/** One file's fate, as the receipt and the confirm listing both spell it. */
export interface SetupFileAction {
  readonly name: string;
  readonly action: 'written' | 'updated' | 'unchanged' | 'skipped';
  /** Why a file was skipped, or what an update added. */
  readonly detail?: string;
}

/** One verification result. A check states what it proved, not what it ran. */
export interface SetupCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** The machine receipt — `--json` with `--yes`. Everything the flow decided. */
export interface SetupReceipt {
  readonly format: 'smelt.setup.v1';
  readonly cwd: string;
  readonly config: { readonly action: 'written' | 'updated' | 'current' };
  readonly files: readonly SetupFileAction[];
  readonly mcp: {
    readonly status: 'applied' | 'manual' | 'skipped';
    /** The recipe's registration command — what was written, or what is left to you. */
    readonly command?: string;
  };
  readonly checks: readonly SetupCheck[];
}

/** Everything the wizard or `--yes` decided. Pure data until apply. */
interface SetupChoices {
  harnesses: HarnessProfile[];
  budgetBytes: number | undefined;
  store: SmeltConfigStore | undefined;
  registerMcp: boolean;
}

/**
 * The probe the round-trip check smelts: big enough that the probe budget forces
 * cuts, with one focus term that must survive. The lexical planner is deterministic,
 * so every machine that runs setup proves the same round trip.
 */
const PROBE_SOURCE: string = `${Array.from(
  { length: 40 },
  (_, i): string =>
    `export function helper${String(i)}(input: string): string {\n` +
    `  const trimmed = input.trim();\n` +
    `  return trimmed + " (${String(i)})";\n` +
    `}\n`,
).join('')}\nexport function renderTicket(id: string): string {\n  return 'ticket-' + id;\n}\n`;

const PROBE_BUDGET_BYTES = 600;

function readIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

type Ask = (prompt: string) => Promise<string>;
type Say = (text: string) => void;

/**
 * The flow, start to finish. Returns an exit code: 0 when every check passed, the
 * refused exit when one did not — a setup that cannot prove its own round trip is not
 * a finished setup, and an agent reading `--json` must be able to see that in the
 * exit code without parsing prose.
 */
export async function runSetup(options: SetupOptions, io: SetupIo): Promise<number> {
  const lines = options.yes ? undefined : answerReader(io.input!);
  const ask: Ask = async (prompt) => {
    if (lines === undefined) {
      throw new CliUsageError(
        `${CLI_NAME} setup: a question was reached with no interactive input — ` +
          `this is a bug in the flow, not an answer you owe.`,
      );
    }
    io.output(prompt);
    const next = await lines.next();
    if (next === undefined) {
      throw new CliUsageError(
        `${CLI_NAME} setup: input ended before the wizard finished. Nothing was written.`,
      );
    }
    return next.trim();
  };
  // Prose is suppressed in --json mode: the receipt is the whole output, the way the
  // other verbs' envelopes are. A machine parsing the receipt must not also parse
  // around it.
  const say: Say = (text) => {
    if (!options.json) io.output(text);
  };

  try {
    const choices: SetupChoices | undefined = options.yes
      ? await yesPath(options, io, say)
      : await wizardPath(options, io, say, ask);
    if (choices === undefined) return EXIT.ok; // declined at the confirm
    return await finish(choices, io, say, options);
  } finally {
    await lines?.release();
  }
}

// ── the two decision paths ─────────────────────────────────────────────────────────

/** `--yes`: the recipe's answers, printed loudly — never silently assumed. */
async function yesPath(options: SetupOptions, io: SetupIo, say: Say): Promise<SetupChoices> {
  const choices: SetupChoices = {
    harnesses: options.harnessIds.map((id) => harnessById(id)!),
    budgetBytes: SETUP_RECIPE.recommendedBudgetBytes,
    store: { kind: 'directory', path: SETUP_RECIPE.store.defaultDir },
    registerMcp: !options.noMcp,
  };
  say(
    `${CLI_NAME} setup — applying the recipe with --yes:\n` +
      `  budget: ${String(SETUP_RECIPE.recommendedBudgetBytes)} bytes (written only if ` +
      `the config carries none)\n` +
      `  store: directory at ${SETUP_RECIPE.store.defaultDir} (only if the config ` +
      `carries none; an explicit store is respected)\n` +
      `  hooks preset: current defaults for ${
        choices.harnesses.length === 0
          ? 'no harness (none named — config only)'
          : choices.harnesses.map((profile) => profile.id).join(', ')
      }\n` +
      `  existing files are never overwritten — skipped with a note\n`,
  );
  return choices;
}

/** Interactive: four questions, each with an Enter default, then one confirm. */
async function wizardPath(
  options: SetupOptions,
  io: SetupIo,
  say: Say,
  ask: Ask,
): Promise<SetupChoices | undefined> {
  say(
    `${CLI_NAME} setup — one command through the whole recipe. Enter accepts every ` +
      `default; nothing is written until the final confirm.\n\n`,
  );

  const choices: SetupChoices = {
    harnesses: options.harnessIds.map((id) => harnessById(id)!),
    budgetBytes: undefined,
    store: undefined,
    registerMcp: true,
  };

  if (options.harnessIds.length === 0) {
    await stepHarnesses(say, ask, choices, detectedHarnesses(io.cwd, io.home ?? homedir()));
  } else {
    for (const profile of choices.harnesses) say(`  ${tierLine(profile)}\n`);
  }

  // Budget: the config's own if it carries one, else the recipe's recommendation —
  // Enter is always an answer here, which is the difference from `init`, whose
  // confirm refuses to proceed without a budget someone typed.
  const configPath = findConfigFile(io.cwd) ?? join(io.cwd, CONFIG_FILE_NAME);
  const existingText = readIfExists(configPath);
  const existing = existingText === undefined ? undefined : parseConfig(existingText, configPath);
  const budgetDefault = existing?.defaultBudgetBytes ?? SETUP_RECIPE.recommendedBudgetBytes;
  for (;;) {
    const answer = await ask(`default budget in bytes [${String(budgetDefault)}]> `);
    if (answer === '') {
      choices.budgetBytes = budgetDefault;
      break;
    }
    if (/^\d+$/.test(answer) && Number(answer) > 0) {
      choices.budgetBytes = Number(answer);
      break;
    }
    say(`A whole number of bytes greater than zero, e.g. ${String(budgetDefault)}.\n`);
  }

  stepStore(say, ask, choices);

  for (;;) {
    await stepMcp(say, ask, choices);
    const verdict = await confirm(say, ask, choices, io);
    if (verdict === 'done') return choices;
    if (verdict === 'declined') {
      say(`Nothing was written.\n`);
      return undefined;
    }
    // 'back' lands on the last question, the MCP toggle.
  }
}

// ── the questions ───────────────────────────────────────────────────────────────────

async function stepHarnesses(
  say: Say,
  ask: Ask,
  choices: SetupChoices,
  detected: readonly HarnessProfile[],
): Promise<void> {
  const all = [...HARNESSES];
  say(`Harnesses to wire with the guard preset:\n`);
  all.forEach((profile, index) => {
    const mark = detected.some((one) => one.id === profile.id) ? ' (detected)' : '';
    say(`  ${String(index + 1)}. ${tierLine(profile)}${mark}\n`);
  });
  const detectedNote =
    detected.length === 0
      ? 'none detected — Enter means config only'
      : `Enter for detected: ${detected.map((profile) => profile.id).join(', ')}`;
  for (;;) {
    const answer = await ask(`numbers, 'all', or Enter (${detectedNote})> `);
    if (answer === 'back') {
      say(`This is the first step — there is nothing before it.\n`);
      continue;
    }
    if (answer === '') {
      choices.harnesses = [...detected];
      return;
    }
    if (answer === 'all') {
      choices.harnesses = all;
      return;
    }
    if (/^\d+(?:\s*,\s*\d+)*$/u.test(answer)) {
      const picked = answer.split(',').map((piece) => Number(piece.trim()));
      if (picked.every((n) => n >= 1 && n <= all.length)) {
        choices.harnesses = [...new Set(picked)].map((n) => all[n - 1]!);
        return;
      }
    }
    say(`A comma-separated list of the numbers above, 'all', or Enter.\n`);
  }
}

async function stepStore(say: Say, ask: Ask, choices: SetupChoices): Promise<void> {
  say(
    `\nWhere elided bytes live. Every elision is reversible only while a store holds ` +
      `its bytes (Law 3). An explicit store already in the config is respected.\n`,
  );
  for (;;) {
    const answer = await ask(`store (1 memory / 2 directory) [2]> `);
    if (answer === 'back') return;
    if (answer === '' || answer === '2') {
      const pathDefault =
        choices.store?.kind === 'directory' ? choices.store.path : SETUP_RECIPE.store.defaultDir;
      const path = await ask(`store directory, relative to ${CONFIG_FILE_NAME} [${pathDefault}]> `);
      if (path === 'back') continue;
      choices.store = { kind: 'directory', path: path === '' ? pathDefault : path };
      return;
    }
    if (answer === '1') {
      choices.store = { kind: 'memory' };
      return;
    }
    say(`1 for memory, 2 for directory.\n`);
  }
}

async function stepMcp(say: Say, ask: Ask, choices: SetupChoices): Promise<void> {
  for (;;) {
    const answer = await ask(`register the MCP server? (1 yes — prints the command / 2 no) [1]> `);
    if (answer === 'back') return;
    if (answer === '' || answer === '1') {
      choices.registerMcp = true;
      return;
    }
    if (answer === '2') {
      choices.registerMcp = false;
      return;
    }
    say(`1 to include the MCP step, 2 to skip it.\n`);
  }
}

type ConfirmVerdict = 'done' | 'declined' | 'back';

async function confirm(
  say: Say,
  ask: Ask,
  choices: SetupChoices,
  io: SetupIo,
): Promise<ConfirmVerdict> {
  const plan =
    choices.harnesses.length === 0
      ? undefined
      : planInstall(io.cwd, hooksChoices(choices, io.cwd, io.version));
  say(`\nAbout to apply, into ${io.cwd}:\n`);
  say(
    `  ${CONFIG_FILE_NAME.padEnd(32)} (budget ` +
      `${String(choices.budgetBytes ?? SETUP_RECIPE.recommendedBudgetBytes)}, strategy ` +
      `default, store ${describeStore(choices.store)})\n`,
  );
  if (plan === undefined) {
    say(`  no harness selected — the guard preset is skipped\n`);
  } else {
    for (const file of plan.files) {
      if (basename(file.path) === CONFIG_FILE_NAME) continue;
      say(`  ${file.name.padEnd(32)} (${fileFate(file)})\n`);
    }
    for (const skip of plan.skipped) {
      say(`  ${skip.name.padEnd(32)} (SKIPPED: ${skip.why})\n`);
    }
  }
  say(
    `  mcp ${
      choices.registerMcp ? `(manual step: ${SETUP_RECIPE.mcp.register})` : '(skipped)'
    }\nNothing has been written yet.\n`,
  );
  for (;;) {
    const answer = await ask(`confirm (yes / no / back)> `);
    if (answer === 'back') return 'back';
    if (answer === 'no') return 'declined';
    if (answer === 'yes') return 'done';
    say(`yes to apply, no to leave everything untouched, back to change a step.\n`);
  }
}

// ── the one apply path ──────────────────────────────────────────────────────────────

async function finish(
  choices: SetupChoices,
  io: SetupIo,
  say: Say,
  options: SetupOptions,
): Promise<number> {
  const files: SetupFileAction[] = [];
  const notes: string[] = [];

  // ── config first: the hooks plan reads the settled bytes back, so a second run
  //    plans the same file as `unchanged` instead of chasing its own tail ──
  const configPath = findConfigFile(io.cwd) ?? join(io.cwd, CONFIG_FILE_NAME);
  const before = readIfExists(configPath);
  const existing = before === undefined ? undefined : parseConfig(before, configPath);
  const budget =
    existing?.defaultBudgetBytes ?? choices.budgetBytes ?? SETUP_RECIPE.recommendedBudgetBytes;
  const store = existing?.store ?? choices.store;
  const next: SmeltConfig = {
    ...existing,
    smeltConfig: CONFIG_VERSION,
    defaultBudgetBytes: budget,
    strategy: existing?.strategy ?? DEFAULT_STRATEGY,
    ...(store === undefined ? {} : { store }),
  };
  const rendered = renderConfig(next);
  let configAction: SetupReceipt['config']['action'];
  if (before === undefined) {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, rendered);
    configAction = 'written';
    files.push({ name: CONFIG_FILE_NAME, action: 'written' });
  } else if (before !== rendered) {
    writeFileSync(configPath, rendered);
    configAction = 'updated';
    files.push({
      name: CONFIG_FILE_NAME,
      action: 'updated',
      detail: 'filled the fields the config lacked (budget, strategy default, store)',
    });
  } else {
    configAction = 'current';
    files.push({ name: CONFIG_FILE_NAME, action: 'unchanged' });
  }

  // ── hooks preset: the installer's own plan, over the settled config ──
  const plan =
    choices.harnesses.length === 0
      ? undefined
      : planInstall(io.cwd, hooksChoices(choices, io.cwd, io.version));
  if (plan !== undefined) {
    for (const file of plan.files) {
      if (basename(file.path) === CONFIG_FILE_NAME) continue; // settled above
      if (file.unchanged) {
        files.push({ name: file.name, action: 'unchanged' });
        continue;
      }
      if (!file.exists) {
        mkdirSync(dirname(file.path), { recursive: true });
        writeFileSync(file.path, file.content);
        if (file.mode !== undefined) chmodSync(file.path, file.mode);
        files.push({ name: file.name, action: 'written' });
        continue;
      }
      // The hard rule, inherited: an existing file that is not smelt's config is
      // never written — not by --yes, not by a wizard answer. Point at the editor.
      files.push({
        name: file.name,
        action: 'skipped',
        detail: 'exists — not overwritten; `smelt hooks install` edits it and asks per file',
      });
    }
    notes.push(...plan.notes);
  }

  // ── mcp: applied where a profile carries the registration, handed over as the
  //    exact command where none does (no harness named, or a TOML harness) — never
  //    pretending it ran something it did not ──
  const mcpApplied = choices.harnesses.some((profile) =>
    profile.install.some((step) => step.kind === 'mcp-registration'),
  );
  const mcp: SetupReceipt['mcp'] = !choices.registerMcp
    ? { status: 'skipped' }
    : mcpApplied
      ? { status: 'applied', command: SETUP_RECIPE.mcp.register }
      : { status: 'manual', command: SETUP_RECIPE.mcp.register };

  // ── verify: the checks that make "set up" a claim with evidence ──
  const checks: SetupCheck[] = [];
  const afterText = readIfExists(configPath);
  const after = afterText === undefined ? undefined : parseConfig(afterText, configPath);
  checks.push({
    name: 'config parses',
    ok: after?.smeltConfig === CONFIG_VERSION,
    detail: `${CONFIG_FILE_NAME} read back and parsed`,
  });
  const storeDir =
    after?.store?.kind === 'directory' ? join(dirname(configPath), after.store.path) : undefined;
  if (storeDir === undefined) {
    checks.push({
      name: 'round trip',
      ok: true,
      detail: 'memory store — per-process by choice; retrieval works inside one process',
    });
  } else {
    checks.push(await probeRoundTrip(storeDir, budget));
  }

  // ── report ──
  for (const file of files) {
    say(`  ${file.name}: ${file.action}${file.detail === undefined ? '' : ` — ${file.detail}`}\n`);
  }
  for (const note of notes) say(`note: ${note}\n`);
  if (mcp.status === 'applied') {
    say(
      `MCP registration: written to the harness configs beside any servers you already ` +
        `had — \`smelt hooks remove\` takes it back out.\n`,
    );
  }
  if (mcp.status === 'manual') {
    say(
      `MCP registration stays in your hands (no selected harness carries it):\n` +
        `  ${mcp.command}\n` +
        `Codex and Grok spell it in TOML — packages/mcp/README.md has both.\n`,
    );
  }
  for (const check of checks) {
    say(`${check.ok ? ' ✓' : ' ✗'} ${check.name} — ${check.detail}\n`);
  }
  const failed = checks.filter((check) => !check.ok);
  const ok = failed.length === 0;
  if (!ok) {
    say(
      `${CLI_NAME} setup: ${String(failed.length)} check(s) failed — the setup is not ` +
        `finished. Fix the cause and re-run; setup is idempotent.\n`,
    );
  } else {
    say(
      `Done. \`${CLI_NAME} hooks install\` edits the hook toggles; ` +
        `\`${CLI_NAME} hooks remove\` takes it all back out.\n`,
    );
  }

  if (options.json) {
    const receipt: SetupReceipt = {
      format: 'smelt.setup.v1',
      cwd: io.cwd,
      config: { action: configAction },
      files,
      mcp,
      checks,
    };
    io.output(JSON.stringify(receipt, null, 2) + '\n');
  }
  return ok ? EXIT.ok : EXIT.refused;
}

/** The flow's own probe: elide, then read the exact bytes back out of the store. */
async function probeRoundTrip(storeDir: string, budget: number): Promise<SetupCheck> {
  mkdirSync(storeDir, { recursive: true });
  const store = new DirectoryElisionStore(storeDir);
  const smelter = createSmelter({ store });
  const result = await smelter.smelt(PROBE_SOURCE, {
    path: 'setup-probe.ts',
    focus: ['renderTicket'],
    budgetBytes: Math.min(budget, PROBE_BUDGET_BYTES),
  });
  if (result.elisions.length === 0) {
    return {
      name: 'round trip',
      ok: false,
      detail: `the probe produced no elisions at a ${String(PROBE_BUDGET_BYTES)}-byte budget`,
    };
  }
  const first = result.elisions[0]!;
  const original = PROBE_SOURCE.slice(first.range.start, first.range.end);
  const back = store.retrieve(first.hash);
  const ok = back === original;
  return {
    name: 'round trip',
    ok,
    detail: ok
      ? `${String(result.elisions.length)} elisions under the budget; the first cut's ` +
        `${String(first.range.end - first.range.start)} bytes retrieved byte-identical`
      : 'the store returned different bytes than were elided',
  };
}

// ── small shared pieces ─────────────────────────────────────────────────────────────

function hooksChoices(
  choices: SetupChoices,
  cwd: string,
  version: string | undefined,
): HooksChoices {
  return {
    harnesses: choices.harnesses,
    ...(version === undefined ? {} : { writtenBy: version }),
    // Read off what is actually installed, falling back to the installer's defaults
    // when nothing of smelt's is on disk — the same "edit, never reset" reading the
    // hooks installer itself uses. No second copy of the defaults lives here.
    ...presetToggles(cwd),
    enforcement: 'deny',
    thresholdBytes: DEFAULT_THRESHOLD_BYTES,
  };
}

function tierLine(profile: HarnessProfile): string {
  return `${profile.id.padEnd(12)} ${harnessLabel(profile).padEnd(16)} [${profile.tier}] — ${
    TIER_HONESTY[profile.tier]
  }`;
}

function describeStore(store: SmeltConfigStore | undefined): string {
  if (store === undefined) return 'none (the config keeps whatever it has)';
  return store.kind === 'memory' ? 'memory' : `directory at ${store.path}`;
}

function fileFate(file: {
  readonly name: string;
  readonly exists: boolean;
  readonly unchanged: boolean;
}): string {
  if (file.unchanged) return 'unchanged — nothing to write';
  if (file.exists) return 'exists — will be skipped, not overwritten';
  return 'new';
}
