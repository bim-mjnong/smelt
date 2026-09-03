/**
 * The shape of one mutation. The type lives once, in `@smelt/guard-kit`
 * (`packages/guard-kit/src/mutation.ts`, where the two load-bearing conventions are
 * written down); this file re-exports it so every guard beside it keeps spelling the
 * import `./_mutations.ts`, and `scripts/mutate.mjs` keeps finding the one declaration
 * line it anchors on: `export const MUTATIONS: GuardMutation[] = [`.
 */
export type { GuardMutation } from '@smelt/guard-kit';
