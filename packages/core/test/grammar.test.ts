import { describe, expect, it, vi } from 'vitest';

/**
 * GRAMMAR LOADING — the one failure type a broken install is allowed to have.
 *
 * `loadGrammar` already answers a *missing* grammar with `GrammarUnavailableError`. A
 * grammar that is present but not loadable — truncated by a partial copy, corrupted in
 * transit, left over from a mismatched `web-tree-sitter` — used to come out as whatever
 * bare `Error` tree-sitter raised ("need to see wasm magic number"). Both `auto`'s doc
 * comment and `docs/ARCHITECTURE.md` promise a consumer that a grammar which fails to
 * load raises `GrammarUnavailableError`, and for that failure mode the promise was not
 * true: a caller catching by type could not tell a broken install from a bug.
 *
 * `web-tree-sitter` is mocked rather than a real grammar file corrupted, so the test
 * neither writes into `grammars/` nor races another test file that is loading one. The
 * error class is imported through the same fresh module graph as the module under
 * test, because `vi.resetModules()` would otherwise hand the assertion a different
 * `GrammarUnavailableError` identity than the one thrown.
 */
describe('loadGrammar, when the grammar file is present but unloadable', () => {
  it('raises GrammarUnavailableError, naming the language and keeping the cause', async () => {
    vi.resetModules();
    const cause = new RangeError('byte length of Uint32Array should be a multiple of 4');
    vi.doMock('web-tree-sitter', () => ({
      Parser: { init: () => Promise.resolve() },
      Language: {
        load: () => {
          throw cause;
        },
      },
    }));

    const { GrammarUnavailableError } = await import('../src/errors.ts');
    const { loadGrammar } = await import('../src/plan/grammar.ts');
    const attempt = loadGrammar('python');
    await expect(attempt).rejects.toThrow(GrammarUnavailableError);
    await expect(attempt).rejects.toThrow(/grammar for "python"/);
    await expect(attempt).rejects.toThrow(/multiple of 4/);
    await expect(attempt).rejects.toMatchObject({ cause });

    vi.doUnmock('web-tree-sitter');
    vi.resetModules();
  });
});
