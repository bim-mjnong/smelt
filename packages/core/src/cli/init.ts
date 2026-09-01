import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { CliUsageError } from '../errors.ts';

import { CLI_NAME } from './args.ts';
import { CONFIG_FILE_NAME, CONFIG_VERSION, findConfigFile, parseConfig } from './config.ts';
import type { SmeltConfig, SmeltConfigStore } from './config.ts';

/**
 * `smelt init` — the setup wizard.
 *
 * The same testability pattern as `run.ts`: the wizard is a pure function over an
 * input/output pair, so every flow — fresh run, back-navigation, re-run editing,
 * declined overwrites — runs in-process in tests, and `bin.ts` wires the real stdio.
 *
 * Three rules shape everything here:
 *
 *  1. **Nothing is written until the final confirm**, which lists exactly what will be
 *     written or changed. A wizard that writes as it goes cannot be backed out of.
 *  2. **An existing file is never overwritten without an explicit per-file yes.** Not
 *     a global "overwrite all", not a default — one question per existing file, and
 *     anything but a literal `yes` skips it. Guarded by
 *     `test/guards/init-wizard.test.ts`, with a mutation proving the guard goes red.
 *  3. **Every step accepts `back`.** A wizard you cannot reverse inside is a form.
 *
 * Law 4 note: the wizard's copy states what each choice *does*, never what it saves —
 * no percentages, no rates, no numbers smelt has not measured.
 */

/** The generated measure-hook stub's file name. */
export const MEASURE_STUB_FILE = 'smelt.measure.ts';

/** The generated reranker stub's file name. */
export const RERANK_STUB_FILE = 'smelt.rerank.ts';

/** Where the wizard's bytes come from and go. Injected so `runInit` is testable in-process. */
export interface InitIo {
  /** Interactive input — the real stdin in `bin.ts`, a scripted stream in tests. */
  readonly input: NodeJS.ReadableStream;
  readonly output: (text: string) => void;
  /**
   * Where config discovery starts, and where a fresh run's files land. An edit run
   * writes next to the discovered config instead — which may be an ancestor of `cwd`,
   * and the "About to write" listing names that directory before anything is written.
   */
  readonly cwd: string;
}

/** Everything the wizard decides. Pure data until the final confirm writes it. */
interface WizardChoices {
  budgetBytes: number | undefined;
  store: SmeltConfigStore;
  strategy: 'lexical' | 'structural';
  /** Generate {@link MEASURE_STUB_FILE}? Never deletes an existing one. */
  measureStub: boolean;
  /** Generate {@link RERANK_STUB_FILE}? Never deletes an existing one. */
  rerankStub: boolean;
}

type StepOutcome = 'ok' | 'back';

interface PlannedWrite {
  readonly name: string;
  readonly path: string;
  readonly content: string;
  readonly exists: boolean;
  /** The file already holds exactly these bytes — nothing to write. */
  readonly unchanged: boolean;
}

/**
 * The wizard, start to finish. Returns an exit code (0 in every completed flow,
 * including "declined to write anything").
 *
 * @throws {CliUsageError} on a malformed existing config, or when input ends before
 *   the wizard finishes — both are usage-shaped, and nothing further is written.
 */
export async function runInit(io: InitIo): Promise<number> {
  const rl = createInterface({ input: io.input });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (prompt: string): Promise<string> => {
    io.output(prompt);
    const next = await lines.next();
    if (next.done === true) {
      throw new CliUsageError(
        `${CLI_NAME} init: input ended before the wizard finished. ` +
          `Files already confirmed and written stay; nothing further was written.`,
      );
    }
    return next.value.trim();
  };

  try {
    const existing = loadExisting(io.cwd);
    return existing === undefined
      ? await freshRun(io, ask)
      : await editRun(io, ask, existing.path, existing.config);
  } finally {
    rl.close();
  }
}

function loadExisting(cwd: string): { path: string; config: SmeltConfig } | undefined {
  const path = findConfigFile(cwd);
  if (path === undefined) return undefined;
  // Malformed is a loud usage error, not a silent fresh start: overwriting a config
  // the user wrote, because it had a typo, would be the wizard deciding for them.
  return { path, config: parseConfig(readFileSync(path, 'utf8'), path) };
}

// ---------------------------------------------------------------------------
// The two flows
// ---------------------------------------------------------------------------

type Asker = (prompt: string) => Promise<string>;

interface Step {
  readonly id: 'budget' | 'store' | 'strategy' | 'measure' | 'rerank';
  run(io: InitIo, ask: Asker, choices: WizardChoices, dir: string): Promise<StepOutcome>;
}

const STEPS: readonly Step[] = [
  { id: 'budget', run: stepBudget },
  { id: 'store', run: stepStore },
  { id: 'strategy', run: stepStrategy },
  { id: 'measure', run: stepMeasure },
  { id: 'rerank', run: stepRerank },
];

async function freshRun(io: InitIo, ask: Asker): Promise<number> {
  io.output(
    `${CLI_NAME} init — sets up ${CONFIG_FILE_NAME} in ${io.cwd}.\n` +
      `Answer \`back\` at any step to return to the previous one. ` +
      `Nothing is written until you confirm at the end.\n\n`,
  );
  const choices: WizardChoices = {
    budgetBytes: undefined,
    store: { kind: 'memory' },
    strategy: 'lexical',
    measureStub: false,
    rerankStub: false,
  };

  let index = 0;
  for (;;) {
    while (index < STEPS.length) {
      const outcome = await STEPS[index]!.run(io, ask, choices, io.cwd);
      if (outcome === 'back') {
        if (index === 0) io.output(`This is the first step — there is nothing before it.\n`);
        else index -= 1;
      } else {
        index += 1;
      }
    }
    const verdict = await confirmAndWrite(io, ask, choices, io.cwd);
    if (verdict !== 'back') return 0;
    index = STEPS.length - 1;
  }
}

async function editRun(
  io: InitIo,
  ask: Asker,
  configPath: string,
  config: SmeltConfig,
): Promise<number> {
  const dir = dirname(configPath);
  const choices: WizardChoices = {
    budgetBytes: config.defaultBudgetBytes,
    store: config.store ?? { kind: 'memory' },
    strategy: config.strategy ?? 'lexical',
    measureStub: false,
    rerankStub: false,
  };

  io.output(
    `${CLI_NAME} init — ${CONFIG_FILE_NAME} already exists at ${configPath}.\n` +
      `Change one setting at a time; nothing is written until you confirm.\n`,
  );

  for (;;) {
    io.output(`\nCurrent values:\n${summary(choices, dir)}\n`);
    const answer = await ask(
      `Change which setting? (budget / store / strategy / measure / rerank, ` +
        `\`done\` to review and confirm, \`back\` to leave without writing)\n> `,
    );
    if (answer === 'back') {
      io.output(`Left as it was. Nothing has been written.\n`);
      return 0;
    }
    if (answer === 'done') {
      const verdict = await confirmAndWrite(io, ask, choices, dir);
      if (verdict !== 'back') return 0;
      continue; // back from confirm returns to this menu
    }
    const step = STEPS.find((candidate) => candidate.id === answer);
    if (step === undefined) {
      io.output(`Not a setting: "${answer}". One of: budget, store, strategy, measure, rerank.\n`);
      continue;
    }
    await step.run(io, ask, choices, dir); // its own `back` returns here
  }
}

function summary(choices: WizardChoices, dir: string): string {
  const stubLine = (file: string, generate: boolean): string => {
    if (generate) return `generate ${file}`;
    return existsSync(join(dir, file)) ? `${file} exists (kept as is)` : 'none';
  };
  return [
    `  budget:    ${choices.budgetBytes === undefined ? '(not set)' : `${String(choices.budgetBytes)} bytes`}`,
    `  store:     ${choices.store.kind === 'memory' ? 'memory' : `directory (${choices.store.path})`}`,
    `  strategy:  ${choices.strategy}`,
    `  measure:   ${stubLine(MEASURE_STUB_FILE, choices.measureStub)}`,
    `  rerank:    ${stubLine(RERANK_STUB_FILE, choices.rerankStub)}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// The steps. Each one accepts `back`.
// ---------------------------------------------------------------------------

async function stepBudget(io: InitIo, ask: Asker, choices: WizardChoices): Promise<StepOutcome> {
  io.output(
    `\nDefault byte budget — used when a \`${CLI_NAME}\` run omits --budget.\n` +
      `Budgets are UTF-8 bytes, permanently; an explicit --budget always wins.\n` +
      `There is no suggested number: the right budget depends on your traffic, and ` +
      `smelt does not invent numbers it has not measured.\n`,
  );
  for (;;) {
    const current = choices.budgetBytes === undefined ? '' : ` [${String(choices.budgetBytes)}]`;
    const answer = await ask(`budget in bytes${current} (or back)> `);
    if (answer === 'back') return 'back';
    if (answer === '' && choices.budgetBytes !== undefined) return 'ok';
    if (/^\d+$/.test(answer) && Number(answer) > 0) {
      choices.budgetBytes = Number(answer);
      return 'ok';
    }
    io.output(`A whole number of bytes greater than zero, e.g. 4000.\n`);
  }
}

async function stepStore(io: InitIo, ask: Asker, choices: WizardChoices): Promise<StepOutcome> {
  io.output(
    `\nWhere elided bytes live. Every elision is reversible only while a store holds ` +
      `its bytes (Law 3):\n` +
      `  1. memory     — per-process; retrievals do not survive the process\n` +
      `  2. directory  — persistent, content-addressed, on disk; retrieval counters ` +
      `survive restarts\n`,
  );
  for (;;) {
    const current = choices.store.kind === 'memory' ? '1' : '2';
    const answer = await ask(`store (1/2) [${current}] (or back)> `);
    if (answer === 'back') return 'back';
    const pick = answer === '' ? current : answer;
    if (pick === '1') {
      choices.store = { kind: 'memory' };
      return 'ok';
    }
    if (pick === '2') {
      const previous = choices.store.kind === 'directory' ? choices.store.path : '.smelt/store';
      const path = await ask(`store directory, relative to ${CONFIG_FILE_NAME} [${previous}]> `);
      if (path === 'back') continue; // back to the store choice, not out of the step
      choices.store = { kind: 'directory', path: path === '' ? previous : path };
      return 'ok';
    }
    io.output(`1 for memory, 2 for directory, or back.\n`);
  }
}

async function stepStrategy(io: InitIo, ask: Asker, choices: WizardChoices): Promise<StepOutcome> {
  io.output(
    `\nDefault planner strategy — used when a run omits --strategy:\n` +
      `  1. lexical     — line windows around your focus terms; works on any text\n` +
      `  2. structural  — parses typescript and tsx with a bundled grammar and ` +
      `collapses siblings by name; refuses other languages rather than approximating\n`,
  );
  for (;;) {
    const current = choices.strategy === 'lexical' ? '1' : '2';
    const answer = await ask(`strategy (1/2) [${current}] (or back)> `);
    if (answer === 'back') return 'back';
    const pick = answer === '' ? current : answer;
    if (pick === '1' || pick === '2') {
      choices.strategy = pick === '1' ? 'lexical' : 'structural';
      return 'ok';
    }
    io.output(`1 for lexical, 2 for structural, or back.\n`);
  }
}

async function stepMeasure(
  io: InitIo,
  ask: Asker,
  choices: WizardChoices,
  dir: string,
): Promise<StepOutcome> {
  const exists = existsSync(join(dir, MEASURE_STUB_FILE));
  io.output(
    `\nMeasure hook — your own counter (a tokenizer, usually), so results carry a ` +
      `second, labelled number next to the byte counts. smelt ships none: a token ` +
      `count without its tokenizer named is not a measurement.\n` +
      `  1. none\n` +
      `  2. generate ${MEASURE_STUB_FILE}, a typed stub you fill in\n` +
      (exists ? `(${MEASURE_STUB_FILE} already exists; it is never deleted from here.)\n` : ``),
  );
  for (;;) {
    const answer = await ask(`measure (1/2) [${choices.measureStub ? '2' : '1'}] (or back)> `);
    if (answer === 'back') return 'back';
    const pick = answer === '' ? (choices.measureStub ? '2' : '1') : answer;
    if (pick === '1' || pick === '2') {
      choices.measureStub = pick === '2';
      return 'ok';
    }
    io.output(`1 for none, 2 to generate the stub, or back.\n`);
  }
}

async function stepRerank(
  io: InitIo,
  ask: Asker,
  choices: WizardChoices,
  dir: string,
): Promise<StepOutcome> {
  const exists = existsSync(join(dir, RERANK_STUB_FILE));
  io.output(
    `\nReranker — a RerankStage of your own. smelt never bundles one and never will: ` +
      `an outbound call must live in your code, under your key, visible in your own ` +
      `review (Law 1).\n` +
      `  1. none\n` +
      `  2. generate ${RERANK_STUB_FILE}, a typed stub with the HTTP call sketched as a TODO\n` +
      (exists ? `(${RERANK_STUB_FILE} already exists; it is never deleted from here.)\n` : ``),
  );
  for (;;) {
    const answer = await ask(`rerank (1/2) [${choices.rerankStub ? '2' : '1'}] (or back)> `);
    if (answer === 'back') return 'back';
    const pick = answer === '' ? (choices.rerankStub ? '2' : '1') : answer;
    if (pick === '1' || pick === '2') {
      choices.rerankStub = pick === '2';
      return 'ok';
    }
    io.output(`1 for none, 2 to generate the stub, or back.\n`);
  }
}

// ---------------------------------------------------------------------------
// The confirm step: the only place anything is written
// ---------------------------------------------------------------------------

const writeLabel = (write: PlannedWrite): string => {
  if (write.unchanged) return 'unchanged — nothing to write';
  return write.exists ? 'exists — will ask before overwriting' : 'new';
};

async function confirmAndWrite(
  io: InitIo,
  ask: Asker,
  choices: WizardChoices,
  dir: string,
): Promise<'done' | 'back'> {
  if (choices.budgetBytes === undefined) {
    // Unreachable in the fresh flow (the budget step requires a number) but reachable
    // from an edit of a config that never had one — `defaultBudgetBytes` is optional,
    // so such a config parses fine. The wizard still insists: a confirm without a
    // budget would write a file this wizard just called incomplete. `back` here is a
    // real `back` — it returns to the caller, never falls forward into the confirm.
    io.output(`No budget is set yet — set one before confirming.\n`);
    if ((await stepBudget(io, ask, choices)) === 'back') return 'back';
  }

  const writes = plannedWrites(choices, dir);
  io.output(
    `\nAbout to write, into ${dir}:\n` +
      writes.map((write) => `  ${write.name.padEnd(20)} (${writeLabel(write)})\n`).join('') +
      `Nothing has been written yet.\n`,
  );

  for (;;) {
    const answer = await ask(`confirm (yes / no / back)> `);
    if (answer === 'back') return 'back';
    if (answer === 'no') {
      io.output(`Nothing was written.\n`);
      return 'done';
    }
    if (answer === 'yes') break;
    io.output(`yes to write, no to leave everything untouched, back to change a setting.\n`);
  }

  for (const write of writes) {
    if (write.unchanged) {
      io.output(`  ${write.name} — unchanged, not rewritten\n`);
      continue;
    }
    if (write.exists) {
      // The per-file consent rule: one explicit question per existing file, and only
      // a literal `yes` overwrites. This is the line the mutation
      // `init-overwrite-without-consent` breaks to prove the guard can go red.
      const answer = await ask(`  ${write.name} exists — overwrite it? (yes/no)> `);
      if (answer !== 'yes') {
        io.output(`  skipped ${write.name} — the existing file was not touched\n`);
        continue;
      }
    }
    writeFileSync(write.path, write.content);
    io.output(`  wrote ${write.name}\n`);
  }
  io.output(`Done.\n`);
  return 'done';
}

function plannedWrites(choices: WizardChoices, dir: string): readonly PlannedWrite[] {
  const plan = (name: string, content: string): PlannedWrite => {
    const path = join(dir, name);
    const exists = existsSync(path);
    const unchanged = exists && readFileSync(path, 'utf8') === content;
    return { name, path, content, exists, unchanged };
  };
  const writes = [plan(CONFIG_FILE_NAME, renderConfig(choices))];
  if (choices.measureStub) writes.push(plan(MEASURE_STUB_FILE, measureStubSource()));
  if (choices.rerankStub) writes.push(plan(RERANK_STUB_FILE, rerankStubSource()));
  return writes;
}

/** The config file, serialized with a stable key order so re-runs diff cleanly. */
export function renderConfig(choices: {
  readonly budgetBytes: number | undefined;
  readonly store: SmeltConfigStore;
  readonly strategy: 'lexical' | 'structural';
}): string {
  const config: SmeltConfig = {
    smeltConfig: CONFIG_VERSION,
    ...(choices.budgetBytes === undefined ? {} : { defaultBudgetBytes: choices.budgetBytes }),
    strategy: choices.strategy,
    store: choices.store,
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// The generated stubs. String literals on purpose: smelt's own import graph must not
// gain an HTTP client, and the zero-network guard's string-stripper ignores string
// bodies — the sketched fetch below lives in the CONSUMER'S file, never in smelt's.
//
// The comment token between `from` and the package name in each stub's import line is
// deliberate: the guard's import scanner reads raw source, so spelling that import
// plainly inside this template would register as an edge in smelt's own graph — which
// it is not. The comment keeps the generated file valid TypeScript while keeping this
// data out of the guard's walk.
// ---------------------------------------------------------------------------

/** The `smelt.measure.ts` the wizard writes. Exported so tests can compile it. */
export function measureStubSource(): string {
  return `/**
 * Measure hook — generated by \`smelt init\`.
 *
 * smelt's budgets are UTF-8 bytes, permanently; this hook adds a second, labelled
 * number to every result in YOUR unit, counted by YOUR tokenizer. Both \`id\` and
 * \`unit\` are required: a count without the counter named is not a measurement.
 *
 * Wire it in, in your own code:
 *
 *   const smelter = createSmelter({ defaultBudgetBytes: 8_000, measure });
 *
 * with createSmelter imported from your @smeltjs/core install and measure from here.
 */
import type { Measure } from /* your install */ '@smeltjs/core';

export const measure: Measure = {
  // TODO: name the counter that produces these numbers, e.g. 'tiktoken/o200k_base'.
  id: 'TODO/your-tokenizer',
  unit: 'tokens',
  count(text: string): number {
    // TODO: replace with your real tokenizer. It must be local and synchronous —
    // a count() that calls an API would make your process call an API on every smelt.
    // e.g.  return encode(text).length;
    throw new Error(
      'smelt.measure.ts: count() is not implemented yet — ' +
        'fill it in with your tokenizer (length of input: ' + String(text.length) + ')',
    );
  },
};
`;
}

/** The `smelt.rerank.ts` the wizard writes. Exported so tests can compile it. */
export function rerankStubSource(): string {
  return `/**
 * Reranker stub — generated by \`smelt init\`.
 *
 * smelt itself makes zero network calls and never bundles a reranker (Law 1): the
 * moment one ships as a default, every consumer's source code leaves the machine and
 * they find out from a changelog, or never. So the outbound call lives HERE, in your
 * file, reading your env var, visible in your own review.
 *
 * Wire it into your own pipeline; smelt never calls this for you.
 */
import type { RerankCandidate, RerankedCandidate, RerankStage } from /* your install */ '@smeltjs/core';

/** The env var YOUR code reads. Rename it to match your vendor. */
const API_KEY_ENV = 'RERANKER_API_KEY';

export const rerank: RerankStage = {
  id: 'my-reranker/v1',
  async rerank(
    candidates: readonly RerankCandidate[],
    query: string,
  ): Promise<readonly RerankedCandidate[]> {
    const apiKey = process.env[API_KEY_ENV];
    if (apiKey === undefined || apiKey === '') {
      throw new Error(
        'smelt.rerank.ts: ' + API_KEY_ENV + ' is not set. This stage makes an outbound ' +
          'HTTP call from YOUR code with YOUR key; without a key it refuses to pretend.',
      );
    }

    // TODO: the outbound call. Voyage AI is one example vendor; any reranker with an
    // HTTP API fits this shape:
    //
    //   const response = await fetch('https://api.voyageai.com/v1/rerank', {
    //     method: 'POST',
    //     headers: {
    //       'content-type': 'application/json',
    //       authorization: \`Bearer \${apiKey}\`,
    //     },
    //     body: JSON.stringify({
    //       query,
    //       documents: candidates.map((candidate) => candidate.text),
    //     }),
    //   });
    //   if (!response.ok) throw new Error('rerank failed: ' + String(response.status));
    //   const body = (await response.json()) as {
    //     data: { index: number; relevance_score: number }[];
    //   };
    //   return body.data.map(({ index, relevance_score }) => ({
    //     ...candidates[index]!,
    //     score: relevance_score,
    //   }));
    //
    void candidates;
    void query;
    throw new Error(
      'smelt.rerank.ts: implement the outbound call sketched above, then delete this throw.',
    );
  },
};
`;
}
