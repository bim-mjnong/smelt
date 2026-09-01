import { Parser } from 'web-tree-sitter';
import type { Node } from 'web-tree-sitter';

import { describe, expect, it, vi } from 'vitest';

import { applyPlan } from '@guard/apply';
import { GrammarUnavailableError } from '@guard/errors';
import { createSmelter } from '@guard/index';
import { loadGrammar } from '@guard/plan/grammar';
import { planStructural, STRUCTURAL_PLANNER_ID } from '@guard/plan/structural';
import { MemoryElisionStore } from '@guard/store';
import type { ElisionPlan, PlanInput } from '@guard/types';

import {
  BOUNDARY_TS,
  FUNCTIONS_GO,
  FUNCTIONS_PY,
  FUNCTIONS_RS,
  FUNCTIONS_TS,
  GO_DOC_COMMENT,
  LONG_DOC_COMMENT,
  LONG_DOC_TS,
  MIXED_TSX,
  PYTHON_DOCSTRING,
  RUST_DOC_COMMENT,
} from '../structural-fixtures.ts';

/**
 * STRUCTURAL-PLANNER GUARD — the guarantees Slice 2 claims.
 *
 * Six properties, each of which could quietly rot into something that still *looks*
 * structural from the outside:
 *
 *  1. **The explanation names kind and count from the parse tree** — `collapsed 3
 *     sibling functions`, never a line count as the claim. Lose this and Law 2
 *     degrades into the `[...truncated...]` it exists to replace.
 *  2. **The labels are honest for text that is not clean code.** A labeled_statement
 *     is a statement and an ERROR node is an unparsed region — never a
 *     "declaration", which would tell the model broken text was code that parsed.
 *  3. **A kept declaration keeps its signature line and attached doc comment,
 *     always.** The fixture's doc comment is forty lines long, because the cheap bug
 *     is an attachment heuristic that silently hands a big comment to the collapse.
 *  4. **Ranges never cross a parse-node boundary.** Every elision endpoint must be a
 *     top-level node boundary of the real parse — a range that cuts into a
 *     declaration produces output that lies about the code's structure. (Node
 *     boundaries are character boundaries, so this also covers multi-byte safety,
 *     which the reversibility guard asserts separately.)
 *  5. **No silent fallback, on either path.** A language this planner has not mapped
 *     *and* a mapped language whose grammar fails to load are both exceptions —
 *     never lexical output labelled `structural/v1`, which would be undetectable
 *     from the outside.
 *  6. **An elision never costs more than it removes.** The profitability check
 *     renders the actual marker, because a mixed-kind explanation can outgrow a
 *     small cut — and an optimizer that grows its input is worse than none.
 *
 * Plus the determinism claim: same file, same focus, byte-identical plan — asserted
 * by running it, not assumed. Mutations for all of these live in `scripts/mutate.mjs`;
 * `pnpm mutate` proves each one turns this file red.
 */

function inputFor(text: string, focus: readonly string[], language: PlanInput['language']) {
  return { text, language, budgetBytes: 600, focus } as const;
}

async function structuralPlan(
  text: string,
  focus: readonly string[],
  language: PlanInput['language'] = 'typescript',
): Promise<ElisionPlan> {
  return planStructural(inputFor(text, focus, language));
}

describe('Slice 2 — the structural planner keeps its claims', () => {
  it('explains every elision with a kind and a count, never a line count', async () => {
    const plans = [
      await structuralPlan(FUNCTIONS_TS, ['handleRequest']),
      await structuralPlan(LONG_DOC_TS, ['retryWithBackoff']),
      await structuralPlan(BOUNDARY_TS, ['greetTarget']),
    ];
    const elisions = plans.flatMap((plan) => plan.elisions);
    expect(elisions.length, 'no elisions planned — this guard would be vacuous').toBeGreaterThan(2);
    for (const { reason } of elisions) {
      expect(reason.rule).toBe('sibling-collapse');
      // The kind-and-count shape, from the parse tree: "collapsed 2 sibling
      // functions", or the mixed form "collapsed 4 sibling declarations (…)".
      expect(reason.explanation).toMatch(/^collapsed \d+ sibling [a-z]/);
      // Never a line count as the primary claim — that is the lexical planner's
      // vocabulary, and structural output claiming it has lost its reason to exist.
      expect(reason.explanation).not.toMatch(/\d+ lines?\b/);
    }
  });

  it('keeps a kept declaration whole: signature line and forty-line doc comment', async () => {
    // Self-check first, so the fixture cannot quietly stop being the hard case.
    expect(LONG_DOC_COMMENT.split('\n')).toHaveLength(40);
    expect(LONG_DOC_TS).toContain(LONG_DOC_COMMENT);

    const smelter = createSmelter({ strategy: 'structural' });
    const result = await smelter.smelt(LONG_DOC_TS, {
      language: 'typescript',
      budgetBytes: 600,
      focus: ['retryWithBackoff'],
    });
    expect(
      result.elisions.length,
      'nothing elided — the assertion below is vacuous',
    ).toBeGreaterThan(0);
    // The signature line survives…
    expect(result.text).toContain('export async function retryWithBackoff<T>(');
    // …and so does the attached doc comment, every byte of it.
    expect(result.text).toContain(LONG_DOC_COMMENT);
    expect(smelter.reconstruct(result)).toBe(LONG_DOC_TS);
  });

  it('never lets a range cross a top-level parse-node boundary', async () => {
    for (const [text, focus, language] of [
      [FUNCTIONS_TS, ['handleRequest'], 'typescript'],
      [BOUNDARY_TS, ['greetTarget'], 'typescript'],
      [MIXED_TSX, ['Toolbar'], 'tsx'],
    ] as const) {
      const plan = await structuralPlan(text, focus, language);
      expect(plan.elisions.length, 'no elisions — boundary check is vacuous').toBeGreaterThan(0);

      // An independent parse, and an independent code-unit → byte conversion: the
      // boundaries come from the tree itself, not from the planner under test.
      const grammar = await loadGrammar(language);
      const parser = new Parser();
      parser.setLanguage(grammar);
      const tree = parser.parse(text);
      expect(tree).not.toBeNull();
      const toBytes = (index: number): number => Buffer.byteLength(text.slice(0, index), 'utf8');
      const starts = new Set<number>();
      const ends = new Set<number>();
      for (const child of tree!.rootNode.namedChildren) {
        if (child === null) continue;
        starts.add(toBytes(child.startIndex));
        ends.add(toBytes(child.endIndex));
      }
      tree!.delete();
      parser.delete();

      for (const { range } of plan.elisions) {
        expect(starts, `range start ${String(range.start)} is not a node start`).toContain(
          range.start,
        );
        expect(ends, `range end ${String(range.end)} is not a node end`).toContain(range.end);
      }
    }
  });

  it('throws GrammarUnavailableError instead of falling back to lexical', async () => {
    for (const language of ['unknown', 'javascript'] as const) {
      await expect(structuralPlan(FUNCTIONS_TS, ['handleRequest'], language)).rejects.toThrow(
        GrammarUnavailableError,
      );
    }
    const smelter = createSmelter({ strategy: 'structural' });
    await expect(
      smelter.smelt('just some prose, no language at all', { budgetBytes: 100 }),
    ).rejects.toThrow(GrammarUnavailableError);
  });

  it('rejects when the grammar for a supported language cannot load — never lexical output', async () => {
    // The other half of "no silent fallback": the language is mapped, but the grammar
    // itself will not load — a corrupted or missing wasm in the field. The failure must
    // surface as the loader's own error, never as line-window output labelled
    // structural/v1, which is undetectable from the outside. Slice 4 extended the
    // check to a new language: the rule holds per grammar, not just for the two the
    // planner started with.
    vi.resetModules();
    vi.doMock('@guard/plan/grammar', () => ({
      loadGrammar: () =>
        Promise.reject(
          new GrammarUnavailableError('smelt: induced grammar-load failure, for this guard'),
        ),
    }));
    try {
      const fresh =
        (await import('@guard/plan/structural')) as typeof import('@guard/plan/structural');
      await expect(
        fresh.planStructural(inputFor(FUNCTIONS_TS, ['handleRequest'], 'typescript')),
      ).rejects.toThrow(GrammarUnavailableError);
      await expect(
        fresh.planStructural(inputFor(FUNCTIONS_RS, ['resolve_target'], 'rust')),
      ).rejects.toThrow(GrammarUnavailableError);
    } finally {
      vi.doUnmock('@guard/plan/grammar');
      vi.resetModules();
    }
  });

  it('labels statements and unparsed regions honestly, never as declarations', async () => {
    // Log lines parsed as TypeScript are labeled_statement nodes; garbage is ERROR and
    // empty_statement nodes. A marker that calls either a "declaration" tells the model
    // the text was code that parsed — the parse tree says otherwise, and Law 2 says the
    // explanation reads off the tree.
    const log = Array.from({ length: 6 }, (_, i) => `line ${String(i)}: routine chatter here`).join(
      '\n',
    );
    const logPlan = await structuralPlan(log, []);
    expect(logPlan.elisions.length, 'log input planned nothing — vacuous').toBeGreaterThan(0);
    for (const { reason } of logPlan.elisions) {
      expect(reason.explanation).toMatch(/sibling statements$/);
      expect(reason.explanation).not.toContain('declaration');
    }

    const garbage = Array.from({ length: 5 }, () => '%%%% not typescript at all ???!!! ;;; @@@')
      .join('\n')
      .concat('\n');
    const garbagePlan = await structuralPlan(garbage, []);
    expect(garbagePlan.elisions.length, 'garbage input planned nothing — vacuous').toBeGreaterThan(
      0,
    );
    for (const { reason } of garbagePlan.elisions) {
      expect(reason.explanation).not.toContain('declaration');
      expect(reason.explanation).toContain('unparsed region');
    }
  });

  it('never plans an elision whose marker costs more bytes than it removes', async () => {
    // Eight tiny declarations of many kinds: the run is real, but the mixed-kind
    // explanation makes the marker bigger than the cut. The honest move is to plan
    // nothing — an optimizer that grows its input is worse than none.
    const tiny = [
      'type Alias = 1;',
      'enum Level {}',
      'interface Cfg { x: 1 }',
      'class Box {}',
      'const nine = 1;',
      'declare const flag: 1;',
      'function noop() {}',
      'let extra = 2;',
    ].join('\n');
    const plan = await structuralPlan(tiny, []);
    const result = applyPlan(tiny, plan, new MemoryElisionStore());
    expect(
      result.outputBytes,
      'the output grew: a marker cost more than the bytes it removed',
    ).toBeLessThanOrEqual(result.inputBytes);
  });

  it('labels every plan it does produce as its own', async () => {
    const plan = await structuralPlan(FUNCTIONS_TS, ['handleRequest']);
    expect(plan.planner).toBe(STRUCTURAL_PLANNER_ID);
    expect(plan.language).toBe('typescript');
  });

  it('is deterministic: repeated runs produce byte-identical plans and output', async () => {
    const runs: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const plan = await structuralPlan(FUNCTIONS_TS, ['handleRequest']);
      const result = applyPlan(FUNCTIONS_TS, plan, new MemoryElisionStore());
      runs.push(JSON.stringify({ plan, text: result.text }));
    }
    expect(runs[1]).toBe(runs[0]);
    expect(runs[2]).toBe(runs[0]);
  });
});

/**
 * SLICE 4 — the same claims, three more languages.
 *
 * Rust, python and go are planned by the same machinery as TypeScript and TSX: the
 * marker names kind and count from the parse tree, a kept declaration keeps its
 * signature and its doc comment (`///`, a docstring, `//`), and grammar failure is an
 * exception, never lexical output. One claim is new and python-specific: **the
 * survivor still parses.** Python's significant indentation means a parse error does
 * not stay local — a bare marker line between two `def`s produces an ERROR node that
 * swallows the neighbouring definitions, so the survivor stops being python at all.
 * The marker therefore lands as a `#` comment (see `markerForLanguage`), and this
 * guard *reparses the post-applyPlan survivor* and asserts it introduces no ERROR or
 * missing nodes that the original parse did not have. Mutations for each of these
 * live in `scripts/mutate.mjs`.
 */
/** Every ERROR or missing node in an independent python parse of `text`. */
async function parseIssues(text: string): Promise<readonly string[]> {
  const grammar = await loadGrammar('python');
  const parser = new Parser();
  parser.setLanguage(grammar);
  const tree = parser.parse(text);
  expect(tree).not.toBeNull();
  const issues: string[] = [];
  const walk = (node: Node): void => {
    if (node.type === 'ERROR' || node.isMissing) {
      issues.push(`${node.type}@${String(node.startIndex)}`);
    }
    for (const child of node.children) {
      if (child !== null) walk(child);
    }
  };
  walk(tree!.rootNode);
  tree!.delete();
  parser.delete();
  return issues;
}

describe('Slice 4 — rust, python and go keep the same claims', () => {
  const CASES = [
    {
      language: 'rust',
      text: FUNCTIONS_RS,
      focus: ['resolve_target'],
      signature: 'pub fn resolve_target(name: &str) -> String {',
      doc: RUST_DOC_COMMENT,
    },
    {
      language: 'python',
      text: FUNCTIONS_PY,
      focus: ['fetch_user'],
      signature: 'def fetch_user(user_id):',
      doc: PYTHON_DOCSTRING,
    },
    {
      language: 'go',
      text: FUNCTIONS_GO,
      focus: ['HandleRequest'],
      signature: 'func HandleRequest(path string) string {',
      doc: GO_DOC_COMMENT,
    },
  ] as const;

  it('explains with kind and count in every language, including the pure-function form', async () => {
    for (const { language, text, focus } of CASES) {
      const plan = await structuralPlan(text, focus, language);
      expect(
        plan.elisions.length,
        `${language}: no elisions planned — this guard would be vacuous`,
      ).toBeGreaterThan(1);
      for (const { reason } of plan.elisions) {
        expect(reason.rule).toBe('sibling-collapse');
        expect(reason.explanation).toMatch(/^collapsed \d+ sibling [a-z]/);
        expect(reason.explanation).not.toMatch(/\d+ lines?\b/);
      }
      // The same shape TypeScript earns — "collapsed N sibling functions", the count
      // and the kind read off this language's own parse tree.
      expect(
        plan.elisions.some(({ reason }) =>
          /^collapsed \d+ sibling functions$/.test(reason.explanation),
        ),
        `${language}: expected a pure sibling-functions collapse among: ` +
          plan.elisions.map((e) => e.reason.explanation).join(' | '),
      ).toBe(true);
    }
  });

  it('names language-specific kinds honestly in mixed collapses', async () => {
    const rust = await structuralPlan(FUNCTIONS_RS, ['resolve_target'], 'rust');
    expect(
      rust.elisions.some(({ reason }) =>
        /^collapsed \d+ sibling declarations \(1 struct, 1 impl block\)$/.test(reason.explanation),
      ),
      `rust: ${rust.elisions.map((e) => e.reason.explanation).join(' | ')}`,
    ).toBe(true);

    const go = await structuralPlan(FUNCTIONS_GO, ['HandleRequest'], 'go');
    const goMixed = go.elisions.map((e) => e.reason.explanation).join(' | ');
    expect(goMixed, `go: ${goMixed}`).toContain('1 method');
    expect(goMixed).toContain('1 type declaration');
    expect(goMixed).toContain('1 package clause');

    const python = await structuralPlan(FUNCTIONS_PY, ['fetch_user'], 'python');
    const pyMixed = python.elisions.map((e) => e.reason.explanation).join(' | ');
    expect(pyMixed, `python: ${pyMixed}`).toContain('1 class');
    expect(pyMixed).toContain('1 import statement');
  });

  it('keeps the focused declaration whole — signature and doc comment — and round-trips', async () => {
    for (const { language, text, focus, signature, doc } of CASES) {
      const smelter = createSmelter({ strategy: 'structural' });
      const result = await smelter.smelt(text, { language, budgetBytes: 600, focus });
      expect(
        result.elisions.length,
        `${language}: nothing elided — the assertions below are vacuous`,
      ).toBeGreaterThan(0);
      expect(result.text, `${language}: the signature line did not survive`).toContain(signature);
      expect(result.text, `${language}: the doc comment did not survive`).toContain(doc);
      expect(smelter.reconstruct(result), `${language}: reconstruction drifted`).toBe(text);
    }
  });

  it('the python survivor still parses: the reparse introduces no ERROR nodes', async () => {
    // Self-check: the fixture parses cleanly, so "no new ERROR nodes" below means
    // exactly "no ERROR nodes at all" — the comparison cannot be vacuous.
    expect(await parseIssues(FUNCTIONS_PY), 'the fixture itself must parse cleanly').toEqual([]);

    const smelter = createSmelter({ strategy: 'structural' });
    const result = await smelter.smelt(FUNCTIONS_PY, {
      language: 'python',
      budgetBytes: 600,
      focus: ['fetch_user'],
    });
    expect(result.elisions.length, 'nothing elided — the reparse below is vacuous').toBeGreaterThan(
      0,
    );
    expect(
      await parseIssues(result.text),
      'the survivor no longer parses as python — an elision broke the block structure of what remains',
    ).toEqual([]);
    // How that is achieved: every marker landed as a python comment, so the survivor's
    // block structure is exactly the kept declarations' own.
    for (const { marker } of result.elisions) {
      expect(marker.startsWith('# <<smelt/'), `marker is not a python comment: ${marker}`).toBe(
        true,
      );
    }
    expect(smelter.reconstruct(result)).toBe(FUNCTIONS_PY);
  });
});
