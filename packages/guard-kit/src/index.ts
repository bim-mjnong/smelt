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
  guardAnchor,
  guardRoot,
  guardSrcRoot,
  importSpecifiers,
  readSource,
  stripStringsAndComments,
  type GuardAnchor,
} from './source.ts';
export { type GuardMutation } from './mutation.ts';
export { assertKeyedById } from './keyed.ts';
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
  ambientTypeUses,
  AMBIENT_GLOBAL_NAMESPACES,
  AMBIENT_GLOBAL_TYPES,
  deadSourcemapViolations,
  packPackage,
  standaloneTypecheckViolations,
  strictModeViolations,
  type PackedPackage,
  type StandaloneTypecheckOptions,
  type ToolSchema,
} from './packaging.ts';
