import { Parser } from 'web-tree-sitter';

import { describe, expect, it } from 'vitest';

import { applyPlan } from '@guard/apply';
import { GrammarUnavailableError } from '@guard/errors';
import { createSmelter } from '@guard/index';
import { loadGrammar } from '@guard/plan/grammar';
import { planStructural, STRUCTURAL_PLANNER_ID } from '@guard/plan/structural';
import { MemoryElisionStore } from '@guard/store';
import type { ElisionPlan, PlanInput } from '@guard/types';

import {
  BOUNDARY_TS,
  FUNCTIONS_TS,
  LONG_DOC_COMMENT,
  LONG_DOC_TS,
} from '../structural-fixtures.ts';

/**
 * STRUCTURAL-PLANNER GUARD — the guarantees Slice 2 claims.
 *
 * Four properties, each of which could quietly rot into something that still *looks*
 * structural from the outside:
 *
 *  1. **The explanation names kind and count from the parse tree** — `collapsed 3
 *     sibling functions`, never a line count as the claim. Lose this and Law 2
 *     degrades into the `[...truncated...]` it exists to replace.
 *  2. **A kept declaration keeps its signature line and attached doc comment,
 *     always.** The fixture's doc comment is forty lines long, because the cheap bug
 *     is an attachment heuristic that silently hands a big comment to the collapse.
 *  3. **Ranges never cross a parse-node boundary.** Every elision endpoint must be a
 *     top-level node boundary of the real parse — a range that cuts into a
 *     declaration produces output that lies about the code's structure. (Node
 *     boundaries are character boundaries, so this also covers multi-byte safety,
 *     which the reversibility guard asserts separately.)
 *  4. **No silent fallback.** A grammar this planner cannot load, or a language it
 *     has not mapped, is an exception — never lexical output labelled
 *     `structural/v1`, which would be undetectable from the outside.
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
    for (const [text, focus] of [
      [FUNCTIONS_TS, ['handleRequest']],
      [BOUNDARY_TS, ['greetTarget']],
    ] as const) {
      const plan = await structuralPlan(text, focus);
      expect(plan.elisions.length, 'no elisions — boundary check is vacuous').toBeGreaterThan(0);

      // An independent parse, and an independent code-unit → byte conversion: the
      // boundaries come from the tree itself, not from the planner under test.
      const grammar = await loadGrammar('typescript');
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
    for (const language of ['unknown', 'python', 'go', 'javascript'] as const) {
      await expect(structuralPlan(FUNCTIONS_TS, ['handleRequest'], language)).rejects.toThrow(
        GrammarUnavailableError,
      );
    }
    const smelter = createSmelter({ strategy: 'structural' });
    await expect(
      smelter.smelt('just some prose, no language at all', { budgetBytes: 100 }),
    ).rejects.toThrow(GrammarUnavailableError);
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
