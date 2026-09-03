# site/ — the smelt landing page

Vite + React + TypeScript + Tailwind v4, deployed to GitHub Pages at
<https://smeltjs.github.io/smelt/> by `.github/workflows/site.yml` on pushes to `main`
that touch any source the page is generated from — `site/**`, the bench results, both
package manifests, the harness and language registries, the grammar map and
`guards.json`. The workflow's `paths:` list is the authority; it is longer than
`site/**` because a release that moves a version has to redeploy the page that prints
it.

## Commands

```sh
pnpm --filter "@smeltjs/site..." build   # generate → tsc --noEmit → vite build
pnpm --filter @smeltjs/site dev          # local dev server (core must be built)
pnpm --filter @smeltjs/site preview      # serve the production build locally
```

The trailing `...` selects the site **and its dependencies**, in topological order —
`generate` runs `scripts/bench-data.mjs` and `scripts/facts-data.mjs`, and the second
imports the *built* `@smeltjs/core`, so a clean checkout needs the core built first.
Without it (or a prior `pnpm build`) the generator dies with `@smeltjs/core could not be
imported`.

The site is a workspace package and mostly stays out of the npm packages' world — but
not entirely, and the exception is deliberate: `pnpm verify` typechecks the site (its
components consume core's shape through `facts.json`, and a renamed field must be red
before it deploys, not after), and `packages/core/test/guards/site-facts.test.ts` runs
`scripts/facts-data.mjs` as a subprocess. Site code is therefore on root verify's path.
`site/scripts/` is formatted and linted with everything else for that reason; the app
sources under `site/src/` are not (`.prettierignore`).

## Law 4 at build time

`scripts/bench-data.mjs` parses the **latest tier-1 run** out of
`packages/core/bench/RESULTS.md` into `src/generated/bench.json` (gitignored) on every
build. The measured-numbers section renders that JSON; no number on the page is typed
by hand. A missing or malformed RESULTS.md fails the build.

`scripts/facts-data.mjs` is the same seam for the facts the **packages** own — both
versions, the harness tier table, the structural-language count, the grammar count and
the guard tally — into `src/generated/facts.json` (gitignored). Components import that
JSON; none of them types a package fact, and a tier word written into a component is a
red guard. The versions come from the committed manifests, which is the repository's
record of a release and not npm's: publish before merging a version bump, or the page
names a release no registry carries yet.

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
