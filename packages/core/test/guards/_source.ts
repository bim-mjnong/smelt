import { guardAnchor } from '@smelt/guard-kit';

/**
 * This package's guard anchor.
 *
 * The helpers live in `@smelt/guard-kit` — one copy, shared with `packages/mcp` — and
 * so does the binding: `guardAnchor` derives this package's root from this file's own
 * location and returns the helpers bound to it. The only thing package-local here is
 * the `import.meta.url` it is handed. The bound spellings keep every call site
 * (`guardSrcRoot()`, `readSource(file)`) reading exactly as it did.
 */
export const { packageRoot, repoRoot, guardSrcRoot, guardRoot, allSourceFiles, readSource } =
  guardAnchor(import.meta.url);

export { importSpecifiers, stripStringsAndComments } from '@smelt/guard-kit';
