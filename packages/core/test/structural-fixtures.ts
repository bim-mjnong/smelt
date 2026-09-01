/**
 * TypeScript, TSX, Rust, Python and Go sources the structural-planner tests and guards
 * share.
 *
 * They are template literals rather than files on disk so the guards can import them
 * relatively — the `@guard` alias redirects only the library, and test data must not
 * move when the mutation runner points the guards at a broken copy of `src`.
 */

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

/** Rust: two collapsible functions above the target, a struct and an impl below. */
export const FUNCTIONS_RS = `/// Parses a raw config string into pairs. Boring on purpose.
fn parse_config(raw: &str) -> Vec<(String, String)> {
    raw.lines().filter_map(|l| l.split_once('=')).map(|(k, v)| (k.into(), v.into())).collect()
}

/// Collapses duplicate slashes in a path. Also boring.
fn normalise(path: &str) -> String {
    path.split('/').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("/")
}

${RUST_DOC_COMMENT}
pub fn resolve_target(name: &str) -> String {
    format!("target::{}", normalise(name))
}

/// A struct sibling below the target.
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
 * Python: statements, a decorated definition and a class above the target, two plain
 * functions below — so one collapse is the pure `collapsed 2 sibling functions` form
 * and another has mixed kinds to name. The survivor of this fixture must *reparse* as
 * Python; the fixture itself parses with zero ERROR nodes, and the guard asserts the
 * survivor introduces none.
 */
export const FUNCTIONS_PY = `"""Fixture module for the python structural tests."""

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
