import { NotImplementedError } from './errors.ts';
import type { DistillStage, RerankCandidate, RerankStage, RerankedCandidate } from './types.ts';

/**
 * The reranker that ships with smelt: one that refuses.
 *
 * It exists so that "reranking is a seam, not a feature" is enforced rather than
 * promised. Wire this in and you get an exception naming the interface you were
 * supposed to implement. There is no default hosted reranker, no bundled key handling,
 * and no `SMELT_RERANK_API_KEY` — the first of those to appear breaks Law 1 for every
 * consumer at once, including the ones who never read the changelog.
 */
export const unconfiguredRerankStage: RerankStage = {
  id: 'rerank/unconfigured',
  rerank(
    _candidates: readonly RerankCandidate[],
    _query: string,
  ): Promise<readonly RerankedCandidate[]> {
    throw new NotImplementedError(
      'reranking',
      'docs/ARCHITECTURE.md § "Explicitly out of v1" — implement `RerankStage` in your own ' +
        'code, with your own key, so the network call is visible in your source',
    );
  },
};

/**
 * Learned distillation, same treatment, for a different reason.
 *
 * Distillation is out of v1 because a model-written summary cannot satisfy Law 2. "The
 * model condensed this" does not say what was removed, and once the text is rewritten
 * there is nothing left to store under a hash. If this ever ships it will store the
 * original, explain itself in the same rule-named terms every other elision uses, and
 * be reversible — or it will not ship.
 */
export const unconfiguredDistillStage: DistillStage = {
  id: 'distill/unconfigured',
  distill(_text: string, _budgetBytes: number): Promise<string> {
    throw new NotImplementedError(
      'learned distillation',
      'docs/ARCHITECTURE.md § "Explicitly out of v1"',
    );
  },
};
