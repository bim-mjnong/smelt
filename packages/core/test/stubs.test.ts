import { describe, expect, it } from 'vitest';

import { NotImplementedError, SmeltError } from '../src/errors.ts';
import { createSmelter } from '../src/index.ts';
import { StructuralPlanner } from '../src/plan/structural.ts';
import { unconfiguredDistillStage, unconfiguredRerankStage } from '../src/stages.ts';

/**
 * Every unbuilt stage throws. This test exists because the tempting alternative —
 * returning `[]`, or the input unchanged, or falling back to a planner that does work —
 * is indistinguishable from a correct implementation with nothing to say. A caller
 * would ship it, and find out months later that structural planning never ran.
 */
describe('stubs throw instead of returning a plausible wrong answer', () => {
  it('the structural planner refuses, and names where to read about it', () => {
    const planner = new StructuralPlanner();
    expect(() =>
      planner.plan({ text: 'const a = 1;', language: 'typescript', budgetBytes: 100 }),
    ).toThrow(NotImplementedError);
    expect(() =>
      planner.plan({ text: 'const a = 1;', language: 'typescript', budgetBytes: 100 }),
    ).toThrow(/docs\/HANDOFF\.md/);
  });

  it('asking a smelter for the structural strategy fails loudly, not quietly-lexically', async () => {
    const smelter = createSmelter({ strategy: 'structural' });
    await expect(smelter.smelt('const a = 1;', { budgetBytes: 100 })).rejects.toThrow(
      NotImplementedError,
    );
  });

  it('the rerank stage refuses, and points at the interface to implement', () => {
    expect(() => unconfiguredRerankStage.rerank([], 'query')).toThrow(/implement `RerankStage`/);
  });

  it('the distill stage refuses', () => {
    expect(() => unconfiguredDistillStage.distill('text', 10)).toThrow(NotImplementedError);
  });

  it('a smelter with no budget refuses to invent one', async () => {
    const smelter = createSmelter();
    await expect(smelter.smelt('some text')).rejects.toThrow(SmeltError);
    await expect(smelter.smelt('some text')).rejects.toThrow(/no budget/);
  });

  it('every stub error is a SmeltError, so callers can tell "we said no" from "it broke"', () => {
    expect(new NotImplementedError('x', 'y')).toBeInstanceOf(SmeltError);
  });
});
