import { describe, expect, it } from 'vitest';

import { applyPlan } from '../src/apply.ts';
import { GrammarUnavailableError } from '../src/errors.ts';
import { createSmelter } from '../src/index.ts';
import {
  planStructural,
  STRUCTURAL_PLANNER_ID,
  StructuralPlanner,
} from '../src/plan/structural.ts';
import { MemoryElisionStore } from '../src/store.ts';
import type { PlanInput } from '../src/types.ts';

import {
  BOUNDARY_TS,
  FUNCTIONS_GO,
  FUNCTIONS_PY,
  FUNCTIONS_RS,
  FUNCTIONS_TS,
  LONG_DOC_TS,
  MIXED_TSX,
} from './structural-fixtures.ts';

const FIXTURES: readonly {
  readonly name: string;
  readonly text: string;
  readonly language: PlanInput['language'];
  readonly focus: readonly string[];
}[] = [
  { name: 'functions.ts', text: FUNCTIONS_TS, language: 'typescript', focus: ['handleRequest'] },
  { name: 'long-doc.ts', text: LONG_DOC_TS, language: 'typescript', focus: ['retryWithBackoff'] },
  { name: 'mixed.tsx', text: MIXED_TSX, language: 'tsx', focus: ['Toolbar'] },
  { name: 'boundary.ts', text: BOUNDARY_TS, language: 'typescript', focus: ['greetTarget'] },
  { name: 'functions.ts, no focus', text: FUNCTIONS_TS, language: 'typescript', focus: [] },
  { name: 'functions.rs', text: FUNCTIONS_RS, language: 'rust', focus: ['resolve_target'] },
  { name: 'functions.py', text: FUNCTIONS_PY, language: 'python', focus: ['fetch_user'] },
  { name: 'functions.go', text: FUNCTIONS_GO, language: 'go', focus: ['HandleRequest'] },
];

function inputFor(fixture: (typeof FIXTURES)[number]): PlanInput {
  return {
    text: fixture.text,
    language: fixture.language,
    budgetBytes: 600,
    focus: fixture.focus,
  };
}

describe('the structural planner', () => {
  // One snapshot per fixture, so any change to what the planner decides — ranges,
  // rules, explanations — shows up in review as a diff rather than as a surprise.
  for (const fixture of FIXTURES) {
    it(`plans ${fixture.name} (snapshot)`, async () => {
      const plan = await planStructural(inputFor(fixture));
      expect(plan.planner).toBe(STRUCTURAL_PLANNER_ID);
      expect(plan).toMatchSnapshot();
    });
  }

  it('names the kind and the count of what it collapsed, from the parse tree', async () => {
    const plan = await planStructural(inputFor(FIXTURES[0]!));
    expect(plan.elisions.length).toBeGreaterThan(0);
    for (const elision of plan.elisions) {
      expect(elision.reason.rule).toBe('sibling-collapse');
      expect(elision.reason.explanation).toMatch(/^collapsed \d+ sibling functions?$/);
    }
  });

  it('names each kind in a mixed collapse', async () => {
    const plan = await planStructural(inputFor(FIXTURES[2]!));
    const explanations = plan.elisions.map((e) => e.reason.explanation);
    expect(
      explanations.some((text) => /^collapsed \d+ sibling declarations \(.+\)$/.test(text)),
      `expected a mixed-kind explanation among: ${explanations.join(' | ')}`,
    ).toBe(true);
  });

  it('keeps the focused declaration whole — signature, doc comment, body', async () => {
    const fixture = FIXTURES[0]!;
    const plan = await planStructural(inputFor(fixture));
    const result = applyPlan(fixture.text, plan, new MemoryElisionStore());
    expect(result.text).toContain('export function handleRequest(path: string, raw: string)');
    expect(result.text).toContain('/** The entry point every request goes through');
    expect(result.text).toContain('return renderResponse(normalisePath(path), config);');
  });

  it('is deterministic: same file, same focus, byte-identical plan', async () => {
    for (const fixture of FIXTURES) {
      const first = await planStructural(inputFor(fixture));
      const second = await planStructural(inputFor(fixture));
      const third = await new StructuralPlanner().plan(inputFor(fixture));
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
      expect(JSON.stringify(third)).toBe(JSON.stringify(first));
    }
  });

  it('refuses every language it has not mapped, naming the ones it has', async () => {
    for (const language of ['unknown', 'javascript'] as const) {
      const attempt = planStructural({ ...inputFor(FIXTURES[0]!), language });
      await expect(attempt).rejects.toThrow(GrammarUnavailableError);
      await expect(attempt).rejects.toThrow(/typescript, tsx, rust, python and go/);
    }
  });

  it('smelts end to end through createSmelter, and the result round-trips', async () => {
    const smelter = createSmelter({ strategy: 'structural' });
    const result = await smelter.smelt(FUNCTIONS_TS, {
      language: 'typescript',
      budgetBytes: 600,
      focus: ['handleRequest'],
    });
    expect(result.planner).toBe(STRUCTURAL_PLANNER_ID);
    expect(result.elisions.length).toBeGreaterThan(0);
    expect(smelter.reconstruct(result)).toBe(FUNCTIONS_TS);
  });
});
