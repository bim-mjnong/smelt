# Ensuring coding agents use smelt instead of raw reads — enforcement mechanisms, measured

**Date:** 2026-09-02 · **Status:** research note (not a decision record)
**Note on convention:** this file starts the `docs/research/` convention — dated research
notes (`YYYY-MM-DD-<topic>.md`), every claim cited to a primary source (URL or
`file:line`), every number measured and labelled with its machine context. No such
convention existed before this file.

**Question:** how do we ENSURE a coding agent (Claude Code first; also Codex CLI) uses
smelt instead of raw reads — when it wants to run `grep`/`cat`/`Read` on large output —
and keep that interception quick and memory-efficient?

**Machine context for every measured number in this file:** Apple M1 Max, 32 GB RAM,
macOS (Darwin 25.5.0), Node v26.4.0, repo at commit `37796ee`, `pnpm build` run fresh
on 2026-09-02, timings via `/usr/bin/time -p` / `-l` (maxRSS), small run counts
(3–5), best/typical of warm runs unless noted. These are laptop numbers, not benchmarks;
Law 4 applies — none of them belongs in the README.

---

## 1. Claude Code hooks — current capabilities (verified 2026-09-02)

All from the official hooks reference. The docs moved: `docs.anthropic.com` /
`docs.claude.com` hook pages now 301 to <https://code.claude.com/docs/en/hooks>
(guide: <https://code.claude.com/docs/en/hooks-guide>).

### PreToolUse output schema

- Decision lives at `hookSpecificOutput.permissionDecision` with values
  **`allow` / `deny` / `ask` / `defer`** (`defer` is recent: exits with
  `stop_reason: "tool_deferred"`). `permissionDecisionReason` accompanies it.
  Top-level `decision`/`reason` ("approve"/"block") are **deprecated** for this event
  and map to allow/deny.
  — <https://code.claude.com/docs/en/hooks#pretooluse-decision-control>
- **Who sees the deny reason** (verbatim from the decision-control table):
  "`permissionDecisionReason` | For `\"allow\"` and `\"ask\"`, shown to the user but
  not Claude. **For `\"deny\"`, shown to Claude.**" → a deny reason is a steering
  channel to the model, so it can (and should) contain the exact substitute command.
  — same section.
- **Input REWRITE exists: `hookSpecificOutput.updatedInput`.** Verbatim:
  "`updatedInput` | Modifies the tool's input parameters before execution. Replaces the
  entire input object, so include unchanged fields alongside modified ones. Claude Code
  evaluates permission rules … against the input your hook returns, not the input Claude
  sent. Combine with `\"allow\"` to auto-approve, or `\"ask\"` to show the modified
  input to the user." Shipped in v2.0.10 ("PreToolUse hooks can now modify tool
  inputs"), `ask`+`updatedInput` in v2.1.0.
  — <https://code.claude.com/docs/en/hooks#pretooluse-decision-control>;
  <https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md>
  Constraint that shapes the design below: `updatedInput` replaces the **input of the
  same tool** — it can rewrite a Bash `command`, but it cannot turn a `Read` call into
  a Bash call.
- Exit code 2 blocks the call and "Claude sees the stderr message as the denial
  reason"; exit 2 overrides even a JSON `allow`. Exit 1 is non-blocking (tool
  proceeds). — <https://code.claude.com/docs/en/hooks#exit-code-2-behavior-per-event>

### PostToolUse

- `hookSpecificOutput.additionalContext` reaches the model: "wraps the string in a
  system reminder … Claude reads the reminder on the next model request". Capped at
  10,000 chars (overflow goes to a file plus preview).
  — <https://code.claude.com/docs/en/hooks#posttooluse-decision-control>
- Top-level `decision: "block"` adds `reason` next to the tool result; "Claude still
  sees the original output; to replace it, use `updatedToolOutput`" — i.e.
  **PostToolUse can now REPLACE the tool output the model sees** (`updatedToolOutput`,
  must match the tool's output shape). Exit 2 in PostToolUse only shows stderr; the
  tool already ran. — same section.

### SessionStart / SessionEnd / Stop

- **SessionStart**: stdout (or JSON `hookSpecificOutput.additionalContext`) is "added
  to Claude's context at the start of the conversation, before the first prompt".
  Matchers: `startup|resume|clear|compact|fork`. Cannot block. Docs: "runs on every
  session, so keep these hooks fast". — <https://code.claude.com/docs/en/hooks#sessionstart>
- **SessionEnd**: cleanup only, "can't block session termination"; default budget
  **1.5 s**. — <https://code.claude.com/docs/en/hooks#sessionend>
- **Stop**: `decision: "block"` + `reason` keeps the turn going (loop-guarded at 8
  consecutive blocks); newer `hookSpecificOutput.additionalContext` on Stop gives
  non-blocking feedback "shown in the transcript as hook feedback". Input includes
  `last_assistant_message`. — <https://code.claude.com/docs/en/hooks#stop-decision-control>

### Matchers and what the hook sees

- Matcher syntax is three-way: `"*"` / `""` / omitted = match all; strings made only of
  letters, digits, `_ - space , |` = exact name or `|`/`,`-separated list
  (`Edit|Write`); anything else = **unanchored JS regex** (`Edit.*` matches
  `NotebookEdit`; use `^Edit$` for whole-string). Exact compare and un-flagged regex →
  case-sensitive by construction. MCP tools match as `mcp__server__tool`
  (server-wide needs `mcp__server__.*`).
  — <https://code.claude.com/docs/en/hooks#matcher-patterns>
- `tool_input` per tool (— <https://code.claude.com/docs/en/hooks#pretooluse-input>):
  - **Bash**: `command` (the full command string), `description`, `timeout`,
    `run_in_background`.
  - **Read**: `file_path` (**absolute** — "Claude Code expands `~` and relative paths
    before hooks run"), optional `offset`, `limit` (lines). → a Read guard can
    `stat()` the exact target with zero guessing.
  - **Grep**: `pattern`, `path`, `glob`, `output_mode`, `-i`, `multiline`.
    **Output size is unknowable pre-run** — the input names a pattern, not a result.
  - **Glob**: `pattern`, `path`.
- Execution: "All matching hooks run in parallel." Default timeout for command hooks is
  now **600 s** (per-hook `timeout` in seconds); no global latency budget is stated,
  only per-event "keep it fast" guidance. Config in `~/.claude/settings.json`,
  `.claude/settings.json`, `.claude/settings.local.json`, plugin `hooks/hooks.json`.
  — <https://code.claude.com/docs/en/hooks#timeouts>
- **Disabling built-ins**: a bare deny rule like `Bash` "removes the tool from Claude's
  context entirely, so Claude never sees it"; scoped rules (`Read(./secrets/**)`) block
  matching calls only. Also `--disallowedTools` and `--tools` on the CLI.
  — <https://code.claude.com/docs/en/permissions>;
  <https://code.claude.com/docs/en/cli-reference>

## 2. Enforcement design that follows

Three honest observations drive the shape:

1. **A deny costs a model round trip; a rewrite costs none.** A denied call bounces
   back to the model, which must think and re-issue — seconds and tokens. An
   `updatedInput` rewrite substitutes in-flight. So rewrite where the tool allows it
   (Bash), deny only where it doesn't (Read cannot be rewritten into a Bash call —
   `updatedInput` stays within the same tool, §1).
2. **The hook must stat the target itself, and only deny above a threshold.** Read
   hands the hook an absolute `file_path`; a stat-only guard costs ~20–30 ms (bash,
   measured §5) and lets every small read through untouched. Blanket denies of Read
   would fight the agent on the 90% of reads that are cheap.
3. **For Bash `grep`/`rg` you cannot know output size pre-run** (§1). The honest
   strategy is post-hoc: let it run, measure the actual output in **PostToolUse**, and
   either nudge (`additionalContext`: "that was 41 KB; next time pipe through smelt")
   or replace outright (`updatedToolOutput` with the smelted text — the elided bytes
   must land in a persistent store so `retrieve(hash)` still works, i.e.
   `DirectoryElisionStore`, `packages/core/src/store-dir.ts`). Pre-run, the only safe
   Bash rewrite is for commands whose subject is a _named file_ (`cat`/`head`/`tail`/
   `sed -n` on a path you can stat).
4. **Maximally-steering deny reasons.** Since the deny reason is shown to the model
   (§1), it should be a complete, copy-pasteable command, e.g.:
   `"<path> is 224,000 bytes. Do not Read it raw. Run: smelt <path> --budget 8000
--focus <what you are looking for> — markers in the output can be retrieved by
hash."` Anthropic's own guidance is that steering text should say when to use what
   (tool-description guidance, §4); the same applies to a deny string.

### Published precedents (real, checked 2026-09-02)

- **Anthropic's own example hook** denies Bash `grep` with exit 2 + stderr "Use 'rg'
  (ripgrep) instead of 'grep' …" and `find -name` → `rg --files` — official precedent
  for deny-with-substitute-command.
  — <https://github.com/anthropics/claude-code/blob/main/examples/hooks/bash_command_validator_example.py>
- **rtk** (token-reduction CLI, "60-90% on common dev commands" — their claim, not
  ours) is the one found **rewrite** precedent: its PreToolUse hook builds
  `hookSpecificOutput.updatedInput` with `.tool_input.command = $REWRITTEN`
  (rtk-prefixed command), exit codes selecting rewrite+allow / pass / rewrite+prompt.
  Exactly the Bash-rewrite shape proposed here.
  — <https://github.com/rtk-ai/rtk/blob/develop/hooks/claude/rtk-rewrite.sh>
- **orchestkit** intercepts Read of large files (>500 lines or >2000 tokens) and
  injects a structural summary as `additionalContext`, "never blocks a Read" — the
  soft-nudge end of the spectrum.
  — <https://github.com/yonatangross/orchestkit/blob/main/src/hooks/src/pretool/read/tldr-summary.ts>
- Deny-style tool-substitution hooks in the wild:
  <https://github.com/eriqueo/nixos-hwc/blob/main/.claude/hooks/enforce-tools.sh>
  (grep→rg, sed→Edit, `ask` on dangerous git);
  <https://github.com/xorphitus/nix-config/blob/main/modules/shared/config/claude/enforce-commands.sh>
  (grep→rg, find→fd, git→jj with an equivalence table in the deny message).

Dominant published pattern: **deny with an instructive reason**; input rewriting is
officially supported (v2.0.10) but rarely used — rtk is the working proof it holds up.

## 3. Codex CLI (verified 2026-09-02, direct look at openai/codex docs)

The in-repo docs (`docs/config.md`, `docs/execpolicy.md`) are stubs deferring to
<https://developers.openai.com/codex/*>, which 308-redirects to `learn.chatgpt.com/docs/*`
(server-supplied redirect; canonical URLs cited below are the developers.openai.com ones).

- **Codex has lifecycle hooks now.** Merged experimentally in rust-v0.114.0
  (<https://github.com/openai/codex/discussions/2150>), enabled by default by 0.150.1;
  `features.hooks` in config, loaded from `~/.codex/hooks.json`, `~/.codex/config.toml`,
  project `.codex/hooks.json` / `.codex/config.toml` (project layer requires trust).
  Events include `PreToolUse`, `PostToolUse`, `SessionStart`, `SessionEnd`, `Stop`,
  `UserPromptSubmit`. — <https://developers.openai.com/codex/config-reference>;
  <https://developers.openai.com/codex/config-advanced>
- **PreToolUse output schema mirrors Claude Code's**: `hookSpecificOutput` with
  `permissionDecision: "deny"` + `permissionDecisionReason`, or exit 2 + stderr; and
  **`updatedInput` exists** — "`permissionDecision: \"allow\"` with `updatedInput`";
  for Bash/`apply_patch`, "`updatedInput` must include a string `command` field".
  `permissionDecision: "ask"` is NOT supported (parse error, tool proceeds). Shell
  input arrives as `tool_name: "Bash"`, `tool_input.command`.
  — <https://developers.openai.com/codex/hooks>
- **PostToolUse** supports `hookSpecificOutput.additionalContext` ("added as extra
  developer context") and `decision: "block"` (replaces the tool result with
  feedback). Hook default timeout 600 s; model-visible hook output capped at "roughly
  2,500 tokens" (`additionalContextLimit`). — same page.
- **Exec policy (`.rules`, Starlark)**: `prefix_rule()` with `decision` ∈ `allow` /
  `prompt` / `forbidden` (strictest wins); applies to shell argv, splits simple
  `bash -lc` scripts via tree-sitter. **No rewrite** — "rules only classify/gate";
  closest is a `justification` string suggesting alternatives. Experimental.
  — <https://developers.openai.com/codex/exec-policy>
- Sandbox modes and approval policies gate _where/whether_ a command runs, not _what_
  it is. — <https://github.com/openai/codex/blob/main/docs/sandbox.md>
- **AGENTS.md** is Codex's instruction file (project guidance loaded per layer).
  — <https://github.com/openai/codex/blob/main/docs/agents_md.md>

**Strongest Codex mechanism today: the same PreToolUse `updatedInput` rewrite + deny
design as Claude Code** — the hook schema is near-identical, so one guard script
(reading `tool_input.command` / emitting `hookSpecificOutput`) can serve both, with
execpolicy `forbidden`/`prompt` rules as belt-and-braces and AGENTS.md for steering.
(Caveat: project-level hooks need the project layer trusted, and the VS Code extension
had an open bug skipping hooks — <https://github.com/openai/codex/issues/33413>.)

## 4. MCP tool-preference — what makes a model pick an MCP tool over a built-in

- **Server `instructions` is a hint, not a lever.** MCP spec (2025-06-18 schema,
  `InitializeResult`): "Instructions describing how to use the server … can be thought
  of like a 'hint' to the model. For example, this information MAY be added to the
  system prompt." (MAY — no client obligation.) In the 2026-07-28 spec the field moved
  to the `server/discover` result. Claude Code does surface it (changelog v1.0.52
  "Added support for MCP server instructions") and **caps descriptions+instructions at
  2 KB** (v2.1.84).
  — <https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle>;
  <https://modelcontextprotocol.io/specification/2026-07-28/server/discover>;
  <https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md>
- **Tool descriptions are the strongest soft lever.** Anthropic: "Provide extremely
  detailed descriptions. This is by far the most important factor in tool
  performance", including "When it should be used (and when it shouldn't)".
  — <https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools>
- **Tool annotations** (`readOnlyHint` etc.) are explicitly untrusted hints — "Clients
  should never make tool use decisions based on ToolAnnotations received from untrusted
  servers" — irrelevant for preference-forcing.
  — <https://modelcontextprotocol.io/specification/2026-07-28/server/tools#tool>
- **The only hard MCP-side lever is client-side removal of the built-in**: a bare
  permissions deny (`Read`, `Bash`) removes the tool from context entirely (§1), making
  the MCP tool the only path. Claude Code itself uses this shape (Cowork routes shell
  through `mcp__workspace__bash` with built-in Bash denied).
  — <https://code.claude.com/docs/en/permissions>

Net: MCP alone cannot _force_ preference — descriptions steer, deny rules force. And an
MCP smelt server has one unique structural advantage: it is a **long-lived process**, so
the grammar cache (§5) actually persists across calls.

## 5. Quick + memory-efficient — measurements (machine context in header)

Grammar loading is **lazy and cached, per process**: module-level
`cache = new Map<LanguageId, Language>()` and memoized `Parser.init()`
(`packages/core/src/plan/grammar.ts:39-40`), populated on first `loadGrammar()`
(`grammar.ts:80-92`). Bytes are read off disk and handed to tree-sitter as a
`Uint8Array` (Law 1). **The cache dies with the process** — a one-shot CLI pays the
load every invocation; only a resident server (MCP) amortizes it. The typescript
grammar is 2,342,690 B on disk (`ls -l packages/core/grammars/`, 2026-09-02).

| Measurement (typical of 3–5 warm runs)                  | wall time                        | maxRSS             |
| ------------------------------------------------------- | -------------------------------- | ------------------ |
| `node -e ''` (startup floor)                            | ~40 ms                           | —                  |
| `node packages/core/dist/cli/bin.js --version`          | 60–70 ms                         | 58 MB              |
| smelt 8.7 KB file, `--strategy lexical`                 | 80–100 ms                        | ~60 MB             |
| smelt 8.7 KB file, `--strategy structural`              | 190–210 ms                       | ~205 MB            |
| smelt 22.5 KB (`src/plan/structural.ts`), lexical       | 70–100 ms                        | ~60 MB             |
| smelt 22.5 KB, structural                               | 210–220 ms                       | 205–212 MB         |
| smelt 558 KB (synthetic concat TS), lexical             | 110–120 ms                       | 85–87 MB           |
| smelt 558 KB, structural                                | 220–350 ms                       | 232–236 MB         |
| `smelt map packages/core/src --budget 4000`, cold cache | ~190 ms                          | ~224 MB            |
| same, warm cache                                        | ~70 ms                           | ~66 MB             |
| stat-only guard, **bash** (`stat -f%z` + sed), warm     | 20–30 ms (first cold run 210 ms) | trivial            |
| stat-only guard, **node** (`fs.statSync`)               | 50–80 ms                         | ~58 MB (transient) |

Component costs, isolated (single-process script, `performance.now()`):
`Parser.init()` 6.8–8.4 ms; `Language.load()` of the 2.34 MB typescript wasm 3.7–5 ms;
cached `loadGrammar()` ~0.002 ms; **parse** 22.5 KB ≈ 14 ms (RSS after: 88 MB), parse
558 KB ≈ 154 ms (RSS after: 199 MB). So the structural premium is mostly _node module
graph + wasm heap + parse_, not the grammar file read — and RSS is dominated by the
tree-sitter wasm heap, which scales with input (~200 MB on a 558 KB file). All memory is
transient: the CLI exits, nothing stays resident.

Reduction observed (same machine, same commit): `src/plan/structural.ts` 22,462 B →
3,680 B (−83.6%, 2 elisions, structural); `docs/HANDOFF.md` records −86.5% lexical on
`plan/lexical.ts` (7,297 B → 985 B).

**Sane per-tool-call hook budget:** the always-on guard (every Read/Bash) should stay
stat-only — **single-digit ms of work, ≤30 ms wall as a bash script** (measured above;
a node guard triples that for no gain — node startup alone is ~40 ms measured, 50–80 ms
as a full guard). The smelt run itself (~100–350 ms) is paid **only on the redirect
path**, where it replaces either a multi-hundred-KB context injection or a model
round trip — both orders of magnitude more expensive. Hooks run in parallel (§1), so
one slow guard does not serialize others, but SessionStart map-on-start (~70–190 ms
measured) is the right place for the only "heavy" always-run work.

### The ~8 KB threshold, validated

Verdict: **8 KB (8192 B) is a sound default deny threshold for Read — keep it**, with
two amendments.

- Below ~8 KB, redirecting is a net loss: a deny costs a full model round trip
  (seconds + tokens for re-issue), and elisions on small files trend unprofitable —
  the lexical planner's own profitability check exists because a ~100 B marker can
  cost more than the lines it replaces (`docs/HANDOFF.md`, Slice 1/lexical notes).
- At and above 8 KB, measured smelt runs cost 80–220 ms and removed 80%+ on real
  source files (measured above), and the read would otherwise be resent to the model
  with the transcript on subsequent turns — recurring cost vs a one-time ~200 ms.
- **Amendment 1:** the threshold applies to the _stat'd size of the exact target_
  (Read gives an absolute `file_path`; honor `offset`/`limit` — a windowed Read of a
  huge file is already an economy move, let it pass).
- **Amendment 2:** for Bash, don't threshold pre-run at all except when the command
  names a stat-able file; unpredictable-output commands (grep/rg) get the PostToolUse
  treatment (§2, point 3).

## 6. Ranked recommendations (enforcement strength × latency × memory)

1. **PreToolUse Bash rewrite via `updatedInput`** — strongest with zero extra round
   trips. Match `Bash`; when the command is `cat|head|tail|sed -n` on a stat-able file
   > 8 KB, rewrite to `smelt <file> --budget 8000` (rtk proves the mechanism in
   > production). Guard cost ~25 ms; smelt cost 80–350 ms only when triggered; memory
   > transient. Ports to Codex nearly verbatim (same schema, §3). Combine with `ask`
   > where the user should see the substitution.
2. **PreToolUse Read deny at 8 KB, stat-only bash guard** — strong; costs one model
   round trip per deny, so the reason must be maximally steering (exact smelt command
   incl. `--focus` hint; deny reasons are shown to the model, §1). ~25 ms per Read.
   This is the KOT-212 "size-guard deny" leg — threshold validated, amendments in §5.
3. **PostToolUse on Bash: measure actual output; nudge via `additionalContext`, or
   replace via `updatedToolOutput`** — the only honest treatment of grep-shaped
   commands (size unknowable pre-run). Replacement requires the elided bytes in a
   `DirectoryElisionStore` and a retrieval front door the agent can call — **gap: ship
   `smelt retrieve <hash>` (CLI) and/or the MCP `smelt_retrieve` tool before enabling
   replacement; nudge-only until then.**
4. **MCP server (`smelt` + `smelt_retrieve`) + permissions deny of built-ins where
   lockdown is wanted** — the only resident-process option, so the 2.3 MB-wasm grammar
   cache and ~200 MB heap are paid once, not per call; tool descriptions written to
   Anthropic's "when to use / when not" guidance; bare `Read`/`Bash` deny makes it the
   only path. Costs: a resident ~60–230 MB process; blunter UX. MCP `instructions`
   alone is a MAY-grade hint (§4) — never rely on it for enforcement.
5. **Instructions files (CLAUDE.md / AGENTS.md) + Codex execpolicy `forbidden` rules**
   — weakest (advisory / deny-only) but zero-latency and needed anyway: instructions
   explain the _why_ and the marker/retrieve contract; execpolicy is Codex's
   belt-and-braces under its hook layer.

### Concrete KOT-212 preset shape (validated against all of the above)

- **SessionStart** (`startup|resume|clear|compact` matcher): `smelt map . --budget
4000 --cache .smelt-tags` → `additionalContext`. Measured 70–190 ms — fine for a
  once-per-session hook ("keep these hooks fast" satisfied).
- **PreToolUse / `Read`** (exact matcher): bash stat guard, deny > 8192 B with a
  copy-pasteable smelt command as the reason. ~25 ms.
- **PreToolUse / `Bash`**: rewrite named-file large reads via `updatedInput`; pass
  everything else. ~25 ms + smelt only when rewriting.
- **PostToolUse / `Bash`**: output-size check → `additionalContext` nudge (upgrade to
  `updatedToolOutput` once a retrieve front door ships). Store: directory store so
  counters and bytes survive the process.
- **Stop**: read `stats()` off the store journal → non-blocking `additionalContext`
  ("expansion rate this session: X of Y elisions retrieved") — the honest signal
  (Law 3) surfaced where the user ends the turn. Never `decision: "block"`.
- Same four scripts re-shipped as Codex `hooks.json` (schema-compatible, §3), plus an
  execpolicy `prompt` rule on `grep|cat` of large files as backstop and an AGENTS.md
  paragraph.

---

_Sources of record: <https://code.claude.com/docs/en/hooks>,
<https://code.claude.com/docs/en/permissions>,
<https://code.claude.com/docs/en/cli-reference>,
<https://developers.openai.com/codex/hooks>,
<https://developers.openai.com/codex/config-reference>,
<https://developers.openai.com/codex/exec-policy>,
<https://modelcontextprotocol.io/specification/2026-07-28>,
<https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools>, the
GitHub repos cited inline, and this repository (`packages/core/src/plan/grammar.ts`,
`docs/HANDOFF.md`). All measured numbers: this file's header machine context,
2026-09-02._
