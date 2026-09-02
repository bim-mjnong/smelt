import { Parser } from 'web-tree-sitter';
import type { Node, Tree } from 'web-tree-sitter';

import { GrammarUnavailableError, MissingMarkerPricingError } from '../errors.ts';
import type { LanguageStructure } from '../lang/profile.ts';
import { profileFor, structuralLanguages } from '../lang/registry.ts';
import type {
  ElisionPlan,
  LanguageId,
  MarkerPricing,
  PlanInput,
  PlannedElision,
  Planner,
} from '../types.ts';

import { loadGrammar } from './grammar.ts';

export const STRUCTURAL_PLANNER_ID = 'structural/v1';

/**
 * The languages this planner actually parses — a derived view of the registry: every
 * {@link LanguageProfile} that carries a `structure` section, in registry order. A
 * language appears here only once its node kinds are mapped in its profile
 * (`src/lang/<id>.ts`), because claiming a language before that would produce markers
 * that mislabel what they collapsed.
 *
 * Exported for the totality guard (`test/guards/structural-totality.test.ts`): every
 * language named here must have a fixture, a snapshot and a doc-comment case, so a
 * language cannot be claimed without tests.
 */
export const STRUCTURAL_LANGUAGES: readonly LanguageId[] = structuralLanguages();

/**
 * Historically the union of the claimed ids; every `LanguageId` carries a profile
 * now, so the compile-time totality this type enforced lives on the registry
 * (`Record<LanguageId, LanguageProfile>`) instead.
 */
export type StructuralLanguage = LanguageId;

/**
 * Every elision this planner produces carries this rule id, and the profitability
 * check below prices the marker that rule would earn — so the two must not drift.
 */
const SIBLING_COLLAPSE_RULE = 'sibling-collapse';

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
  /** Start of the unit — the first attached comment or attribute if there is one. */
  readonly start: number;
  /** End of the declaration node. */
  readonly end: number;
  /** Human word for the declaration's kind, e.g. `'function'`. */
  readonly kind: string;
  /**
   * A unit the planner must never collapse, matched or not. Every pin follows one
   * law: collapsing it would silently change what the survivor *is*, not what it
   * contains. Go's `//go:build` constraint governs which builds see the whole file;
   * shebang lines (bash, ruby, python as comments; javascript, typescript, tsx,
   * kotlin and swift as their grammars' own shebang nodes) and ruby's
   * `# frozen_string_literal:` magic comment govern how the file is executed at all;
   * php's `<?php` open tag is what makes the rest of the file php; and c/c++'s
   * `#pragma once` governs what including the file means.
   */
  readonly pinned?: boolean;
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
  // The runtime backstop for JS callers: TypeScript makes `pricing` required, but a
  // JS caller can omit it, and the honest answer is a named refusal rather than the
  // planner quietly pricing markers itself — the inversion the seam removed.
  const pricing: MarkerPricing | undefined = input.pricing;
  if (pricing === undefined) throw new MissingMarkerPricingError(STRUCTURAL_PLANNER_ID);
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
  const profile = profileFor(language);
  // assertStructuralLanguage admits only languages whose profile carries a
  // `structure` section — that is the definition of a structural language — so the
  // assertion states a fact the seam already proved.
  const structure = profile.structure!;
  const pricing = input.pricing;
  // The marker lands as a line comment in every structural language (the profile's
  // markerLeader), and a line comment comments out everything to the end of its
  // line — so a collapse is only legal where nothing kept follows on the marker's
  // own line. See the flush below.
  const markerIsLineComment = profile.markerLeader !== undefined;
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
    // A line-comment marker swallows the rest of its line. When the run's last unit
    // ends mid-line — python's `stmt_a(); stmt_b()` puts two top-level statements on
    // one line — the marker's `# ` leader would comment out the *kept* code after it.
    // Refusing the collapse is the honest move; extending the range would elide code
    // no unit accounted for.
    if (markerIsLineComment && !restOfLineIsBlank(input.text, group[group.length - 1]!.end)) {
      return;
    }
    const start = toByte.get(group[0]!.start)!;
    const end = toByte.get(group[group.length - 1]!.end)!;
    const cutBytes = end - start;
    const explanation = explain(group);
    // Profitability, priced rather than estimated: ask the MarkerPricing seam for the
    // exact cost of the marker this cut would earn — the explanation's length varies
    // with kind diversity, and the pricing carries the language's comment leader (or a
    // caller's custom builder), so a fixed estimate can pass a cut whose marker is
    // bigger than what it removes, and a marker that costs more than it removes grows
    // the output.
    const markerBytes = pricing.costBytes({ rule: SIBLING_COLLAPSE_RULE, explanation }, cutBytes);
    if (cutBytes <= markerBytes) return;
    elisions.push({
      range: { start, end },
      reason: { rule: SIBLING_COLLAPSE_RULE, explanation },
    });
  };

  for (let i = 0; i < units.length; i += 1) {
    if (matched[i] === true || units[i]!.pinned === true) {
      flush();
    } else {
      run.push(units[i]!);
    }
  }
  flush();
  return elisions;
}

/** True when nothing but whitespace follows `index` on its own line. */
function restOfLineIsBlank(text: string, index: number): boolean {
  for (let i = index; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '\n') return true;
    if (!/\s/.test(ch)) return false;
  }
  return true;
}

/**
 * Group the root's named children into units: each declaration plus the comment block
 * — and, in rust, the outer attributes — attached to it. A comment attaches when only
 * blank-free whitespace separates it from what follows — one newline at most — so a doc
 * comment travels with its declaration, while a comment left floating above a blank
 * line stands alone.
 *
 * Attributes attach *unconditionally*: tree-sitter-rust parses `#[inline]` as a
 * top-level sibling of the item it decorates, but the language's own rule is that an
 * outer attribute modifies the next item, blank lines or not. So once an attribute is
 * pending, the whole pending prefix (doc comments included) rides forward to the next
 * declaration — treating it as its own unit would let a collapse strip `#[derive(…)]`
 * and the doc comment above it off a kept declaration.
 */
function unitsOf(root: Node, text: string, structure: LanguageStructure): readonly Unit[] {
  const units: Unit[] = [];
  /** Comments and attributes waiting to attach to the next declaration. */
  let pending: Node[] = [];
  /** Once true, blank lines no longer detach the pending prefix — see above. */
  let pendingHasAttribute = false;

  const flushPending = (): void => {
    if (pending.length === 0) return;
    units.push({
      start: pending[0]!.startIndex,
      end: pending[pending.length - 1]!.endIndex,
      kind: pendingHasAttribute ? 'attribute' : 'comment',
      pinned: !pendingHasAttribute && pending.some((node) => pinnedComment(node, text, structure)),
    });
    pending = [];
    pendingHasAttribute = false;
  };

  for (const child of root.namedChildren) {
    if (child === null) continue;
    if (structure.ridesBackwardTypes?.has(child.type) === true && units.length > 0) {
      // A node that is grammatically part of the *previous* statement, parsed as a
      // top-level sibling: tree-sitter-ruby emits a heredoc's body as a sibling of
      // the statement holding its `<<~SQL` opener. Splitting them lets a collapse
      // keep the opener and cut the body — an unterminated heredoc that swallows
      // every kept declaration after it, without a single ERROR node to show for
      // it. The body extends the preceding unit instead, so opener and body are
      // kept whole or collapsed whole, always.
      flushPending();
      const last = units[units.length - 1]!;
      units[units.length - 1] = { ...last, end: child.endIndex };
      continue;
    }
    if (
      structure.pinnedTypes?.has(child.type) === true ||
      pinnedDirective(child, text, structure)
    ) {
      // A pinned node (php's `<?php` tag, a `#!` shebang line, c's `#pragma once`)
      // is its own uncollapsible unit — nothing attaches to it, and no run may
      // swallow it.
      flushPending();
      units.push({
        start: child.startIndex,
        end: child.endIndex,
        kind: kindOf(child, structure),
        pinned: true,
      });
      continue;
    }
    const isComment = structure.commentTypes.has(child.type);
    const isAttribute = structure.attributeTypes.has(child.type);
    if (isComment || isAttribute) {
      if (
        pending.length > 0 &&
        !pendingHasAttribute &&
        !adjacent(text, pending[pending.length - 1]!.endIndex, child.startIndex)
      ) {
        flushPending();
      }
      pending.push(child);
      pendingHasAttribute ||= isAttribute;
      continue;
    }

    // tree-sitter-kotlin extends the import_list node over a doc comment that
    // follows it, so the KDoc of the first documented declaration after the imports
    // would be collapsed *with the imports* — a kept declaration losing its attached
    // doc comment. Split such trailing comments off: the unit ends at its last
    // non-comment token, and the comments ride forward like any other pending block.
    const { end: childEnd, trailing } =
      structure.trailingCommentSplitTypes?.has(child.type) === true
        ? splitTrailingComments(child, structure)
        : { end: child.endIndex, trailing: [] };

    const attached =
      pending.length > 0 &&
      (pendingHasAttribute ||
        adjacent(text, pending[pending.length - 1]!.endIndex, child.startIndex));
    if (attached && pending.some((node) => pinnedComment(node, text, structure))) {
      // A pinned comment (`//go:build`) governs the file, not the declaration it
      // happens to touch — keep it a standalone, uncollapsible unit either way.
      flushPending();
      units.push({
        start: child.startIndex,
        end: childEnd,
        kind: kindOf(child, structure),
      });
    } else if (attached) {
      units.push({
        start: pending[0]!.startIndex,
        end: childEnd,
        kind: kindOf(child, structure),
      });
      pending = [];
      pendingHasAttribute = false;
    } else {
      flushPending();
      units.push({
        start: child.startIndex,
        end: childEnd,
        kind: kindOf(child, structure),
      });
    }
    for (const comment of trailing) pending.push(comment);
  }
  flushPending();
  return units;
}

/** Whether this comment node is one the language pins to the file. See {@link Unit}. */
function pinnedComment(node: Node, text: string, structure: LanguageStructure): boolean {
  if (structure.pinnedCommentPattern === undefined) return false;
  if (!structure.commentTypes.has(node.type)) return false;
  return structure.pinnedCommentPattern.test(text.slice(node.startIndex, node.endIndex));
}

/**
 * Whether this non-comment node is pinned by a per-type text pattern. C's
 * `#pragma once` is a `preproc_call` like any other pragma, but collapsing it
 * silently changes header inclusion semantics — the same class as `//go:build`, on a
 * node kind a comment pattern cannot reach.
 */
function pinnedDirective(node: Node, text: string, structure: LanguageStructure): boolean {
  const pattern = structure.pinnedPatternsByType?.[node.type];
  if (pattern === undefined) return false;
  return pattern.test(text.slice(node.startIndex, node.endIndex));
}

/**
 * The end of `node`'s last non-comment token, and every comment node after it. Used
 * for node types the grammar extends over comments that belong to what follows —
 * kotlin's import_list swallowing the next declaration's KDoc.
 */
function splitTrailingComments(
  node: Node,
  structure: LanguageStructure,
): { readonly end: number; readonly trailing: readonly Node[] } {
  const comments: Node[] = [];
  let end = node.startIndex;
  const walk = (current: Node): void => {
    if (structure.commentTypes.has(current.type)) {
      comments.push(current);
      return;
    }
    let hasChildren = false;
    for (const child of current.children) {
      if (child === null) continue;
      hasChildren = true;
      walk(child);
    }
    if (!hasChildren && current.endIndex > end) end = current.endIndex;
  };
  for (const child of node.children) {
    if (child !== null) walk(child);
  }
  return { end, trailing: comments.filter((comment) => comment.startIndex >= end) };
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
  'package header',
  'package declaration',
  'attribute',
  'command',
  'variable assignment',
  'include directive',
  'shebang',
  'php tag',
  'html section',
  'heredoc body',
  'preprocessor directive',
  'preprocessor conditional',
]);

function countNoun(kind: string, count: number): string {
  if (count === 1) return kind;
  if (/[^aeiou]y$/.test(kind)) return `${kind.slice(0, -1)}ies`;
  return /(?:s|sh|ch)$/.test(kind) ? `${kind}es` : `${kind}s`;
}

/**
 * The kind of a declaration, unwrapping wrappers (`export …`, `@decorator`) so the
 * marker names what it hides. What the language's map does not name is still labelled
 * honestly — see {@link LanguageStructure.kindLabels} for the labelling rules.
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
