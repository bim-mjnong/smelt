/**
 * The text every harness shares: the marker lines that bracket a block this installer
 * owns inside somebody else's file, the token that identifies a hook entry as ours,
 * and the instruction snippet itself.
 */

/** Marker lines bracketing every block this installer owns inside a shared file. */
export const SNIPPET_START_MD = '<!-- smelt:hooks v1 start -->';
export const SNIPPET_END_MD = '<!-- smelt:hooks v1 end -->';
export const SNIPPET_START_HASH = '# smelt:hooks v1 start';
export const SNIPPET_END_HASH = '# smelt:hooks v1 end';

/** Substring that identifies a file (or JSON hook entry) as written by this installer. */
export const OURS_TOKEN = 'smelt:hooks';

/**
 * The instruction snippet — belt and braces under every shim, and the *only* layer
 * for advisory harnesses. It teaches the three commands, and in particular what to do
 * after a guard deny: run the named replacement, then `smelt retrieve` per marker.
 */
export function instructionSnippet(thresholdBytes: number, budgetBytes: number): string {
  return `${SNIPPET_START_MD}

## smelt — context discipline

This project uses [smelt](https://github.com/smeltjs/smelt) to keep large tool output
out of the context window, reversibly.

- Do not read files over ${String(thresholdBytes)} bytes raw. Run
  \`smelt <file> --budget ${String(budgetBytes)} --focus <what you are looking for>\`
  instead (repeat \`--focus\` per term). Focused regions survive verbatim; everything
  else collapses into a one-line marker stating what was removed.
- Every marker ends in \`retrieve("hash")\`. \`smelt retrieve <hash>\` prints the
  exact original bytes back. Retrieve what you actually need — retrievals are counted,
  and \`smelt stats\` reports the honest expansion rate.
- For orientation, \`smelt map . --budget ${String(budgetBytes)}\` prints a ranked
  symbol map of the repository.
- If a smelt guard hook denies a raw read, run the exact replacement command named in
  the denial, then \`smelt retrieve\` any marker you need expanded.

${SNIPPET_END_MD}
`;
}
