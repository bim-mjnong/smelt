import { nodeFsReader } from '../repomap/reader.ts';
import type { RepoReader } from '../repomap/reader.ts';
import type { ElisionReason } from '../types.ts';

import { citing, GUIDE } from './guide.ts';
import { readInstructionSet, resolvesInTree } from './instructions.ts';
import type { InstructionFile, InstructionSet } from './instructions.ts';

/**
 * `smelt agents lint` — the audit of the blob an agent loads on **every** request.
 *
 * smelt's whole subject is what a context window is spent on, and an instruction file
 * is the one blob every request pays for whether or not it is relevant. So the lint is
 * the same three moves smelt makes everywhere else, aimed at a file nobody measures:
 *
 *  1. **Measure, never threshold** (ruling R2). Bytes per level and in total, plus an
 *     imperative count that says out loud it is a heuristic. The only number that can
 *     fail a run is `agents.budgetBytes` in `smelt.config.json` — *the user's own*.
 *     There is no built-in budget, for exactly the reason `--budget` has none.
 *  2. **Explain every finding** (Law 2, in the {@link ElisionReason} discipline). A
 *     finding is a stable `rule` id plus a sentence, and the sentence ends in a phrase
 *     from the guide it is applying, attributed — see `./guide.ts`.
 *  3. **Resolve against the real tree** (ruling R3). `dead-path` and `dead-link` are
 *     the checks nobody else makes, because everyone else is linting Markdown while
 *     the thing that has rotted is the *repository the Markdown describes*. A renamed
 *     `src/auth/handlers.ts` does not make the file invalid; it makes it a lie that
 *     the agent believes on every request.
 *
 * **Advisory by default.** Findings exit 0. `--strict` turns any finding into exit 1
 * for CI, because a check that cannot be enforced is a check nobody runs, and a check
 * that is enforced by default is smelt deciding somebody's house style for them.
 *
 * The heuristics here are heuristics, and each is labelled as one where it surfaces.
 * A rule that fires on a file the guide would call minimal is not automatically a bug
 * in the file — it may be a bug in the rule, or in the guide, and the answer is worth
 * writing down either way (ruling R9; see this repository's own `AGENTS.md`).
 */

/* ------------------------------------------------------------------------------------
 * Rule ids — stable, and the whole machine-readable surface of a finding
 * ---------------------------------------------------------------------------------- */

/** A path-like token in the prose that resolves to nothing in the tree. The flagship. */
export const DEAD_PATH_RULE = 'dead-path';
/** A Markdown link whose relative target is not in the tree. */
export const DEAD_LINK_RULE = 'dead-link';
/** "always", "never", ALL-CAPS forcing. */
export const FORCING_LANGUAGE_RULE = 'forcing-language';
/** A directory tree, or a run of bare path lines. */
export const STRUCTURE_DUMP_RULE = 'structure-dump';
/** The fingerprints an init script leaves. The softest rule here, and it says so. */
export const GENERATED_BOILERPLATE_RULE = 'generated-boilerplate';
/** A code-style rule that loads on every request to be relevant on some of them. */
export const LANGUAGE_RULE_RULE = 'language-rule';
/** A mirror (CLAUDE.md / GEMINI.md) that has diverged from its AGENTS.md. */
export const MIRROR_DRIFT_RULE = 'mirror-drift';
/** The same instruction present at two levels of the merged set. */
export const RESTATED_AT_LEVEL_RULE = 'restated-at-level';

/**
 * The rules a finding can carry, in report order.
 *
 * `Object.freeze`-flat on purpose: the ids are a wire surface. They go into `--json`,
 * into CI greps and into whatever a user filters on, so they are declared once and
 * never spelled again in prose.
 */
export const AGENTS_LINT_RULES = [
  DEAD_PATH_RULE,
  DEAD_LINK_RULE,
  FORCING_LANGUAGE_RULE,
  STRUCTURE_DUMP_RULE,
  GENERATED_BOILERPLATE_RULE,
  LANGUAGE_RULE_RULE,
  MIRROR_DRIFT_RULE,
  RESTATED_AT_LEVEL_RULE,
] as const;

/**
 * The imperative counter's rule id (ruling R6).
 *
 * **Deliberately not in {@link AGENTS_LINT_RULES}.** An imperative is not a defect —
 * an instruction file is *made* of imperatives — so counting them is a measurement,
 * like `outputBytes`, and putting them among the findings would make `--strict` red on
 * every real AGENTS.md and therefore useless. Each counted line still carries a
 * receipt naming the verb that matched, because a heuristic whose matches you cannot
 * inspect is a number nobody can check.
 */
export const IMPERATIVE_LINE_RULE = 'imperative-line';

/* ------------------------------------------------------------------------------------
 * The report
 * ---------------------------------------------------------------------------------- */

/** One thing the lint noticed, at one place, with its reason. */
export interface AgentsFinding {
  /** Root-relative path of the instruction file. */
  readonly file: string;
  /** 1-based line within that file. */
  readonly line: number;
  /** Stable `rule` id plus the sentence explaining it — Law 2's shape. */
  readonly reason: ElisionReason;
}

/** What one level of the merged set costs, and what stands beside it. */
export interface AgentsLevelReport {
  /** Root-relative directory; `''` is the repository root. */
  readonly dir: string;
  /** The file this level contributes — see {@link InstructionLevel}. */
  readonly path: string;
  readonly bytes: number;
  /** The mirrors at this level, and how each one stands. */
  readonly mirrors: readonly AgentsMirrorReport[];
}

/** A `CLAUDE.md`/`GEMINI.md` beside an `AGENTS.md`, and whether it can drift. */
export interface AgentsMirrorReport {
  readonly path: string;
  readonly bytes: number;
  /**
   * `'symlink'` — the arrangement the guide recommends, and the only one in which
   * drift is impossible. `'copy'` — byte-identical today. `'drift'` — diverged, and a
   * {@link MIRROR_DRIFT_RULE} finding.
   */
  readonly standing: 'symlink' | 'copy' | 'drift';
}

/** Everything one `smelt agents lint` run measured and found. */
export interface AgentsLintReport {
  /** The directory that was linted, as the caller spelled it. */
  readonly root: string;
  /** Root level first. Empty when the tree holds no instruction file at all. */
  readonly levels: readonly AgentsLevelReport[];
  /** The sum of every level's primary: what an agent loads on every request. */
  readonly totalBytes: number;
  /** Present only when `smelt.config.json` set one. There is no default (R2). */
  readonly budgetBytes?: number;
  /**
   * Lines counted as instructions, each with the verb that matched. The *count* is the
   * headline (`imperatives (heuristic)`); the receipts make it checkable.
   */
  readonly imperatives: readonly AgentsFinding[];
  /** Every advisory finding, grouped by rule in {@link AGENTS_LINT_RULES} order. */
  readonly findings: readonly AgentsFinding[];
}

/** What `lintAgents` needs. Everything but the root has a default. */
export interface AgentsLintOptions {
  /** The repository root to lint. */
  readonly root: string;
  /** The tree seam. Defaults to {@link nodeFsReader}. */
  readonly reader?: RepoReader;
  /** Replaces the built-in ignore list when given. */
  readonly ignore?: readonly string[];
  /** The user's budget, from `smelt.config.json`. Absent means unbudgeted (R2). */
  readonly budgetBytes?: number;
}

/**
 * Lint the merged set under `root`.
 *
 * Pure over its inputs and its reader: nothing is written, and every filesystem touch
 * goes through {@link RepoReader}, which has no writer on it.
 */
export function lintAgents(options: AgentsLintOptions): AgentsLintReport {
  const reader = options.reader ?? nodeFsReader();
  const set = readInstructionSet({
    root: options.root,
    reader,
    ...(options.ignore === undefined ? {} : { ignore: options.ignore }),
  });

  const findings: AgentsFinding[] = [];
  const imperatives: AgentsFinding[] = [];

  for (const level of set.levels) {
    // The imperative count is a companion to the byte total, so it is counted over
    // exactly what the byte total is counted over: the primaries. A mirror is an
    // alternative spelling of a level, not a second level — counting it would make
    // the headline number describe a request nobody makes.
    imperatives.push(...countImperatives(level.primary, scanLines(level.primary.text)));

    // The rules, though, run over the primary **and every mirror that has actually
    // diverged**: a drifted CLAUDE.md is what Claude Code loads, so its own dead paths
    // are real. A symlink or a byte-identical copy is skipped — it would mint a
    // duplicate of every finding on the primary and say nothing new.
    const linted = [
      level.primary,
      ...level.mirrors.filter((mirror) => standingOf(level.primary, mirror) === 'drift'),
    ];
    for (const file of linted) {
      const lines = scanLines(file.text);
      findings.push(...findDeadLinks(file, lines, options.root, reader));
      findings.push(...findDeadPaths(file, lines, options.root, reader));
      findings.push(...findForcingLanguage(file, lines));
      findings.push(...findStructureDumps(file, lines));
      findings.push(...findGeneratedBoilerplate(file, lines));
      findings.push(...findLanguageRules(file, lines));
    }
    findings.push(...findMirrorDrift(level.primary, level.mirrors));
  }
  findings.push(...findRestatedAcrossLevels(set));

  return {
    root: options.root,
    levels: set.levels.map((level) => ({
      dir: level.dir,
      path: level.primary.path,
      bytes: level.primary.bytes,
      mirrors: level.mirrors.map((mirror) => ({
        path: mirror.path,
        bytes: mirror.bytes,
        standing: standingOf(level.primary, mirror),
      })),
    })),
    totalBytes: set.totalBytes,
    ...(options.budgetBytes === undefined ? {} : { budgetBytes: options.budgetBytes }),
    imperatives,
    findings: findings.toSorted(byRuleThenPlace),
  };
}

/** How far over the user's budget the merged set is, or `undefined` when it fits. */
export function overBudgetBytes(report: AgentsLintReport): number | undefined {
  if (report.budgetBytes === undefined) return undefined;
  const over = report.totalBytes - report.budgetBytes;
  return over > 0 ? over : undefined;
}

/** Findings in report order: rule first, then where they were found. */
function byRuleThenPlace(a: AgentsFinding, b: AgentsFinding): number {
  const rank =
    ruleOrder(a.reason.rule) - ruleOrder(b.reason.rule) ||
    (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
    a.line - b.line;
  return rank;
}

function ruleOrder(rule: string): number {
  const index = (AGENTS_LINT_RULES as readonly string[]).indexOf(rule);
  return index === -1 ? AGENTS_LINT_RULES.length : index;
}

/* ------------------------------------------------------------------------------------
 * Scanning: prose versus fences
 * ---------------------------------------------------------------------------------- */

/** One line of an instruction file, with the one fact every rule branches on. */
interface ScannedLine {
  /** 1-based. */
  readonly number: number;
  readonly text: string;
  /** True inside a fenced code block, including the fence lines themselves. */
  readonly fenced: boolean;
  /** True for the ``` or ~~~ line that opens a block. */
  readonly opensFence: boolean;
}

/**
 * Split a file into lines, marking fenced code.
 *
 * The distinction matters in both directions: a `const x = 1` inside a fence is an
 * *example*, not a `language-rule`, and a tree drawing is only a `structure-dump`
 * because it is a fence full of paths. Rules that read prose skip fences; the one
 * rule that reads fences skips prose.
 */
function scanLines(text: string): readonly ScannedLine[] {
  const out: ScannedLine[] = [];
  let fence: string | undefined;
  text.split('\n').forEach((line, index) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    const opensFence = marker !== null && fence === undefined;
    if (marker !== null) {
      if (fence === undefined) fence = marker[1]!.slice(0, 1);
      else if (marker[1]!.startsWith(fence)) fence = undefined;
      out.push({ number: index + 1, text: line, fenced: true, opensFence });
      return;
    }
    out.push({ number: index + 1, text: line, fenced: fence !== undefined, opensFence: false });
  });
  return out;
}

/** A line stripped of list bullets, heading hashes, blockquote marks and bold runs. */
function bareText(text: string): string {
  return text
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+|>\s*)+/, '')
    .replace(/\*\*/g, '')
    .trim();
}

/* ------------------------------------------------------------------------------------
 * imperative-line — a labelled heuristic (R6)
 * ---------------------------------------------------------------------------------- */

/**
 * The openers counted as an instruction.
 *
 * A closed list, deliberately: an open-ended part-of-speech guess would be a number
 * nobody could reproduce, and this figure is reported beside a byte count that *is*
 * exact. The modal openers the guide itself names — always / never / do not / must /
 * should — are here alongside the verbs an instruction file actually opens with.
 */
const IMPERATIVE_OPENERS: readonly string[] = [
  'add',
  'always',
  'avoid',
  'build',
  'check',
  'commit',
  'create',
  'do',
  'document',
  'ensure',
  'follow',
  'format',
  'ignore',
  'implement',
  'install',
  'keep',
  'lint',
  'make',
  'must',
  'name',
  'never',
  'place',
  'prefer',
  'put',
  'read',
  'refuse',
  'remove',
  'return',
  'run',
  'should',
  'skip',
  'test',
  'throw',
  'treat',
  'update',
  'use',
  'verify',
  'write',
];

/**
 * Count the lines that read as instructions, one receipt each.
 *
 * Reported as `imperatives (heuristic)` and never as a precise figure, because it is
 * not one: "Run `pnpm verify`" counts and "The gate is `pnpm verify`" does not, and
 * both are the same instruction. The number is useful as a *scale* — the guide cites
 * ~150-200 as what a frontier thinking model follows consistently — and useless as a
 * threshold, which is why nothing here compares it to anything.
 */
function countImperatives(file: InstructionFile, lines: readonly ScannedLine[]): AgentsFinding[] {
  const out: AgentsFinding[] = [];
  for (const line of lines) {
    if (line.fenced) continue;
    const bare = bareText(line.text);
    if (bare === '') continue;
    const opener = /^(do not|[A-Za-z']+)/.exec(bare.toLowerCase())?.[1];
    if (opener === undefined) continue;
    const matched = opener === 'do not' ? 'do not' : opener === "don't" ? "don't" : opener;
    const counted =
      matched === 'do not' ||
      matched === "don't" ||
      IMPERATIVE_OPENERS.includes(matched.replace(/'.*$/, ''));
    if (!counted) continue;
    out.push({
      file: file.path,
      line: line.number,
      reason: {
        rule: IMPERATIVE_LINE_RULE,
        explanation:
          `opens with "${matched}", so it is counted as one instruction (heuristic)` +
          citing(GUIDE.instructionCeiling),
      },
    });
  }
  return out;
}

/* ------------------------------------------------------------------------------------
 * dead-link — a Markdown link whose target left the tree
 * ---------------------------------------------------------------------------------- */

/** `[text](target)`, with the target captured. */
const MARKDOWN_LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function findDeadLinks(
  file: InstructionFile,
  lines: readonly ScannedLine[],
  root: string,
  reader: RepoReader,
): AgentsFinding[] {
  const out: AgentsFinding[] = [];
  for (const line of lines) {
    if (line.fenced) continue;
    for (const match of line.text.matchAll(MARKDOWN_LINK)) {
      const target = stripFragment(match[1]!);
      if (target === '' || isExternal(target)) continue;
      const resolved = resolveAgainst(file.dir, target);
      if (resolvesInTree(root, reader, resolved)) continue;
      out.push({
        file: file.path,
        line: line.number,
        reason: {
          rule: DEAD_LINK_RULE,
          explanation:
            `links to \`${target}\`, which is not in the tree — the pointer the root ` +
            `file exists to be goes nowhere` +
            citing(GUIDE.pointsElsewhere),
        },
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------------------------
 * dead-path — the flagship (R3)
 * ---------------------------------------------------------------------------------- */

/** A token with a directory separator: `src/auth`, `./scripts/build.mjs`, `docs/`. */
const SLASHED = /^\.{0,2}\/?[\w.+-]+(?:\/[\w.+-]+)*\/?$/;
/** A bare file name whose extension says "this is a file in this repo". */
const CODE_FILE = /^[\w.-]+\.(?:[cm]?[jt]sx?|json|md|ya?ml|toml|py|rs|go|rb|java|sh|sql|css|html)$/;

function findDeadPaths(
  file: InstructionFile,
  lines: readonly ScannedLine[],
  root: string,
  reader: RepoReader,
): AgentsFinding[] {
  const out: AgentsFinding[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    if (line.fenced) continue;
    // Markdown link targets belong to `dead-link`; blank them so one dead pointer is
    // never reported twice under two rules.
    const withoutLinks = line.text.replace(MARKDOWN_LINK, '[]()');
    for (const token of pathCandidates(withoutLinks)) {
      const key = `${String(line.number)} ${token}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const resolved = resolveAgainst(file.dir, token);
      if (resolvesInTree(root, reader, resolved)) continue;
      out.push({
        file: file.path,
        line: line.number,
        reason: {
          rule: DEAD_PATH_RULE,
          explanation:
            `names \`${token}\`, which resolves to nothing in this tree — an agent ` +
            `reads this on every request and looks there anyway` +
            citing(GUIDE.stalenessPoisons),
        },
      });
    }
  }
  return out;
}

/**
 * The path-like tokens on one line.
 *
 * Inline code spans first, because a path in an instruction file is nearly always in
 * backticks; then bare words, filtered hard. The filters are the interesting part —
 * every one of them is a false positive this rule made before it had them:
 *
 *  - `https://…`, `mailto:` — not tree paths.
 *  - `@smeltjs/core`, `@types/node` — package names, which look exactly like paths.
 *  - `src/**\/*.ts` — a glob describes a set, and a set does not resolve.
 *  - `pnpm run build`, `and/or` — anything with whitespace, and anything whose
 *    segments carry no extension and no separator worth trusting.
 *  - `v1.2/v2` style version prose, caught by requiring a real segment shape.
 */
function pathCandidates(text: string): readonly string[] {
  const tokens: string[] = [];
  const add = (raw: string): void => {
    const token = raw.replace(/[),.:;]+$/, '').trim();
    if (token === '' || !isPathLike(token)) return;
    tokens.push(token);
  };
  const withoutCode = text.replace(/`([^`]+)`/g, (_whole, inner: string) => {
    add(inner);
    return ' ';
  });
  for (const word of withoutCode.split(/\s+/)) add(word);
  return tokens;
}

function isPathLike(token: string): boolean {
  if (isExternal(token)) return false;
  if (token.startsWith('@')) return false;
  if (/[*?[\]{}<>|"'`\\]/.test(token)) return false;
  if (token.startsWith('#')) return false;
  if (!SLASHED.test(token)) return false;
  return token.includes('/') || CODE_FILE.test(token);
}

/** True for anything that is not a path into this tree. */
function isExternal(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//') || target.startsWith('#');
}

function stripFragment(target: string): string {
  const cut = target.indexOf('#');
  return cut === -1 ? target : target.slice(0, cut);
}

/**
 * A token in a nested instruction file is relative to *that* file's directory, which
 * is the whole reason a nested file can hold a link the root one cannot. `../` is
 * resolved rather than refused, so a nested file may point back up the tree.
 */
function resolveAgainst(dir: string, token: string): string {
  const base = dir === '' ? [] : dir.split('/');
  const parts = token.replace(/\/+$/, '').split('/');
  const stack = [...base];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

/* ------------------------------------------------------------------------------------
 * forcing-language
 * ---------------------------------------------------------------------------------- */

/** ALL-CAPS words a reader meets as shouting rather than as an acronym. */
const SHOUTED = /\b(ALWAYS|NEVER|MUST|DO NOT|DON'T|REQUIRED|MANDATORY|CRITICAL|IMPORTANT)\b/;
/** The two words the guide names in its own example of what *not* to write. */
const FORCING_WORDS = /\b(always|never)\b/i;

function findForcingLanguage(
  file: InstructionFile,
  lines: readonly ScannedLine[],
): AgentsFinding[] {
  const out: AgentsFinding[] = [];
  for (const line of lines) {
    if (line.fenced) continue;
    const shouted = SHOUTED.exec(line.text)?.[1];
    const forcing = shouted ?? FORCING_WORDS.exec(line.text)?.[1];
    if (forcing === undefined) continue;
    out.push({
      file: file.path,
      line: line.number,
      reason: {
        rule: FORCING_LANGUAGE_RULE,
        explanation:
          `forces with "${forcing}" — forcing language spends tokens on emphasis ` +
          `rather than on information` +
          citing(GUIDE.lightTouch),
      },
    });
  }
  return out;
}

/* ------------------------------------------------------------------------------------
 * structure-dump
 * ---------------------------------------------------------------------------------- */

/** The box-drawing characters every generated tree listing is made of. */
const TREE_DRAWING = /[├└│─]/;
/** How many path-ish lines in a row read as a dump rather than as an example. */
const DUMP_RUN = 3;

function findStructureDumps(file: InstructionFile, lines: readonly ScannedLine[]): AgentsFinding[] {
  const out: AgentsFinding[] = [];

  // A fenced block whose body is a tree drawing.
  let fenceStart: ScannedLine | undefined;
  let drawn = 0;
  for (const line of lines) {
    if (line.opensFence) {
      fenceStart = line;
      drawn = 0;
      continue;
    }
    if (!line.fenced) {
      fenceStart = undefined;
      continue;
    }
    if (fenceStart === undefined) continue;
    if (TREE_DRAWING.test(line.text)) drawn += 1;
    if (drawn === 2) {
      out.push(structureFinding(file, fenceStart.number, 'a directory tree'));
      fenceStart = undefined;
    }
  }

  // A run of bare path lines in prose — the same dump without the box characters.
  let run = 0;
  let runStart = 0;
  for (const line of lines) {
    if (line.fenced) {
      run = 0;
      continue;
    }
    const bare = bareText(line.text);
    const isPathLine = bare !== '' && isPathLike(bare.replace(/`/g, '').split(/\s+/)[0] ?? '');
    if (isPathLine && bare.split(/\s+/).length <= 2) {
      if (run === 0) runStart = line.number;
      run += 1;
      if (run === DUMP_RUN) out.push(structureFinding(file, runStart, 'a run of path lines'));
    } else {
      run = 0;
    }
  }

  return out;
}

function structureFinding(file: InstructionFile, line: number, what: string): AgentsFinding {
  return {
    file: file.path,
    line,
    reason: {
      rule: STRUCTURE_DUMP_RULE,
      explanation:
        `spends the every-request budget on ${what} — layout is the fact in a ` +
        `repository that changes most often, so it is also the fact that rots first` +
        citing(GUIDE.describeCapabilities),
    },
  };
}

/* ------------------------------------------------------------------------------------
 * generated-boilerplate — the softest rule here, and it says so
 * ---------------------------------------------------------------------------------- */

/** The fingerprints an init script leaves behind, with what each one is. */
const BOILERPLATE_SIGNATURES: readonly (readonly [RegExp, string])[] = [
  [/\bauto-?generated\b/i, 'an "auto-generated" marker'],
  [/\bgenerated by\b/i, 'a "generated by" credit'],
  [/<!--\s*generated/i, 'a generated-block comment'],
  [/\b(?:claude|codex|gemini|cursor|agents?)\s+init\b/i, 'an init-command credit'],
  [/\bthis file was (?:created|generated)\b/i, 'a "this file was generated" line'],
  [/\bdo not edit\b/i, 'a "do not edit" banner'],
];

function findGeneratedBoilerplate(
  file: InstructionFile,
  lines: readonly ScannedLine[],
): AgentsFinding[] {
  const out: AgentsFinding[] = [];
  for (const line of lines) {
    if (line.fenced) continue;
    for (const [pattern, what] of BOILERPLATE_SIGNATURES) {
      if (!pattern.test(line.text)) continue;
      out.push({
        file: file.path,
        line: line.number,
        reason: {
          rule: GENERATED_BOILERPLATE_RULE,
          explanation:
            `carries ${what}, which suggests this file was generated rather than ` +
            `written. This is the softest rule here: a signature is circumstantial, ` +
            `and a hand-written file may honestly carry one, so it never means more ` +
            `than "read this file again"` +
            citing(GUIDE.neverGenerate),
        },
      });
      break;
    }
  }
  return out;
}

/* ------------------------------------------------------------------------------------
 * language-rule
 * ---------------------------------------------------------------------------------- */

/** Style rules that pay their every-request cost only when the agent writes code. */
const LANGUAGE_RULE_SIGNATURES: readonly (readonly [RegExp, string])[] = [
  [/\bconst\b[^\n]*\blet\b|\blet\b[^\n]*\bconst\b/, 'a const/let rule'],
  [/\binterface\b[^\n]*\btype\b|\btype\b[^\n]*\binterface\b/, 'an interface-vs-type rule'],
  [/\bstrict[- ]?null(?:checks)?\b/i, 'a strict-null rule'],
  [/\bsemi-?colons?\b/i, 'a semicolon rule'],
  [/\b(?:single|double) quotes\b/i, 'a quote-style rule'],
  [/\barrow functions?\b/i, 'an arrow-function rule'],
  [/\bnamed exports?\b|\bdefault exports?\b/i, 'an export-style rule'],
  [
    /\btabs? (?:over|versus|vs\.?) spaces?\b|\bspaces? (?:over|versus|vs\.?) tabs?\b/i,
    'an indentation rule',
  ],
];

function findLanguageRules(file: InstructionFile, lines: readonly ScannedLine[]): AgentsFinding[] {
  const out: AgentsFinding[] = [];
  for (const line of lines) {
    if (line.fenced) continue;
    for (const [pattern, what] of LANGUAGE_RULE_SIGNATURES) {
      if (!pattern.test(line.text)) continue;
      out.push({
        file: file.path,
        line: line.number,
        reason: {
          rule: LANGUAGE_RULE_RULE,
          explanation:
            `states ${what}, which is paid for on every request and is relevant on ` +
            `few of them — move it behind a link and it costs only the tasks it applies to` +
            citing(GUIDE.loadWhenRelevant),
        },
      });
      break;
    }
  }
  return out;
}

/* ------------------------------------------------------------------------------------
 * mirror-drift (R4)
 * ---------------------------------------------------------------------------------- */

function standingOf(
  primary: InstructionFile,
  mirror: InstructionFile,
): AgentsMirrorReport['standing'] {
  if (mirror.symlink) return 'symlink';
  return mirror.text === primary.text ? 'copy' : 'drift';
}

/**
 * A mirror that has diverged from its `AGENTS.md`.
 *
 * A byte-identical copy is **not** a finding: it is not drift, and calling it one
 * would be smelt enforcing the guide's suggestion rather than reporting a fact. What
 * the report does say, beside every copy, is that a symlink cannot drift — which is
 * the guide's suggestion offered, exactly as `smelt hooks` offers rather than does.
 */
function findMirrorDrift(
  primary: InstructionFile,
  mirrors: readonly InstructionFile[],
): AgentsFinding[] {
  return mirrors
    .filter((mirror) => standingOf(primary, mirror) === 'drift')
    .map((mirror) => ({
      file: mirror.path,
      line: 1,
      reason: {
        rule: MIRROR_DRIFT_RULE,
        explanation:
          `has diverged from \`${primary.path}\` (${String(mirror.bytes)} bytes against ` +
          `${String(primary.bytes)}) — two harnesses are now reading two different sets ` +
          `of instructions from one repository` +
          citing(GUIDE.symlinkMirror),
      },
    }));
}

/* ------------------------------------------------------------------------------------
 * restated-at-level (R8)
 * ---------------------------------------------------------------------------------- */

/** Below this, a repeated line is a heading or a bullet marker, not an instruction. */
const RESTATEMENT_MIN_CHARS = 40;

/**
 * The same instruction present at two levels of the merged set.
 *
 * The guide's rule is that a nested file *merges with* the root, so a line written in
 * both is a line the agent is handed twice — paid for twice, and the second copy
 * carrying the risk that only one of them is ever updated. Reported on the deeper
 * file, because that is the copy the root already covers.
 */
function findRestatedAcrossLevels(set: InstructionSet): AgentsFinding[] {
  const firstSeen = new Map<string, { readonly path: string }>();
  const out: AgentsFinding[] = [];

  for (const level of set.levels) {
    const file = level.primary;
    const local = new Set<string>();
    scanLines(file.text).forEach((line) => {
      if (line.fenced) return;
      const normalized = bareText(line.text).toLowerCase().replace(/\s+/g, ' ');
      if (normalized.length < RESTATEMENT_MIN_CHARS) return;
      if (local.has(normalized)) return;
      local.add(normalized);
      const earlier = firstSeen.get(normalized);
      if (earlier === undefined) {
        firstSeen.set(normalized, { path: file.path });
        return;
      }
      out.push({
        file: file.path,
        line: line.number,
        reason: {
          rule: RESTATED_AT_LEVEL_RULE,
          explanation:
            `repeats a line already in \`${earlier.path}\` — the levels merge, so the ` +
            `agent is handed this twice and only one copy will be kept up to date` +
            citing(GUIDE.nestedMerge),
        },
      });
    });
  }
  return out;
}
