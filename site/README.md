# site/ — the smelt landing page

Vite + React + TypeScript + Tailwind v4, deployed to GitHub Pages at
<https://smeltjs.github.io/smelt/> by `.github/workflows/site.yml` on pushes to `main`
that touch `site/**` (or the bench results the page renders).

## Commands

```sh
pnpm --filter @smeltjs/site dev       # local dev server
pnpm --filter @smeltjs/site build     # bench-data → tsc --noEmit → vite build
pnpm --filter @smeltjs/site preview   # serve the production build locally
```

The site is a workspace package but stays out of the npm packages' world: root
`pnpm verify` filters to `packages/**` (plus a `site/` entry in `.prettierignore`), and
the core zero-network guard walks `@smeltjs/core`'s own manifest entrypoints — nothing
here can touch either.

## Law 4 at build time

`scripts/bench-data.mjs` parses the **latest tier-1 run** out of
`packages/core/bench/RESULTS.md` into `src/generated/bench.json` (gitignored) on every
build. The measured-numbers section renders that JSON; no number on the page is typed
by hand. A missing or malformed RESULTS.md fails the build.

The sixty-second-tour output was captured from a real run of the built CLI
(`@smeltjs/core` v0.2.0, 2026-09-02) and pasted verbatim — if the CLI's report format
changes, re-record it rather than editing the strings.

## React Bits Pro / the license key

`components.json` registers the two React Bits registries with
`Authorization: Bearer ${REACTBITS_LICENSE_KEY}`. The key lives in `site/.env.local`
(gitignored) and is needed **only when INSTALLING new registry items**, e.g.:

```sh
cd site && npx shadcn@latest add @reactbits-pro/<slug>
```

Building and deploying never contact the registry: installed sources are committed
(the license's use-in-project grant covers shipping them, edited, in this repo's
pages), and CI runs with no key at all. The Agent Kit material under `site/.claude/`
and `site/prompts/` is licensed reference-only and is gitignored — read it, follow it,
never commit it.

## Design constraints

- Palette is `assets/PALETTE.md` verbatim: charcoal ground, ember as the **only**
  accent, white-hot scarce. Tokens live in `src/index.css` (`@theme`).
- Terminal-dark rules apply (dark-only page, layered surfaces + hairlines, mono only
  for machine-adjacent text, one reveal animation with a `prefers-reduced-motion`
  fallback, concentric 16/12 frame radii).
- Zero third-party network calls at runtime: fonts are self-hosted (`@fontsource`),
  no trackers, no analytics, no CDN.
- No number appears on the page that is not parsed from `RESULTS.md`, quoted from the
  README's cited comparables, or captured from a real CLI run.
