# smelt

Structure-aware, reversible context optimization for AI coding agents. A library, not a proxy.

**Status: pre-alpha — design phase.** Nothing here is ready to use.

## What it will do

Coding agents drown their models in tool output. `smelt` melts that output down to what the
current task needs, without ever destroying the rest:

- **Structure-aware elision** — tree-sitter (WASM) keeps the enclosing signature, docstring,
  and matched block; sibling code collapses to a marker. Never a byte-offset chop.
- **Reversible, always** — everything elided is stored locally, keyed by hash. The model gets
  a stub and a `retrieve(hash)` tool. Nothing is lost; retrieval frequency is *counted*, so
  over-pruning is measurable instead of invisible.
- **Explainable, always** — every elision can say what it removed and why
  ("collapsed 3 sibling functions, retrievable"). No learned scoring in v1: if a line is
  dropped, a rule dropped it, and the rule can be named.
- **Offline, always (v1)** — zero network calls, enforced by test. Reranking against a hosted
  model is a pluggable stage you wire your own key into; it is never the default.
- **Cache-prefix hygiene** — helpers for keeping prompt prefixes byte-stable, because provider
  prompt caches invalidate on any prefix byte change.

## What it will not do

- Publish savings numbers we didn't measure. Prior art is honest here when read carefully:
  Headroom's own README reports 15–20% token reduction for coding agents (higher only on
  narrow content types like JSON logs). Expect numbers in that class, reported from real
  traffic, or no numbers at all.
- Rewrite another agent's requests in flight. A proxy can be built *on top of* this library;
  the library itself only transforms content its caller hands it.
- Phone home. Ever.

## Prior art, gratefully

[Headroom](https://github.com/headroomlabs-ai/headroom) (proxy-seam compression + CCR),
[Aider's repo-map](https://aider.chat/2023/10/22/repomap.html) (tree-sitter + graph-ranked
symbol maps), [LLMLingua](https://github.com/microsoft/LLMLingua) (learned prompt compression),
[SweRank](https://arxiv.org/abs/2505.07849) (learned fix-context localization).

`smelt` is an independent project. It is used by (but not part of) the KLØDD app.

## License

Apache-2.0.
