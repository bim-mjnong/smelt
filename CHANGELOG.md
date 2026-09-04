# Changelog

Every release, what changed in it, and why. Two promises govern what may appear here:
the **wire surface** a model sees — the `<<smelt/v1: … >>` marker and the
`smelt_retrieve` tool contract — is stable from 0.1 and treated as 1.0, so a change to
it would arrive as a new marker version, never as a quiet edit. The **TypeScript API**
is `0.x` and may move; anything that moved is listed under Changed with its reason.

No number appears here that was not measured. Byte figures come from the committed
tier-1 rows in `packages/core/bench/RESULTS.md`, each carrying its date and corpus
commit; the mutation tally is whatever `guards.json` says, and that file is written by
the runner rather than by hand.

## 0.4.0 — 2026-09-03

`@smeltjs/core@0.4.0` · `@smeltjs/mcp@0.3.0`

### Added

- **`smelt agents lint`** — audits the instruction files an agent loads on every
  request: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, and the nested files that merge with
  them. Eight advisory rules, each a stable id with an explanation citing its source:
  `dead-path`, `dead-link`, `forcing-language`, `structure-dump`,
  `generated-boilerplate`, `language-rule`, `mirror-drift`, `restated-at-level`.
  `--strict` turns any finding into exit 1 for CI; `--json` emits a versioned envelope.
  It reports bytes and a labelled imperative heuristic against a budget **you** set in
  `smelt.config.json` — never a default, on the same reasoning that keeps the expansion
  rate un-thresholded.
- **`smelt agents split`** — the mechanical half of a refactor: it proposes a
  root/`docs` partition, rewrites the links, and writes nothing without the
  per-file confirmation `smelt init` uses. Deciding which sections are essential is
  judgment, so it belongs to your agent, not to smelt; the command hands you the prompt
  rather than guessing. There is deliberately **no `agents init`** — auto-generating
  these files is the practice the guidance this rule set follows warns against.
- **A `SessionStart` hook** (opt-in) that lints the repo's instruction files as a
  session opens.
- **smelt's own `AGENTS.md`**, hand-written to the minimum — one sentence, the package
  manager, the one non-standard gate, and two pointers — with `CLAUDE.md` as a symlink
  to it. It passes the lint it ships with.

### Fixed

- **The site can no longer contradict the packages.** It had been advertising
  `core v0.2.0 · mcp v0.1.0` through a 0.3.0 release, because `site/` held no dependency
  on the packages and neither the gate nor the deploy paths could make it red. Versions,
  the harness tier table, the structural language list and the guard tally are now
  generated from the registries at build time, and a guard forbids any site component
  from stating a tier of its own.
- **The mutation tally left prose for `guards.json`.** The number had lived in three
  documents plus a fourth copy on the site worded past the drift check; the runner now
  writes the file and refuses to run against a stale one.
- **Harness tiers are derived everywhere they are rendered.** The wizard's two sentences
  had named a tier to describe a capability they only correlated with; they now name the
  capability they test.

### Changed

- `SmeltOptions` removed — a published type nothing produced or consumed; the live type
  is `SmeltCallOptions`.
- The byte-faithful JSON editor moved out of the hooks installer to `src/text/`, where
  it is tested on strings rather than only through a harness install.
- New public surface for the site's generator to read: `harnessesByTier`, `harnessNames`,
  `HARNESSES`, `HARNESS_IDS`, `harnessLabel`, `HARNESS_TIERS`, `TIER_HONESTY`.

## 0.3.0 — 2026-09-03

`@smeltjs/core@0.3.0`

### Added

- **`strategy: 'auto'`** — structural where the language is supported, lexical
  otherwise, with the result labelling which planner ran. An explicit
  `strategy: 'structural'` still refuses an unsupported language: auto is a labelled
  choice, never a silent downgrade.
- **The structural planner reads its budget.** A pressure rung collapses runs whose real
  rendered marker costs less than the cut, so the planner no longer returns over budget
  having elided nothing while a profitable cut existed.
- `smelt map` ignores build output (`dist`, `build`, `out`, `coverage`) by default; a
  built TypeScript repository no longer triplicates every symbol.

### Fixed

- **The published declarations no longer name `NodeJS`, `Buffer` or `URL`**, so a
  project compiling with `skipLibCheck: false` and no `@types/node` can build against
  smelt. Proven by a guard that packs the real tarball and typechecks it in a scratch
  consumer.
- Sourcemaps inline their sources instead of pointing at `src/`, which the tarball
  excludes.
- `smelt_retrieve`'s schema carries `additionalProperties: false`, so it registers under
  OpenAI strict mode.
- `smelt init` and `smelt hooks install` exit when they finish — a stream wrapper had
  been holding stdin open on a real terminal.
- Grammar loads, repo-map filesystem calls and cache reads all fail as `SmeltError`,
  keeping the documented guarantee true.
- `--reconstruct` refuses the flags it had silently ignored; `has()` and `retrieve()`
  agree about a corrupt blob.

### Changed

- `./hooks/guard-core` no longer self-invokes as a script. Nothing smelt installs used
  that path — the guard is reached through the shims.

## 0.2.1 — 2026-09-02

`@smeltjs/mcp@0.1.1`

### Fixed

- **`npx @smeltjs/mcp` was broken for everyone.** `npm publish` shipped
  `"@smeltjs/core": "workspace:^"` verbatim, so installing it failed with
  `EUNSUPPORTEDPROTOCOL`. Republished with the range resolved, and a `prepublishOnly`
  guard now refuses a publish that would repeat it.

## 0.2.0 — 2026-09-02

`@smeltjs/core@0.2.0` · `@smeltjs/mcp@0.1.0`

### Added

- **`smelt hooks install`** — a guard preset for agent harnesses. A fail-open size guard
  (8 KB default, stat-only fast path) denies an oversized raw read with a reason naming
  the exact replacement command; rewrite mode is opt-in and always announced. Verified
  shims for Claude Code and Codex; experimental shims for Gemini, Grok, Hermes, Cursor
  and Cline, plus an opencode plugin; advisory documentation for KiloCode and Aider.
- **`@smeltjs/mcp`** — a stdio MCP server exposing `smelt_file`, `smelt_retrieve`,
  `repo_map` and `smelt_stats`, sharing the CLI's store through the same config
  discovery.
- Ten more structural languages, bringing the total to fifteen.

## 0.1.0 — 2026-09-02

`@smeltjs/core@0.1.0` — the first published version.

### Added

- The plan/apply/store/retrieve pipeline, with `reconstruct(smelt(x)) === x` asserted
  byte for byte.
- The structural planner (tree-sitter) and the lexical planner.
- `DirectoryElisionStore`: content-addressed, crash-safe, bytes re-verified against
  their hash on read, counters surviving a restart, and no eviction.
- Cache-prefix hygiene — detect and warn, never rewrite.
- The repo-map planner, modelled on Aider's and credited as such.
- `smelt init`, `smelt map`, `smelt retrieve`, `smelt stats`, and the `smelt` CLI.
- The measurement harness, its committed corpus, and the append-only results table.
