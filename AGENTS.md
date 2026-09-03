# smelt

Structure-aware, reversible, offline context optimization for AI coding agents — a
pnpm workspace publishing `@smeltjs/core` and `@smeltjs/mcp`.

Package manager: pnpm.

The gate is non-standard, and it is one command:

Run `pnpm verify` from the repository root — the format check, the lint, the build, the
typecheck, the tests and the mutation runner. A change is not finished until it exits 0.

- [CONTEXT.md](CONTEXT.md) — the domain vocabulary: every term the code uses, with its
  exact meaning. Read this before renaming anything.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the four laws, the module map, and the
  reasoning behind each seam.
