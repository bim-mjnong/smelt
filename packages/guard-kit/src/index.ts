/**
 * @smelt/guard-kit — the guards' shared machine. Test-only, workspace-internal,
 * `private: true`, never published and never a runtime dependency of anything that is.
 *
 * Two packages enforce Law 1 (zero network) over their own source. The *walk* is the
 * same machine in both — the same four vacuity defences, whose reasoning was written
 * down once and, until this package existed, maintained twice. The *ruling* is not:
 * the core partitions its edges against `net/policy.ts`, the MCP server adds a
 * stdio-only SDK subpath allowlist. So the walker lives here and the ruling stays
 * where it belongs, as one small `classify(edge)` per package.
 */
export {
  allSourceFiles,
  guardRoot,
  guardSrcRoot,
  importSpecifiers,
  readSource,
  stripStringsAndComments,
} from './source.ts';
export {
  classifyEdge,
  distPaths,
  entrypoints,
  readManifest,
  walkImportGraph,
  type Classification,
  type Classify,
  type Edge,
  type Manifest,
  type WalkResult,
} from './walk.ts';
export { assertNoNetwork, type NoNetworkRuling, type WalkCoverage } from './no-network.ts';
export {
  ambientNamespaceViolations,
  AMBIENT_GLOBAL_NAMESPACES,
  deadSourcemapViolations,
  packPackage,
  strictModeViolations,
  type PackedPackage,
  type ToolSchema,
} from './packaging.ts';
