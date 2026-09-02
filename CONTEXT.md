# smelt — domain vocabulary

The names the code uses, with their exact meanings. Architecture reviews and refactors
use these terms; drift is a bug. Module/interface/seam/adapter vocabulary follows the
codebase-design glossary.

## Core domain

- **Blob**: the text a caller hands to `smelt()` — a file, grep result, trace, log. smelt
  never fetches one itself.
- **Budget**: a soft output ceiling in UTF-8 bytes. A target planners aim under, never a
  silent guarantee; overrunning it is reported, not hidden.
- **Elision**: a planned removal of a byte range, carrying an `ElisionReason` (stable
  `rule` id + human `explanation`). Applied elisions are reversible by construction.
- **Marker**: the one-line stand-in `<<smelt/v1: … — retrieve("hash")>>` that replaces
  elided bytes. Part of the frozen wire surface; it goes into prompts.
- **Marker leader**: the language-specific line-comment prefix (`// `, `# `) a marker
  needs so the survivor still parses.
- **Survivor**: what remains of a blob after `applyPlan`. For structural plans the
  survivor must still parse in its language.
- **Planner**: a module that turns a blob + budget + focus into an `ElisionPlan` without
  removing any bytes itself. `applyPlan` is the only byte-remover.
- **Focus**: the caller's statement of what the task is actually about; focus-matched
  regions survive planning.
- **Store**: content-addressed home of elided bytes (`ElisionStore`). No eviction: a
  store that can forget turns "reversible" into "reversible, usually".
- **Expansion rate**: retrieved-back fraction of what smelt hid — the honest signal of
  over-pruning. Measured, never thresholded. The marker's `retrieve("hash")` is a real
  command — `smelt retrieve <hash>` — so the rate moves (and is measurable, via
  `smelt stats`) from pure shell, not only through the `smelt_retrieve` tool.
- **Guard**: a test that pins a law or guarantee, proven non-vacuous by mutations.
- **Mutation**: a deliberate minimal break that its guard must catch (`pnpm mutate`).
- **The four laws**: zero network · every elision explainable · every elision reversible
  (and counted) · no unmeasured numbers. Reasoning in `docs/ARCHITECTURE.md`.

## Deepened modules

- **LanguageProfile**: the single adapter carrying every per-language fact — extensions,
  grammar wasm, marker leader, pinned comments, structural node kinds, repo-map tag
  kinds, licence provenance. One file per language in `src/lang/`; the registry
  (`LANGUAGE_PROFILES` in `src/lang/registry.ts`) is `Record<LanguageId, LanguageProfile>`,
  so totality is a compile error. The seam is `profileFor(id)`, `profileForPath(path)`
  and `structuralLanguages()`; every rendered list and every exported set
  (`SUPPORTED_LANGUAGES`, `WASM_BY_LANGUAGE`, `STRUCTURAL_LANGUAGES`,
  `MARKER_LINE_COMMENT_LEADERS`) is a derived view. Consumers read it, never own a
  slice of it. "Structural language" = a profile with a `structure` section;
  `grammar-provenance.json` holds the licence facts, its key set guard-pinned to the
  registry's wasm set.
- **MarkerPricing**: the seam through which planners ask what a marker will cost in
  bytes — `costBytes(reason, elidedBytes)`, required on every `PlanInput`. Owned and
  built by `apply.ts`: `markerPricing(language, marker)` is the one adapter, built from
  the exact builder `applyPlan` will use (a caller's custom `MarkerBuilder` prices with
  its own rendering, so a longer marker makes small cuts unprofitable and the planner
  sees it). Planners never estimate independently; `createSmelter` and the CLI construct
  the pricing centrally, and a JS caller who omits it gets `MissingMarkerPricingError`,
  never a guessed cost.
- **ResolvedRun**: the CLI's single merge of flags + config + built-ins (`resolveRun` in
  `src/cli/resolve.ts`); the only place precedence lives, each value carrying its
  provenance (`flag`/`config`/`builtin`). It owns the budget-required refusal, and
  `runSmelt` executes it straight-line with no `??` of its own.
- **retrieveStats**: the one exported derivation within `src/` of the honesty
  arithmetic (`expansionRate`, `allElisionsRetrieved`) from a store's
  **RawRetrieveCounters** — a free function in `src/stats.ts`, not a base class. A
  store implements `rawCounters()` and delegates `stats()` to it; adapters supply
  counters, never derive the metric. Consumers see only `stats()`; the seam is for
  adapter authors. (`bench/lib.mjs`, deliberately import-free, re-derives the same
  formula; `test/bench.test.ts` pins the two copies to each other.)
- **PLANNERS**: the one registry of planner strategies (`src/plan/planners.ts`), string →
  factory over the lexical/structural option bags. `createSmelter`, `--strategy` and
  config validation, and the help text all serve its keys; a constructed `planner` on
  `SmelterConfig` wins over any strategy name.
- **RepoMap**: the ranked whole-tree symbol map `buildRepoMap` returns — deliberately
  **not** an `ElisionPlan` and its builder deliberately not a Planner: nothing is
  elided, stored, or reversible, so the Planner interface would claim laws the map
  cannot honour. Its CLI front door is the `smelt map` subcommand, never a
  `--strategy` name; the map fits itself to its byte budget by construction, so
  `map` has no over-budget exit.
- **ResolvedMapRun**: `smelt map`'s single merge of flags + config + built-ins
  (`resolveMapRun` in `src/cli/resolve.ts`) — ResolvedRun's sibling, sharing the
  module that owns precedence and the budget-required refusal, not the struct.
- **Focus promotion** (repo map): a focus term moves matching symbols to the front
  of the map's fill order with a `focus-match` receipt naming the term; the measured
  rank and reference counts are never altered.
- **RepoReader**: the repo map's whole door to the filesystem — `list(dir)`,
  `read(path)`, `stat(path)` in `src/repomap/reader.ts`, optional on
  `RepoMapOptions` and defaulting to `nodeFsReader()` (the `readdirSync` /
  `lstatSync` / `readFileSync` calls the map used to make in-line). `decide`'s
  `statFile` is the sibling seam and the precedent. Read-only by construction:
  **there is no writer on it**, so the only bytes `buildRepoMap` can put on disk are
  the tags cache a caller named with `cacheDir`. Because it is injectable, the walk's
  claims are asserted by _counting calls_ — a symlink is statted once and never read
  (refused on `isSymlink`, not on the accident that an `lstat` of a link is neither
  file nor directory), an ignored path is never statted at all.
- **guard-kit**: the guards' shared machine — `packages/guard-kit`, test-only,
  `private: true`, never published and never more than a devDependency. It owns the
  import-graph **walker** (`walkImportGraph`, `assertNoNetwork`) that both packages'
  Law 1 guards run on, carrying the four vacuity defences and the reasoning for each,
  plus the source helpers (`guardSrcRoot`, `guardRoot`, `allSourceFiles`, `readSource`,
  `stripStringsAndComments`). The seam is `classify(edge): Classification` — one small
  function per package holding only that package's **ruling** (the core partitions
  against `net/policy.ts`; the mcp package adds a stdio-only SDK subpath allowlist).
  Each package's `test/guards/_source.ts` stays as its anchor: only `packageRoot()` and
  `repoRoot()` are package-local, and `SMELT_GUARD_SRC` / `SMELT_GUARD_ROOT` keep
  exactly the semantics `scripts/mutate.mjs` sets them with.
