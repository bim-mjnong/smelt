import { describe, expect, it } from 'vitest';

import { detectLanguage, SUPPORTED_LANGUAGES } from '../src/detect.ts';
import { grammarPath } from '../src/plan/grammar.ts';

describe('detectLanguage', () => {
  it('maps the extensions smelt claims to support', () => {
    expect(detectLanguage('src/index.ts')).toBe('typescript');
    expect(detectLanguage('src/App.tsx')).toBe('tsx');
    expect(detectLanguage('build.mjs')).toBe('javascript');
    expect(detectLanguage('widgets.jsx')).toBe('javascript');
    expect(detectLanguage('src/main.rs')).toBe('rust');
    expect(detectLanguage('tool.py')).toBe('python');
    expect(detectLanguage('cmd/server/main.go')).toBe('go');
    expect(detectLanguage('C:\\repo\\src\\lib.rs')).toBe('rust');
    expect(detectLanguage('src/main/java/App.java')).toBe('java');
    expect(detectLanguage('lib/parse.c')).toBe('c');
    expect(detectLanguage('include/parse.h')).toBe('c');
    expect(detectLanguage('src/engine.cc')).toBe('cpp');
    expect(detectLanguage('src/engine.cpp')).toBe('cpp');
    expect(detectLanguage('include/engine.hpp')).toBe('cpp');
    expect(detectLanguage('Services/Handler.cs')).toBe('c_sharp');
    expect(detectLanguage('app/models/user.rb')).toBe('ruby');
    expect(detectLanguage('public/index.php')).toBe('php');
    expect(detectLanguage('src/Main.kt')).toBe('kotlin');
    expect(detectLanguage('build.gradle.kts')).toBe('kotlin');
    expect(detectLanguage('Sources/App/main.swift')).toBe('swift');
    expect(detectLanguage('scripts/deploy.sh')).toBe('bash');
    expect(detectLanguage('scripts/env.bash')).toBe('bash');
  });

  it("answers 'unknown' rather than guessing", () => {
    expect(detectLanguage(undefined)).toBe('unknown');
    expect(detectLanguage('README')).toBe('unknown');
    expect(detectLanguage('.gitignore')).toBe('unknown');
    expect(detectLanguage('notes.md')).toBe('unknown');
    expect(detectLanguage('server.log')).toBe('unknown');
  });

  it('has a grammar on disk for every language it claims', () => {
    for (const language of SUPPORTED_LANGUAGES) {
      expect(grammarPath(language), language).toMatch(/tree-sitter-[a-z_]+\.wasm$/);
    }
  });
});
