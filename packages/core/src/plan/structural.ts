import { Parser } from 'web-tree-sitter';
import type { Node, Tree } from 'web-tree-sitter';

import { markerForLanguage } from '../apply.ts';
import { GrammarUnavailableError } from '../errors.ts';
import { HASH_LENGTH } from '../hash.ts';
import type { ElisionPlan, PlanInput, PlannedElision, Planner } from '../types.ts';

import { loadGrammar } from './grammar.ts';

export const STRUCTURAL_PLANNER_ID = 'structural/v1';

/**
 * The languages this planner actually parses. Slice 2 scoped it to two grammars;
 * Slice 4 added rust, python and go — the same machinery, three more node-kind sets.
 * A language appears here only once its node kinds are mapped in
 * {@link STRUCTURE_BY_LANGUAGE}, because claiming a language before that would produce
 * markers that mislabel what they collapsed.
 */
const STRUCTURAL_LANGUAGES = ['typescript', 'tsx', 'rust', 'python', 'go'] as const;
type StructuralLanguage = (typeof STRUCTURAL_LANGUAGES)[number];

/**
 * Every elision this planner produces carries this rule id, and the profitability
 * check below renders the marker that rule would earn — so the two must not drift.
 */
const SIBLING_COLLAPSE_RULE = 'sibling-collapse';

/**
 * A stand-in hash of the real length, so the profitability check can render the
 * marker a cut would earn before the cut exists. Marker cost depends on the hash's
 * *length*, never its value.
 */
const PLACEHOLDER_HASH = '0'.repeat(HASH_LENGTH);

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
      elisions: planFromTree(tree, input, options, language),
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
  const named = `${STRUCTURAL_LANGUAGES.slice(0, -1).join(', ')} and ${
    STRUCTURAL_LANGUAGES[STRUCTURAL_LANGUAGES.length - 1]
  }`;
  throw new GrammarUnavailableError(
    `smelt: structural planning covers ${named} in this ` +
      `slice; got "${language}". It does not fall back to the lexical planner — output ` +
      `labelled structural/v1 that is really line windows would be undetectable from ` +
      `the outside. Use the lexical planner explicitly if that is what you want.`,
  );
}

function planFromTree(
  tree: Tree,
  input: PlanInput,
  options: StructuralPlannerOptions,
  language: StructuralLanguage,
): readonly PlannedElision[] {
  const structure = STRUCTURE_BY_LANGUAGE[language];
  const buildMarker = markerForLanguage(language);
  const units = unitsOf(tree.rootNode, input.text, structure);
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
    const cutBytes = end - start;
    const explanation = explain(group);
    // Profitability, measured rather than estimated: render the exact marker this cut
    // would earn — the explanation's length varies with kind diversity and the
    // language's marker may carry a comment leader (see markerForLanguage), so a fixed
    // estimate can pass a cut whose marker is bigger than what it removes, and a
    // marker that costs more than it removes grows the output.
    const markerBytes = Buffer.byteLength(
      buildMarker({
        hash: PLACEHOLDER_HASH,
        bytes: cutBytes,
        rule: SIBLING_COLLAPSE_RULE,
        explanation,
      }),
      'utf8',
    );
    if (cutBytes <= markerBytes) return;
    elisions.push({
      range: { start, end },
      reason: { rule: SIBLING_COLLAPSE_RULE, explanation },
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
function unitsOf(root: Node, text: string, structure: LanguageStructure): readonly Unit[] {
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
    if (structure.commentTypes.has(child.type)) {
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
        kind: kindOf(child, structure),
      });
      pendingComments = [];
    } else {
      flushComments();
      units.push({
        start: child.startIndex,
        end: child.endIndex,
        kind: kindOf(child, structure),
      });
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
 * 1 class)` — and when the run holds anything that is not a declaration (a statement,
 * a floating comment, an unparsed region), the heading says `nodes`, because calling
 * a parse error a declaration would be the marker lying about the tree.
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
  const heading = [...counts.keys()].every((kind) => !NON_DECLARATION_KINDS.has(kind))
    ? 'declarations'
    : 'nodes';
  return `collapsed ${String(total)} sibling ${heading} (${parts.join(', ')})`;
}

/** The kind labels that are not declarations, so a mixed heading never overclaims. */
const NON_DECLARATION_KINDS: ReadonlySet<string> = new Set([
  'statement',
  'comment',
  'unparsed region',
  'package clause',
  'attribute',
]);

function countNoun(kind: string, count: number): string {
  if (count === 1) return kind;
  return /(?:s|sh|ch)$/.test(kind) ? `${kind}es` : `${kind}s`;
}

/**
 * Human words for the tree-sitter node types this planner expects at the top level of
 * a TypeScript or TSX file. What the map does not name, {@link kindOf} still labels
 * honestly: an `ERROR` node is an `'unparsed region'`, any other statement kind is a
 * `'statement'`, and only what remains is called a `'declaration'` — a marker that
 * calls a parse error or a log line a declaration would be lying about the tree.
 */
const TS_KIND_LABELS: Readonly<Record<string, string>> = {
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
  import_statement: 'import statement',
  internal_module: 'namespace',
  module: 'namespace',
  ambient_declaration: 'ambient declaration',
  expression_statement: 'statement',
  comment: 'comment',
};

/**
 * What this planner needs to know about a language, beyond its grammar: which node
 * types are comments (so a doc comment travels with its declaration), which node types
 * merely wrap the declaration that should be named (`export function f()` is a
 * function, `@cached def f()` is a function), and the human word for each top-level
 * node kind. One entry per {@link StructuralLanguage} — the `Record` keeps the two
 * lists total, so adding a language without mapping its kinds is a compile error.
 */
interface LanguageStructure {
  /** Top-level node types that are comments, in this grammar's vocabulary. */
  readonly commentTypes: ReadonlySet<string>;
  /**
   * Node types that wrap the declaration worth naming — the marker should say what is
   * inside, not name the wrapper. The value is the label to fall back to when nothing
   * nameable is found inside.
   */
  readonly wrapperTypes: Readonly<Record<string, string>>;
  /** Human words per node type. See {@link TS_KIND_LABELS} for the labelling rules. */
  readonly kindLabels: Readonly<Record<string, string>>;
}

const TS_STRUCTURE: LanguageStructure = {
  commentTypes: new Set(['comment']),
  wrapperTypes: { export_statement: 'export' },
  kindLabels: TS_KIND_LABELS,
};

const STRUCTURE_BY_LANGUAGE: Readonly<Record<StructuralLanguage, LanguageStructure>> = {
  typescript: TS_STRUCTURE,
  tsx: TS_STRUCTURE,
  rust: {
    // `///` and `//!` doc comments are line_comment nodes; `/** … */` is block_comment.
    commentTypes: new Set(['line_comment', 'block_comment']),
    wrapperTypes: {},
    kindLabels: {
      function_item: 'function',
      struct_item: 'struct',
      enum_item: 'enum',
      union_item: 'union',
      trait_item: 'trait',
      impl_item: 'impl block',
      mod_item: 'module',
      macro_definition: 'macro',
      type_item: 'type alias',
      const_item: 'constant',
      static_item: 'static item',
      use_declaration: 'use declaration',
      extern_crate_declaration: 'extern crate declaration',
      attribute_item: 'attribute',
      foreign_mod_item: 'extern block',
    },
  },
  python: {
    // Docstrings are not comments — they live inside the definition's body, so a kept
    // definition keeps its docstring because units are kept whole. `#` comments above
    // a definition attach the same way `/** … */` does in TypeScript.
    commentTypes: new Set(['comment']),
    wrapperTypes: { decorated_definition: 'declaration' },
    kindLabels: {
      function_definition: 'function',
      class_definition: 'class',
      import_statement: 'import statement',
      import_from_statement: 'import statement',
      future_import_statement: 'import statement',
      expression_statement: 'statement',
    },
  },
  go: {
    commentTypes: new Set(['comment']),
    wrapperTypes: {},
    kindLabels: {
      function_declaration: 'function',
      method_declaration: 'method',
      type_declaration: 'type declaration',
      const_declaration: 'constant',
      var_declaration: 'variable',
      import_declaration: 'import declaration',
      package_clause: 'package clause',
    },
  },
};

/**
 * The kind of a declaration, unwrapping wrappers (`export …`, `@decorator`) so the
 * marker names what it hides. What the language's map does not name is still labelled
 * honestly — see {@link TS_KIND_LABELS}.
 */
function kindOf(node: Node, structure: LanguageStructure): string {
  const wrapperFallback = structure.wrapperTypes[node.type];
  if (wrapperFallback !== undefined) {
    for (const child of node.namedChildren) {
      if (child === null || structure.commentTypes.has(child.type)) continue;
      const label = structure.kindLabels[child.type];
      if (label !== undefined) return label;
    }
    return wrapperFallback;
  }
  const label = structure.kindLabels[node.type];
  if (label !== undefined) return label;
  if (node.type === 'ERROR') return 'unparsed region';
  if (node.type.endsWith('_statement') || node.type === 'statement_block') return 'statement';
  return 'declaration';
}

/**
 *
 * web-tree-sitter reports positions in code units of the JS string it parsed;
 * {@link ElisionPlan} ranges are UTF-8 bytes. Because every converted index is a parse
 * node boundary, a range can never split a multi-byte character — a node boundary is
 * always a character boundary. One forward pass, so the conversion is linear.
 */
function utf8OffsetIndex(text: string, indices: readonly number[]): ReadonlyMap<number, number> {
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
