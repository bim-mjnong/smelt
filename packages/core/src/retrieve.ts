import type { ElisionStore, RetrieveTool } from './types.ts';

/** The tool name smelt's markers reference. Consumers hard-code it; do not rename it. */
export const RETRIEVE_TOOL_NAME = 'smelt_retrieve';

const DESCRIPTION =
  'Return the exact original text that was elided from a previous tool result. ' +
  'Context you were given may contain markers like `<<smelt: collapsed 3 sibling functions ' +
  '(412B) — retrieve("a1b2c3d4e5f60718")>>`. Call this with that hash to get those bytes ' +
  'back verbatim. Nothing was deleted — it is all still here. Ask whenever the elided ' +
  'material might matter; guessing at what a marker hid is never correct.';

/**
 * Wrap a store as the tool a model calls.
 *
 * Why the description says "ask whenever it might matter": under-retrieval is the
 * failure mode that looks like success. A model that never calls this produces a
 * confident answer built on material it never saw, and the retrieve rate reads 0% —
 * which is indistinguishable from perfect pruning. Encouraging retrieval keeps the
 * signal in {@link ElisionStore.stats} honest.
 */
export function createRetrieveTool(store: ElisionStore): RetrieveTool {
  return {
    name: RETRIEVE_TOOL_NAME,
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: { hash: { type: 'string' } },
      required: ['hash'],
    },
    invoke: ({ hash }) => store.retrieve(hash),
  };
}
