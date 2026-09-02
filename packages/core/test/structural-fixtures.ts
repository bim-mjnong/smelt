/**
 * TypeScript, TSX, Rust, Python, Go — and the ten Slice 4b languages — sources the
 * structural-planner tests and guards share.
 *
 * They are template literals rather than files on disk so the guards can import them
 * relatively — the `@guard` alias redirects only the library, and test data must not
 * move when the mutation runner points the guards at a broken copy of `src`.
 */

import type { StructuralLanguage } from '../src/plan/structural.ts';

/** Five top-level functions, doc comments attached, one of them the focus target. */
export const FUNCTIONS_TS = `/** Parses the raw configuration file into a validated object. */
function parseConfig(raw: string): Record<string, unknown> {
  const value = JSON.parse(raw) as Record<string, unknown>;
  return value;
}

/** Normalises a request path: collapses slashes, strips the trailing one. */
function normalisePath(path: string): string {
  return path.replace(/\\/+/g, '/').replace(/\\/$/, '');
}

/** The entry point every request goes through — the one worth keeping. */
export function handleRequest(path: string, raw: string): string {
  const config = parseConfig(raw);
  return renderResponse(normalisePath(path), config);
}

/** Renders the response body for a resolved path and configuration. */
function renderResponse(path: string, config: Record<string, unknown>): string {
  return JSON.stringify({ path, config });
}

/** Writes one structured line to the log — kept boring on purpose. */
function logLine(message: string): void {
  console.error(JSON.stringify({ message }));
}
`;

/** The doc comment attached to {@link LONG_DOC_TS}'s target, all forty lines of it. */
export const LONG_DOC_COMMENT = `/**
 * Retries an operation with exponential backoff.
 *
 * The delay doubles on every attempt, starting from the base delay the caller
 * provides, and the operation is retried until it either succeeds or the attempt
 * limit is reached. The last error is rethrown so the caller sees the real failure
 * rather than a wrapper. Each of the following lines exists to make this comment
 * long enough to be worth eliding — and the guard asserts every one survives:
 *
 * - line one of the padding, describing nothing in particular
 * - line two of the padding, describing nothing in particular
 * - line three of the padding, describing nothing in particular
 * - line four of the padding, describing nothing in particular
 * - line five of the padding, describing nothing in particular
 * - line six of the padding, describing nothing in particular
 * - line seven of the padding, describing nothing in particular
 * - line eight of the padding, describing nothing in particular
 * - line nine of the padding, describing nothing in particular
 * - line ten of the padding, describing nothing in particular
 * - line eleven of the padding, describing nothing in particular
 * - line twelve of the padding, describing nothing in particular
 * - line thirteen of the padding, describing nothing in particular
 * - line fourteen of the padding, describing nothing in particular
 * - line fifteen of the padding, describing nothing in particular
 * - line sixteen of the padding, describing nothing in particular
 * - line seventeen of the padding, describing nothing in particular
 * - line eighteen of the padding, describing nothing in particular
 * - line nineteen of the padding, describing nothing in particular
 * - line twenty of the padding, describing nothing in particular
 * - line twenty-one of the padding, describing nothing in particular
 * - line twenty-two of the padding, describing nothing in particular
 * - line twenty-three of the padding, describing nothing in particular
 * - line twenty-four of the padding, describing nothing in particular
 * - line twenty-five of the padding, describing nothing in particular
 * - line twenty-six of the padding, describing nothing in particular
 * - line twenty-seven of the padding, describing nothing in particular
 * - line twenty-eight of the padding, describing nothing in particular
 *
 * @returns whatever the operation eventually returned
 */`;

/** A target declaration with a forty-line doc comment, between forgettable siblings. */
export const LONG_DOC_TS = `/** Reads the whole stream into a string, chunk by chunk, patiently. */
async function readAll(stream: AsyncIterable<string>): Promise<string> {
  let out = '';
  for await (const chunk of stream) out += chunk;
  return out;
}

/** Sleeps for the given number of milliseconds. Nothing more to it. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

${LONG_DOC_COMMENT}
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  attempts: number,
  baseDelayMs: number,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }
  throw lastError;
}

/** Formats a duration in milliseconds as a human-readable string. */
function formatDuration(ms: number): string {
  return ms >= 1000 ? \`\${(ms / 1000).toFixed(1)}s\` : \`\${ms}ms\`;
}

/** Clamps a number into an inclusive range. The most boring sibling of all. */
function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}
`;

/** TSX with mixed top-level kinds, so a collapse has more than one thing to name. */
export const MIXED_TSX = `import { render } from 'preact';

/** Props for the badge: a label and an optional emphasis flag. */
interface BadgeProps {
  label: string;
  strong?: boolean;
}

/** A pill-shaped badge used all over the place in this imaginary app. */
function Badge(props: BadgeProps) {
  return <span className={props.strong ? 'badge strong' : 'badge'}>{props.label}</span>;
}

/** The align choices the toolbar supports, spelled out as a type alias. */
type Align = 'left' | 'center' | 'right';

/** Keeps track of how often each toolbar button has been pressed. */
class PressCounter {
  counts = new Map<string, number>();
  press(id: string): void {
    this.counts.set(id, (this.counts.get(id) ?? 0) + 1);
  }
}

/** The toolbar — the component this file is really about. */
export function Toolbar({ align }: { align: Align }) {
  return (
    <div className={\`toolbar \${align}\`}>
      <Badge label="saved" />
    </div>
  );
}

/** A footer nobody looks at, present to give the toolbar a sibling below. */
function Footer() {
  return <footer className="footer">fin — © nobody</footer>;
}
`;

/**
 * Multi-byte characters inside collapsible declarations, with functions at the run
 * edges — the fixture for "ranges never split a character, never cross a node
 * boundary".
 */
export const BOUNDARY_TS = `/** Grüße aus dem Kommentar — ümlauts on purpose. */
function greetInGerman(name: string): string {
  return \`Grüß dich, \${name} — schön, dass du da bist! 🎉\`;
}

/** Смалтит текст — cyrillic in the body below, too. */
function greetInRussian(name: string): string {
  return \`Привет, \${name} — рады видеть! ✨\`;
}

/** The target: plain ascii, easy to focus on. */
export function greetTarget(name: string): string {
  return \`hello, \${name}\`;
}

/** 日本語のコメント。バイト境界のためのフィクスチャ。 */
function greetInJapanese(name: string): string {
  return \`こんにちは、\${name}さん 🙇\`;
}

/** One more multi-byte sibling so the tail run ends on a function boundary. 🔚 */
function farewell(name: string): string {
  return \`auf Wiedersehen, \${name} — до свидания\`;
}
`;

/** The two-line `///` doc comment {@link FUNCTIONS_RS}'s target must keep. */
export const RUST_DOC_COMMENT = `/// The function this file is really about.
/// Its doc comment must survive, both lines of it.`;

/** The outer attribute {@link FUNCTIONS_RS}'s target must keep, alongside its doc. */
export const RUST_ATTRIBUTE = `#[inline]`;

/**
 * Rust: two collapsible functions above the target, a struct and an impl below. The
 * target and the struct both carry outer attributes, because tree-sitter-rust parses
 * `#[…]` as a top-level *sibling* of the item it decorates — the exact shape that once
 * detached an attribute (and the doc comment above it) from a kept declaration.
 */
export const FUNCTIONS_RS = `/// Parses a raw config string into pairs. Boring on purpose.
fn parse_config(raw: &str) -> Vec<(String, String)> {
    raw.lines().filter_map(|l| l.split_once('=')).map(|(k, v)| (k.into(), v.into())).collect()
}

/// Collapses duplicate slashes in a path. Also boring.
fn normalise(path: &str) -> String {
    path.split('/').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("/")
}

${RUST_DOC_COMMENT}
${RUST_ATTRIBUTE}
pub fn resolve_target(name: &str) -> String {
    format!("target::{}", normalise(name))
}

/// A struct sibling below the target.
#[derive(Debug, Clone)]
pub struct Registry {
    entries: Vec<String>,
}

impl Registry {
    fn insert(&mut self, entry: String) {
        self.entries.push(entry);
    }
}
`;

/** The docstring {@link FUNCTIONS_PY}'s target must keep, indentation and all. */
export const PYTHON_DOCSTRING = `    """The function this file is really about.

    Its docstring lives inside the body, so keeping the definition whole
    keeps the docstring — asserted, not assumed.
    """`;

/**
 * Python: a shebang (pinned — it parses as a plain comment, but it decides which
 * interpreter runs the file), statements, a decorated definition and a class above the
 * target, two plain functions below — so one collapse is the pure `collapsed 2 sibling
 * functions` form and another has mixed kinds to name. The survivor of this fixture
 * must *reparse* as Python; the fixture itself parses with zero ERROR nodes, and the
 * guard asserts the survivor introduces none.
 */
export const FUNCTIONS_PY = `#!/usr/bin/env python3
"""Fixture module for the python structural tests."""

import json

# A loader nobody asked about.
def load_config(raw):
    """Parses a raw JSON config blob."""
    return json.loads(raw)

@functools.lru_cache
def cached_count():
    """A decorated sibling, so the collapse has a wrapper to unwrap."""
    return 3

class Registry:
    """Holds every user this imaginary module has seen."""

    def add(self, user):
        self.users.append(user)

def fetch_user(user_id):
${PYTHON_DOCSTRING}
    return {"id": user_id, "count": cached_count()}

def format_user(user):
    """Renders one user as a line of text."""
    return "user {}".format(user["id"])

def forget_user(user):
    """Drops a user on the floor. Nobody calls this."""
    del user
`;

/** The two-line `//` doc comment {@link FUNCTIONS_GO}'s target must keep. */
export const GO_DOC_COMMENT = `// HandleRequest is the function this file is really about.
// Its doc comment must survive, both lines of it.`;

/**
 * Go: package clause, import, a function, a type and a method above the target — a
 * mixed run with kinds to name — and two plain functions below for the pure
 * `collapsed 2 sibling functions` form.
 */
export const FUNCTIONS_GO = `// Package fixture exists for the go structural tests.
package fixture

import "strings"

// ParseConfig splits raw config into pairs. Boring on purpose.
func ParseConfig(raw string) []string {
	return strings.Split(raw, "\\n")
}

// Registry holds handler names.
type Registry struct {
	names []string
}

// Add registers one handler name.
func (r *Registry) Add(name string) {
	r.names = append(r.names, name)
}

${GO_DOC_COMMENT}
func HandleRequest(path string) string {
	return "handled:" + Normalise(path)
}

// Normalise collapses duplicate slashes. A sibling below the target.
func Normalise(path string) string {
	return strings.Join(strings.FieldsFunc(path, func(r rune) bool { return r == '/' }), "/")
}

// LogLine writes one line nobody reads.
func LogLine(line string) {
	println(line)
}
`;

/**
 * Go with a build constraint: `//go:build` must be followed by a blank line (the Go
 * spec requires it), so it can never *attach* to a declaration — it must be pinned to
 * the file instead, or the survivor silently loses its build constraint.
 */
export const BUILD_TAG_GO = `//go:build linux

// Package tagged exists so the build-tag pinning has something to collapse around.
package tagged

// Helper is a collapsible sibling with enough doc text to make the cut profitable.
func Helper(value int) int {
	return value + 1
}

// Target is the declaration the focus keeps.
func Target(value int) int {
	return value + 2
}
`;

/* -------------------------------------------------------------------------- *
 * Slice 4b — ten more languages, one fixture each. Every fixture has the same
 * anatomy: a run of collapsible siblings above the focus target (mixed kinds,
 * so the marker has something to name), a doc comment attached to the target
 * in the language's own idiom, and two same-kind siblings below the target so
 * one collapse takes the pure `collapsed 2 sibling <kind>s` form. Languages
 * with a file-governing prefix (shebangs, `<?php`) include it, because the
 * planner must pin it rather than collapse it.
 * -------------------------------------------------------------------------- */

/** The JSDoc line {@link FUNCTIONS_JS}'s target must keep. */
export const JS_DOC_COMMENT = `/** The handler this file is really about. */`;

/** JavaScript with a shebang: the hash-bang line must pin, never collapse. */
export const FUNCTIONS_JS = `#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

/** Reads a config file from disk and parses it. A boring, collapsible sibling. */
async function readConfig(path) {
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw);
}

${JS_DOC_COMMENT}
export function handleRequest(path) {
  return renderResponse(normalise(path));
}

/** Renders a response object for a resolved path. Collapsible sibling below. */
function renderResponse(path) {
  return JSON.stringify({ path, ok: true });
}

/** Normalises a request path, dropping empty segments. The most boring sibling. */
function normalise(path) {
  return path.split('/').filter(Boolean).join('/');
}
`;

/** The javadoc block {@link FUNCTIONS_JAVA}'s target must keep. */
export const JAVA_DOC_COMMENT = `/** The class this file is really about. */`;

/** Java: package and import above, javadoc'd classes as the collapsible siblings. */
export const FUNCTIONS_JAVA = `package fixture.example;

import java.util.List;

/** A parser nobody asked about — javadoc attached, collapsible with it. */
class ConfigParser {
  static List<String> parse(String raw) {
    return List.of(raw.split(","));
  }
}

${JAVA_DOC_COMMENT}
public class RequestHandler {
  String handle(String path) {
    return "handled:" + path;
  }
}

/** Renders one response body. A collapsible sibling below the target. */
class ResponseRenderer {
  String render(String path) {
    return "{" + path + "}";
  }
}

/** Writes one line to stdout. The most boring sibling of all. */
class LineLogger {
  void log(String line) {
    System.out.println(line);
  }
}
`;

/** The block comment {@link FUNCTIONS_C}'s target must keep. */
export const C_DOC_COMMENT = `/* The function this file is really about. */`;

/** C: preprocessor directives above, doc'd functions as the collapsible siblings. */
export const FUNCTIONS_C = `#include <stdio.h>
#include <string.h>

#define MAX_PATH_BYTES 256

/* Copies a raw config line into the out buffer. Boring and collapsible. */
static int parse_config(const char *raw, char *out) {
  strncpy(out, raw, MAX_PATH_BYTES - 1);
  return 0;
}

${C_DOC_COMMENT}
int handle_request(const char *path, char *out) {
  return snprintf(out, MAX_PATH_BYTES, "handled:%s", path);
}

/* Renders one response line into the out buffer. Collapsible sibling below. */
static int render_response(const char *path, char *out) {
  return snprintf(out, MAX_PATH_BYTES, "{%s}", path);
}

/* Writes one line to stderr. The most boring sibling of all. */
static void log_line(const char *line) {
  fprintf(stderr, "%s", line);
}
`;

/** The `///` doc comment {@link FUNCTIONS_CPP}'s target must keep. */
export const CPP_DOC_COMMENT = `/// The function this file is really about.`;

/** C++: an include above, `///` doc'd functions as the collapsible siblings. */
export const FUNCTIONS_CPP = `#include <string>

/// Trims a raw config string down to its first entry. Boring and collapsible.
static std::string parse_config(const std::string &raw) {
  return raw.substr(0, raw.find(';'));
}

${CPP_DOC_COMMENT}
std::string handle_request(const std::string &path) {
  return "handled:" + path;
}

/// Renders one response body. A collapsible sibling below the target.
static std::string render_response(const std::string &path) {
  return "{" + path + "}";
}

/// Swallows one log line. The most boring sibling of all.
static void log_line(const std::string &line) {
  static_cast<void>(line);
}
`;

/** The `///` XML doc comment {@link FUNCTIONS_CS}'s target must keep. */
export const CS_DOC_COMMENT = `/// <summary>The class this file is really about.</summary>`;

/**
 * C#: a using directive above, `///` doc'd classes as the collapsible siblings. No
 * file-scoped namespace on purpose — `namespace X;` adopts everything after it as its
 * children, which would leave this planner two top-level units and nothing to say.
 */
export const FUNCTIONS_CS = `using System;

/// <summary>A parser nobody asked about — doc attached, collapsible with it.</summary>
class ConfigParser
{
    public static string[] Parse(string raw) => raw.Split(',');
}

${CS_DOC_COMMENT}
public class RequestHandler
{
    public string Handle(string path) => "handled:" + path;
}

/// <summary>Renders one response body. A collapsible sibling below.</summary>
class ResponseRenderer
{
    public string Render(string path) => "{" + path + "}";
}

/// <summary>Writes one line to the console. The most boring sibling.</summary>
class LineLogger
{
    public void Log(string line) => Console.WriteLine(line);
}
`;

/** The `#` doc comment {@link FUNCTIONS_RB}'s target must keep. */
export const RUBY_DOC_COMMENT = `# The method this file is really about.`;

/**
 * Ruby: shebang and `# frozen_string_literal:` magic comment (both pinned), then `#`
 * doc'd methods. The survivor must *reparse* as ruby — `end`-delimited blocks mean a
 * bare `<<smelt…>>` marker line would open a heredoc and swallow everything after it,
 * which is why the marker lands as a `#` comment.
 */
export const FUNCTIONS_RB = `#!/usr/bin/env ruby
# frozen_string_literal: true

require "json"

# Parses a raw JSON config blob. A boring, collapsible sibling.
def load_config(raw)
  JSON.parse(raw)
end

${RUBY_DOC_COMMENT}
def handle_request(path)
  "handled:" + render_response(path)
end

# Renders one response as JSON. A collapsible sibling below the target.
def render_response(path)
  { path: path }.to_json
end

# Writes one line to stderr. The most boring sibling of all.
def log_line(line)
  warn line
end
`;

/** The PHPDoc block {@link FUNCTIONS_PHP}'s target must keep. */
export const PHP_DOC_COMMENT = `/** The function this file is really about. */`;

/** PHP: the `<?php` tag (pinned), a declare, then PHPDoc'd functions as siblings. */
export const FUNCTIONS_PHP = `<?php

declare(strict_types=1);

/** Splits a raw config string into parts. A boring, collapsible sibling. */
function parse_config(string $raw): array {
    return explode(',', $raw);
}

${PHP_DOC_COMMENT}
function handle_request(string $path): string {
    return 'handled:' . $path;
}

/** Renders one response body. A collapsible sibling below the target. */
function render_response(string $path): string {
    return '{' . $path . '}';
}

/** Writes one line to the error log. The most boring sibling of all. */
function log_line(string $line): void {
    error_log($line);
}
`;

/** The KDoc block {@link FUNCTIONS_KT}'s target must keep. */
export const KOTLIN_DOC_COMMENT = `/** The function this file is really about. */`;

/**
 * Kotlin: package header and import list, then the KDoc'd target *directly after the
 * imports* — the regression shape for the import_list bug: tree-sitter-kotlin extends
 * the import_list node over a doc comment that follows it, so without the planner's
 * trailing-comment split the target's KDoc would be collapsed with the imports. Three
 * KDoc'd functions below give the pure same-kind collapse.
 */
export const FUNCTIONS_KT = `package fixture.example

import kotlin.collections.List
import kotlin.text.StringBuilder
import kotlin.sequences.Sequence

${KOTLIN_DOC_COMMENT}
fun handleRequest(path: String): String = "handled:" + renderResponse(path)

/** Splits a raw config string into parts. A boring, collapsible sibling. */
fun parseConfig(raw: String): List<String> = raw.split(",")

/** Renders one response body. A collapsible sibling below the target. */
fun renderResponse(path: String): String = "{" + path + "}"

/** Writes one line to stdout. The most boring sibling of all. */
fun logLine(line: String) {
    println(line)
}
`;

/** The `///` doc comment {@link FUNCTIONS_SWIFT}'s target must keep. */
export const SWIFT_DOC_COMMENT = `/// The function this file is really about.`;

/** Swift: an import above, `///` doc'd functions as the collapsible siblings. */
export const FUNCTIONS_SWIFT = `import Foundation

/// Splits a raw config string into parts. A boring, collapsible sibling.
func parseConfig(_ raw: String) -> [String] {
    return raw.components(separatedBy: ",")
}

${SWIFT_DOC_COMMENT}
func handleRequest(_ path: String) -> String {
    return "handled:" + path
}

/// Renders one response body. A collapsible sibling below the target.
func renderResponse(_ path: String) -> String {
    return "{" + path + "}"
}

/// Writes one line to standard output. The most boring sibling of all.
func logLine(_ line: String) {
    print(line)
}
`;

/** The `#` doc comment {@link FUNCTIONS_SH}'s target must keep. */
export const BASH_DOC_COMMENT = `# The function this file is really about.`;

/**
 * Bash: the shebang is pinned — it decides which interpreter runs the file, exactly
 * the way a go build tag decides which builds see it. The survivor must *reparse* as
 * bash: `fi`/`done`/`}` delimited blocks mean a bare `<<smelt…>>` marker line would
 * open a heredoc and swallow everything after it, so the marker lands as a `#`
 * comment.
 */
export const FUNCTIONS_SH = `#!/usr/bin/env bash
set -euo pipefail

# Reads a config file from disk and prints it. A boring, collapsible sibling.
load_config() {
  cat "$1"
}

${BASH_DOC_COMMENT}
handle_request() {
  echo "handled:$1"
}

# Renders one response body to stdout. A collapsible sibling below the target.
render_response() {
  printf '{%s}' "$1"
}

# Writes one line to stderr. The most boring sibling of all.
log_line() {
  echo "$1" >&2
}

handle_request "$@"
`;

/* -------------------------------------------------------------------------- *
 * Pin and survivor fixtures beyond the per-language canon: shebangs in the
 * languages whose grammars give them their own node kind, c/c++'s
 * `#pragma once`, ruby's split-heredoc shape, and php's mixed-HTML mode.
 * -------------------------------------------------------------------------- */

/** TypeScript with a shebang: `hash_bang_line` must pin, never collapse. */
export const SHEBANG_TS = `#!/usr/bin/env -S npx tsx

/** Loads the raw config from disk. A boring, collapsible sibling with padding. */
function loadConfig(path: string): string {
  return path;
}

/** The declaration the focus keeps. */
export function runTarget(flag: string): string {
  return flag;
}
`;

/** Kotlin with a shebang: `shebang_line` must pin, never collapse. */
export const SHEBANG_KT = `#!/usr/bin/env kotlin

/** Splits a raw config string into parts. A boring, collapsible sibling. */
fun parseConfig(raw: String): List<String> = raw.split(",")

/** The declaration the focus keeps. */
fun runTarget(flag: String): String = flag
`;

/** Swift with a shebang: `shebang_line` must pin, never collapse. */
export const SHEBANG_SWIFT = `#!/usr/bin/env swift

/// Splits a raw config string into parts. A boring, collapsible sibling.
func parseConfig(_ raw: String) -> [String] {
    return raw.components(separatedBy: ",")
}

/// The declaration the focus keeps.
func runTarget(_ flag: String) -> String {
    return flag
}
`;

/**
 * C/C++ preprocessor shapes: `#pragma once` parses as a preproc_call — it must pin
 * (collapsing it changes header inclusion semantics), and the `#ifdef … #endif`
 * region must be labelled a preprocessor conditional, never a "declaration" the
 * parse tree does not contain.
 */
export const PRAGMA_C = `#pragma once

#ifdef FIXTURE_TRACE
static int trace_level = 1;
#endif

/* Copies one raw config line into place. A boring, collapsible sibling. */
static int parse_config(const char *raw) {
  return raw[0];
}

/* The declaration the focus keeps. */
int run_target(const char *flag) {
  return flag[0];
}
`;

/**
 * Ruby's split-heredoc shape: tree-sitter-ruby emits the heredoc body as a top-level
 * *sibling* of the statement holding its opener. Opener and body must travel as one
 * unit — a collapse keeping the opener while cutting the body leaves an unterminated
 * heredoc that swallows every kept declaration after it, and the reparse cannot even
 * see it (no ERROR node for a heredoc left open at EOF).
 */
export const RUBY_HEREDOC = `# frozen_string_literal: true

QUERY_FOR_ACTIVE_USERS = <<~SQL
  select id, name, last_seen_at from users
  where active and last_seen_at > now() - interval '30 days'
  order by last_seen_at desc
SQL

# The method this file is really about.
def handle_request(path)
  "handled:" + path
end

# Renders one response. A collapsible sibling below the target.
def render_response(path)
  path
end

# Writes one line to stderr. The most boring sibling of all.
def log_line(line)
  warn line
end
`;

/**
 * PHP in mixed-HTML mode: raw markup between `?>` and `<?php` parses as `text` and
 * `text_interpolation` nodes. The marker must label them honestly — an html section
 * is not a "declaration" — and a collapse across them must leave a survivor that
 * still parses.
 */
export const PHP_MIXED_HTML = `<html><body>
<?php
/** Renders the page header. A boring, collapsible sibling. */
function render_header(): string {
    return '<h1>fixture</h1>';
}
?>
<p>Static filler markup between the php islands, long enough to be worth cutting.</p>
<?php
/** The function this file is really about. */
function render_target(): string {
    return 'target';
}
?>
</body></html>
`;

/**
 * One canonical fixture per structural language: the text, the focus that keeps the
 * target, the signature line and attached doc comment that must survive, and the
 * strongest explanation shape this fixture guarantees.
 */
export interface StructuralFixture {
  /** Snapshot fixture name, e.g. `'functions.java'`. */
  readonly name: string;
  readonly text: string;
  readonly focus: readonly string[];
  /** A line of the focused declaration's signature that must survive verbatim. */
  readonly signature: string;
  /** The attached doc comment (or docstring) that must survive verbatim. */
  readonly doc: string;
  /** The strongest same-kind collapse explanation this fixture guarantees. */
  readonly pureCollapse: RegExp;
}

/**
 * The registry the totality guard (`test/guards/structural-totality.test.ts`) checks
 * against `STRUCTURAL_LANGUAGES`: every language the planner claims must have an
 * entry here — a fixture, a snapshot under this entry's `name`, and a doc-comment
 * case — or the guard goes red. The `Record` keeps it a compile-time property too:
 * claiming a language in the planner without adding its fixture fails `tsc`.
 */
export const FIXTURE_BY_LANGUAGE: Readonly<Record<StructuralLanguage, StructuralFixture>> = {
  typescript: {
    name: 'functions.ts',
    text: FUNCTIONS_TS,
    focus: ['handleRequest'],
    signature: 'export function handleRequest(path: string, raw: string): string {',
    doc: '/** The entry point every request goes through — the one worth keeping. */',
    pureCollapse: /^collapsed \d+ sibling functions$/,
  },
  tsx: {
    name: 'mixed.tsx',
    text: MIXED_TSX,
    focus: ['Toolbar'],
    signature: 'export function Toolbar({ align }: { align: Align }) {',
    doc: '/** The toolbar — the component this file is really about. */',
    // The tsx fixture is the mixed-kind case; its guaranteed collapse names kinds.
    pureCollapse: /^collapsed \d+ sibling declarations \(.+\)$/,
  },
  javascript: {
    name: 'functions.js',
    text: FUNCTIONS_JS,
    focus: ['handleRequest'],
    signature: 'export function handleRequest(path) {',
    doc: JS_DOC_COMMENT,
    pureCollapse: /^collapsed \d+ sibling functions$/,
  },
  rust: {
    name: 'functions.rs',
    text: FUNCTIONS_RS,
    focus: ['resolve_target'],
    signature: 'pub fn resolve_target(name: &str) -> String {',
    // The doc comment, the outer attribute below it, and the signature must survive
    // *as one block* — see the guard for why the three are asserted together.
    doc: `${RUST_DOC_COMMENT}\n${RUST_ATTRIBUTE}\npub fn resolve_target`,
    pureCollapse: /^collapsed \d+ sibling functions$/,
  },
  python: {
    name: 'functions.py',
    text: FUNCTIONS_PY,
    focus: ['fetch_user'],
    signature: 'def fetch_user(user_id):',
    doc: PYTHON_DOCSTRING,
    pureCollapse: /^collapsed \d+ sibling functions$/,
  },
  go: {
    name: 'functions.go',
    text: FUNCTIONS_GO,
    focus: ['HandleRequest'],
    signature: 'func HandleRequest(path string) string {',
    doc: GO_DOC_COMMENT,
    pureCollapse: /^collapsed \d+ sibling functions$/,
  },
  java: {
    name: 'functions.java',
    text: FUNCTIONS_JAVA,
    focus: ['RequestHandler'],
    signature: 'public class RequestHandler {',
    doc: JAVA_DOC_COMMENT,
    pureCollapse: /^collapsed \d+ sibling classes$/,
  },
  c: {
    name: 'functions.c',
    text: FUNCTIONS_C,
    focus: ['handle_request'],
    signature: 'int handle_request(const char *path, char *out) {',
    doc: C_DOC_COMMENT,
    pureCollapse: /^collapsed \d+ sibling functions$/,
  },
  cpp: {
    name: 'functions.cpp',
    text: FUNCTIONS_CPP,
    focus: ['handle_request'],
    signature: 'std::string handle_request(const std::string &path) {',
    doc: CPP_DOC_COMMENT,
    pureCollapse: /^collapsed \d+ sibling functions$/,
  },
  c_sharp: {
    name: 'functions.cs',
    text: FUNCTIONS_CS,
    focus: ['RequestHandler'],
    signature: 'public class RequestHandler',
    doc: CS_DOC_COMMENT,
    pureCollapse: /^collapsed \d+ sibling classes$/,
  },
  ruby: {
    name: 'functions.rb',
    text: FUNCTIONS_RB,
    focus: ['handle_request'],
    signature: 'def handle_request(path)',
    doc: RUBY_DOC_COMMENT,
    pureCollapse: /^collapsed \d+ sibling methods$/,
  },
  php: {
    name: 'functions.php',
    text: FUNCTIONS_PHP,
    focus: ['handle_request'],
    signature: 'function handle_request(string $path): string {',
    doc: PHP_DOC_COMMENT,
    pureCollapse: /^collapsed \d+ sibling functions$/,
  },
  kotlin: {
    name: 'functions.kt',
    text: FUNCTIONS_KT,
    focus: ['handleRequest'],
    signature: 'fun handleRequest(path: String): String = "handled:" + renderResponse(path)',
    doc: KOTLIN_DOC_COMMENT,
    pureCollapse: /^collapsed \d+ sibling functions$/,
  },
  swift: {
    name: 'functions.swift',
    text: FUNCTIONS_SWIFT,
    focus: ['handleRequest'],
    signature: 'func handleRequest(_ path: String) -> String {',
    doc: SWIFT_DOC_COMMENT,
    pureCollapse: /^collapsed \d+ sibling functions$/,
  },
  bash: {
    name: 'functions.sh',
    text: FUNCTIONS_SH,
    focus: ['handle_request'],
    signature: 'handle_request() {',
    doc: BASH_DOC_COMMENT,
    pureCollapse: /^collapsed \d+ sibling functions$/,
  },
};
