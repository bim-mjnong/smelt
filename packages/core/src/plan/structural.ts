import { Parser } from 'web-tree-sitter';
import type { Node, Tree } from 'web-tree-sitter';

import { GrammarUnavailableError } from '../errors.ts';
import type { ElisionPlan, PlanInput, PlannedElision, Planner } from '../types.ts';

import { loadGrammar } from './grammar.ts';

export const STRUCTURAL_PLANNER_ID = 'structural/v1';

/**
 * The languages this planner actually parses. Slice 2 scopes it to two grammars on
 * purpose — the machinery generalises in Slice 4, and claiming a language before its
 * node kinds have been mapped would produce markers that mislabel what they collapsed.
 */
const STRUCTURAL_LANGUAGES = ['typescript', 'tsx'] as const;
type StructuralLanguage = (typeof STRUCTURAL_LANGUAGES)[number];

/**
 * Rough cost of a marker, in bytes — the same profitability arithmetic the lexical
 * planner uses: cutting fewer bytes than the marker itself costs makes the output
 * bigger, and a context optimizer that grows its input is worse than none.
 */
const MARKER_BYTE_ESTIMATE = 64;

export interface StructuralPlannerOptions {
  /**
   * Never collapse a sibling group smaller than this. Defaults to 1 — the byte
   * profitability check already refuses collapses that would not pay for their marker.
   */
  readonly minSiblings?: number;
  /** Focus matching is substring, case-insensitive by default — same as lexical. */
  readonly caseSensitive?: boolean;
}

/**
 * One top-level declaration, together with the doc comment attached to it. The unit is
 * the atom of every decision here: a unit is kept whole or collapsed whole, which is
 * what makes "a kept declaration keeps its signature line and attached doc comment"
 * true by construction rather than by patching ranges afterwards.
 *
 * All positions are UTF-16 code-unit indices (what web-tree-sitter reports for a JS
 * string); they are converted to UTF-8 byte offsets in one place, at the end.
 */
interface Unit {
  /** Start of the unit — the first attached comment if there is one. */
  readonly start: number;
  /** End of the declaration node. */
  readonly end: number;
  /** Human word for the declaration's kind, e.g. `'function'`. */
  readonly kind: string;
}

/**
 * The structural planner — the reason smelt exists.
 *
 * It parses with the language's tree-sitter grammar, finds the top-level declarations
 * whose text matches the caller's focus, keeps each match whole — signature line,
 * attached doc comment, body — and collapses each contiguous run of non-matching
 * *siblings* into one marker that names them from the parse tree: `collapsed 3 sibling
 * functions`. Structure is what makes that explanation possible; a line window can only
 * ever say "collapsed 40 lines".
 *
 * It throws {@link GrammarUnavailableError} rather than falling back to the lexical
 * planner, and that is the deliberate part. A silent fallback would mean a caller who
 * asked for structural planning, and whose grammar failed to load, gets line-window
 * output labelled `structural/v1` — plausible, wrong, and undetectable from the
 * outside. A caller who wants the fallback asks for it, by planning lexically itself.
 */
export class StructuralPlanner implements Planner {
  readonly id = STRUCTURAL_PLANNER_ID;
  readonly options: StructuralPlannerOptions;

  constructor(options: StructuralPlannerOptions = {}) {
    this.options = options;
  }

  plan(input: PlanInput): Promise<ElisionPlan> {
    return planStructural(input, this.options);
  }
}

/**
 * The planner as a function, exported like {@link planLexical} so it can be tested and
 * reused directly. Deterministic: same text, same language, same focus, same options —
 * byte-identical plan.
 *
 * `budgetBytes` is a target, not a guarantee, for the same reason it is in the lexical
 * planner: once every non-matching sibling run is collapsed there is nothing left to
 * cut except the declarations the caller asked to keep, and an optimizer that silently
 * drops the thing you searched for is the exact failure this design refuses. Callers
 * who need a hard ceiling check `outputBytes` and decide.
 *
 * @throws {GrammarUnavailableError} when the language is not one this planner parses,
 *   when the grammar cannot be loaded, or when the parser produces no tree. Never a
 *   lexical fallback.
 */
export async function planStructural(
  input: PlanInput,
  options: StructuralPlannerOptions = {},
): Promise<ElisionPlan> {
  const language = assertStructuralLanguage(input.language);
  const grammar = await loadGrammar(language);

  const parser = new Parser();
  let tree: Tree | null = null;
  try {
    parser.setLanguage(grammar);
    tree = parser.parse(input.text);
    if (tree === null) {
      throw new GrammarUnavailableError(
        `smelt: the ${language} parser returned no tree. Structural planning cannot ` +
          `proceed, and it does not fall back to lexical — a caller who wants the ` +
          `fallback plans lexically itself.`,
      );
    }
    return {
      planner: STRUCTURAL_PLANNER_ID,
      language: input.language,
      elisions: planFromTree(tree, input, options),
    };
  } finally {
    tree?.delete();
    parser.delete();
  }
}

function assertStructuralLanguage(language: PlanInput['language']): StructuralLanguage {
  for (const supported of STRUCTURAL_LANGUAGES) {
    if (language === supported) return supported;
  }
  throw new GrammarUnavailableError(
    `smelt: structural planning covers ${STRUCTURAL_LANGUAGES.join(' and ')} in this ` +
      `slice; got "${language}". It does not fall back to the lexical planner — output ` +
      `labelled structural/v1 that is really line windows would be undetectable from ` +
      `the outside. Use the lexical planner explicitly if that is what you want.`,
  );
}

function planFromTree(
  tree: Tree,
  input: PlanInput,
  options: StructuralPlannerOptions,
): readonly PlannedElision[] {
  const units = unitsOf(tree.rootNode, input.text);
  const matched = matchUnits(units, input, options);
  const minSiblings = options.minSiblings ?? 1;
  const toByte = utf8OffsetIndex(
    input.text,
    units.flatMap((unit) => [unit.start, unit.end]),
  );

  const elisions: PlannedElision[] = [];
  let run: Unit[] = [];

  const flush = (): void => {
    if (run.length === 0) return;
    const group = run;
    run = [];
    if (group.length < minSiblings) return;
    const start = toByte.get(group[0]!.start)!;
    const end = toByte.get(group[group.length - 1]!.end)!;
    // Profitability: a marker that costs more than it removes grows the output.
    if (end - start < MARKER_BYTE_ESTIMATE * 2) return;
    elisions.push({
      range: { start, end },
      reason: { rule: 'sibling-collapse', explanation: explain(group) },
    });
  };

  for (let i = 0; i < units.length; i += 1) {
    if (matched[i] === true) {
      flush();
    } else {
      run.push(units[i]!);
    }
  }
  flush();
  return elisions;
}

/**
 * Group the root's named children into units: each declaration plus the comment block
 * attached to it. A comment attaches when only blank-free whitespace separates it from
 * what follows — one newline at most — so a doc comment travels with its declaration,
 * while a comment left floating above a blank line stands alone.
 */
function unitsOf(root: Node, text: string): readonly Unit[] {
  const units: Unit[] = [];
  let pendingComments: Node[] = [];

  const flushComments = (): void => {
    if (pendingComments.length === 0) return;
    units.push({
      start: pendingComments[0]!.startIndex,
      end: pendingComments[pendingComments.length - 1]!.endIndex,
      kind: 'comment',
    });
    pendingComments = [];
  };

  for (const child of root.namedChildren) {
    if (child === null) continue;
    if (child.type === 'comment') {
      if (
        pendingComments.length > 0 &&
        !adjacent(text, pendingComments[pendingComments.length - 1]!.endIndex, child.startIndex)
      ) {
        flushComments();
      }
      pendingComments.push(child);
      continue;
    }

    const attached =
      pendingComments.length > 0 &&
      adjacent(text, pendingComments[pendingComments.length - 1]!.endIndex, child.startIndex);
    if (attached) {
      units.push({
        start: pendingComments[0]!.startIndex,
        end: child.endIndex,
        kind: kindOf(child),
      });
      pendingComments = [];
    } else {
      flushComments();
      units.push({ start: child.startIndex, end: child.endIndex, kind: kindOf(child) });
    }
  }
  flushComments();
  return units;
}

/** Nothing but whitespace between the two indices, and at most one newline. */
function adjacent(text: string, end: number, start: number): boolean {
  const between = text.slice(end, start);
  if (!/^\s*$/.test(between)) return false;
  return (between.match(/\n/g) ?? []).length <= 1;
}

function matchUnits(
  units: readonly Unit[],
  input: PlanInput,
  options: StructuralPlannerOptions,
): readonly boolean[] {
  const caseSensitive = options.caseSensitive ?? false;
  const focus = (input.focus ?? []).filter((term) => term.length > 0);
  const needles = caseSensitive ? focus : focus.map((term) => term.toLowerCase());

  return units.map((unit) => {
    if (needles.length === 0) return false;
    const raw = input.text.slice(unit.start, unit.end);
    const haystack = caseSensitive ? raw : raw.toLowerCase();
    return needles.some((needle) => haystack.includes(needle));
  });
}

/**
 * Law 2, for this rule: the explanation names the *kind* and the *count*, read off the
 * parse tree — `collapsed 3 sibling functions` — never a line count as the claim. A
 * mixed run says what it mixed: `collapsed 4 sibling declarations (3 functions,
 * 1 class)`.
 */
function explain(group: readonly Unit[]): string {
  const counts = new Map<string, number>();
  for (const unit of group) counts.set(unit.kind, (counts.get(unit.kind) ?? 0) + 1);

  const total = group.length;
  if (counts.size === 1) {
    const kind = group[0]!.kind;
    return `collapsed ${String(total)} sibling ${countNoun(kind, total)}`;
  }
  const parts = [...counts.entries()].map(
    ([kind, count]) => `${String(count)} ${countNoun(kind, count)}`,
  );
  return `collapsed ${String(total)} sibling declarations (${parts.join(', ')})`;
}

function countNoun(kind: string, count: number): string {
  if (count === 1) return kind;
  return /(?:s|sh|ch)$/.test(kind) ? `${kind}es` : `${kind}s`;
}

/**
 * Human words for the tree-sitter node types this planner expects at the top level of
 * a TypeScript or TSX file. Anything unmapped is a `'declaration'` — honest, if vague.
 */
const KIND_LABELS: Readonly<Record<string, string>> = {
  function_declaration: 'function',
  generator_function_declaration: 'function',
  function_signature: 'function',
  class_declaration: 'class',
  abstract_class_declaration: 'class',
  interface_declaration: 'interface',
  type_alias_declaration: 'type alias',
  enum_declaration: 'enum',
  lexical_declaration: 'variable',
  variable_declaration: 'variable',
  import_statement: 'import',
  internal_module: 'namespace',
  module: 'namespace',
  ambient_declaration: 'ambient declaration',
  expression_statement: 'statement',
  comment: 'comment',
};

/** The kind of a declaration, unwrapping `export` so the marker names what it hides. */
function kindOf(node: Node): string {
  if (node.type === 'export_statement') {
    for (const child of node.namedChildren) {
      if (child === null || child.type === 'comment') continue;
      const label = KIND_LABELS[child.type];
      if (label !== undefined) return label;
    }
    return 'export';
  }
  return KIND_LABELS[node.type] ?? 'declaration';
}

/**
 * UTF-16 code-unit index → UTF-8 byte offset, for exactly the indices asked about.
 *
 * web-tree-sitter reports positions in code units of the JS string it parsed;
 * {@link ElisionPlan} ranges are UTF-8 bytes. Because every converted index is a parse
 * node boundary, a range can never split a multi-byte character — a node boundary is
 * always a character boundary. One forward pass, so the conversion is linear.
 */
function utf8OffsetIndex(
  text: string,
  indices: readonly number[],
): ReadonlyMap<number, number> {
  const sorted = [...new Set(indices)].toSorted((a, b) => a - b);
  const map = new Map<number, number>();
  let previousIndex = 0;
  let previousByte = 0;
  for (const index of sorted) {
    previousByte += Buffer.byteLength(text.slice(previousIndex, index), 'utf8');
    previousIndex = index;
    map.set(index, previousByte);
  }
  return map;
}
