import { describe, expect, it } from 'vitest';

import {
  editTopLevelProperty,
  jsonStyle,
  stripMarkerBlock,
  upsertMarkerBlock,
} from '../src/text/json-edit.ts';

/**
 * The byte-faithful editors, string in, string out. No temp directory: these are the
 * tokeniser's own edge cases, which a harness install only ever reaches through one
 * happy path (a 2-space settings.json with a `hooks` key).
 */

const edit = (text: string, key: string, value: unknown): string =>
  editTopLevelProperty(text, key, value) ?? expect.fail('not a JSON object');

describe('editTopLevelProperty — replace', () => {
  it('replaces one value and leaves every other byte alone', () => {
    const text = '{\n  "a": 1,\n  "hooks": {"old": true},\n  "z": [1, 2]\n}\n';
    expect(edit(text, 'hooks', { fresh: 1 })).toBe(
      '{\n  "a": 1,\n  "hooks": {\n    "fresh": 1\n  },\n  "z": [1, 2]\n}\n',
    );
  });

  it('keeps 4-space indentation: the rendered value is indented like the file', () => {
    const text = '{\n    "a": 1,\n    "hooks": {}\n}\n';
    expect(edit(text, 'hooks', { x: { y: 2 } })).toBe(
      '{\n    "a": 1,\n    "hooks": {\n        "x": {\n            "y": 2\n        }\n    }\n}\n',
    );
  });

  it('keeps tab indentation', () => {
    const text = '{\n\t"hooks": 0\n}\n';
    expect(edit(text, 'hooks', [1])).toBe('{\n\t"hooks": [\n\t\t1\n\t]\n}\n');
  });

  it('keeps CRLF newlines, in the file and in the rendered value', () => {
    const text = '{\r\n  "a": 1,\r\n  "hooks": 0\r\n}\r\n';
    expect(edit(text, 'hooks', { x: 1 })).toBe(
      '{\r\n  "a": 1,\r\n  "hooks": {\r\n    "x": 1\r\n  }\r\n}\r\n',
    );
  });

  it('preserves string escapes, number spellings and key order it did not touch', () => {
    const text = '{"num": 1e3, "s": "a\\u0041\\"}{b", "hooks": 0, "t": true}';
    expect(edit(text, 'hooks', 1)).toBe(
      '{"num": 1e3, "s": "a\\u0041\\"}{b", "hooks": 1, "t": true}',
    );
  });

  it('skips braces and brackets inside strings while finding a value end', () => {
    const text = '{"hooks": {"cmd": "echo }]{["}, "after": "]"}';
    expect(edit(text, 'hooks', null)).toBe('{"hooks": null, "after": "]"}');
  });

  it('walks nested arrays and objects as one value', () => {
    const text = '{"hooks": [{"a": [1, {"b": 2}]}, []], "k": 0}';
    expect(edit(text, 'hooks', 0)).toBe('{"hooks": 0, "k": 0}');
  });

  it('matches the key after unescaping it', () => {
    // `"hooks"` is the key `hooks`, spelled with an escape.
    const text = '{"ho\\u006fks": 1, "b": 2}';
    expect(edit(text, 'hooks', 9)).toBe('{"ho\\u006fks": 9, "b": 2}');
  });

  it('a value whose strings contain newlines is still rendered as one line per element', () => {
    const text = '{\n  "hooks": 0\n}';
    expect(edit(text, 'hooks', { s: 'a\nb' })).toBe('{\n  "hooks": {\n    "s": "a\\nb"\n  }\n}');
  });

  it('leaves leading and trailing bytes outside the object untouched', () => {
    const text = '\n\n  {"hooks": 0}  \n\n';
    expect(edit(text, 'hooks', 1)).toBe('\n\n  {"hooks": 1}  \n\n');
  });
});

describe('editTopLevelProperty — insert', () => {
  it('appends after the last property, in the file style', () => {
    const text = '{\n    "a": 1\n}\n';
    expect(edit(text, 'hooks', { x: 1 })).toBe(
      '{\n    "a": 1,\n    "hooks": {\n        "x": 1\n    }\n}\n',
    );
  });

  it('appends after a last property whose value ends in nested closers', () => {
    const text = '{\n  "a": {"b": [1]}\n}\n';
    expect(edit(text, 'v', 2)).toBe('{\n  "a": {"b": [1]},\n  "v": 2\n}\n');
  });

  it('fills an empty object with two-space style when nothing is indented', () => {
    expect(edit('{}', 'hooks', { x: 1 })).toBe('{\n  "hooks": {\n    "x": 1\n  }\n}');
    expect(edit('{ }\n', 'v', 1)).toBe('{\n  "v": 1\n}\n');
  });

  it('a compact one-line file gains a property on its own line, two-space style', () => {
    expect(edit('{"a":1}', 'v', 2)).toBe('{"a":1,\n  "v": 2}');
  });

  it('renders the key through JSON.stringify, so a key needing escapes is escaped', () => {
    expect(edit('{}', 'a"b', 1)).toBe('{\n  "a\\"b": 1\n}');
  });
});

describe('editTopLevelProperty — remove', () => {
  it('removes the first property through the following comma and whitespace', () => {
    const text = '{\n  "hooks": {"x": 1},\n  "a": 1\n}\n';
    expect(edit(text, 'hooks', undefined)).toBe('{\n  "a": 1\n}\n');
  });

  it('removes a middle property', () => {
    const text = '{"a": 1, "hooks": [1, 2], "z": 3}';
    expect(edit(text, 'hooks', undefined)).toBe('{"a": 1, "z": 3}');
  });

  it('removes the last property with its preceding comma', () => {
    const text = '{\n  "a": 1,\n  "hooks": {}\n}\n';
    expect(edit(text, 'hooks', undefined)).toBe('{\n  "a": 1\n}\n');
  });

  it('removing the only property leaves the braces and the outer whitespace', () => {
    expect(edit('{\n  "hooks": {}\n}\n', 'hooks', undefined)).toBe('{\n}\n');
    expect(edit('{"hooks": 1}', 'hooks', undefined)).toBe('{}');
  });

  it('removing a key that is not there returns the input, byte for byte', () => {
    const text = '{ "a": 1 }';
    expect(edit(text, 'hooks', undefined)).toBe(text);
    expect(edit('{}', 'hooks', undefined)).toBe('{}');
  });
});

describe('editTopLevelProperty — refusals', () => {
  it.each([
    ['an array', '[1, 2]'],
    ['a scalar', '42'],
    ['a string', '"{}"'],
    ['not JSON', 'not json {'],
    ['an unterminated object', '{"a": 1'],
    ['an unterminated string', '{"a": "x'],
    ['a missing colon', '{"a" 1}'],
    ['a non-string key', '{a: 1}'],
    ['empty text', ''],
  ])('returns undefined for %s', (_label, text) => {
    expect(editTopLevelProperty(text, 'hooks', 1)).toBeUndefined();
    expect(editTopLevelProperty(text, 'hooks', undefined)).toBeUndefined();
  });
});

describe('jsonStyle', () => {
  it('reads the first indented key and the newline convention', () => {
    expect(jsonStyle('{\n    "a": 1\n}')).toEqual({ indent: '    ', newline: '\n' });
    expect(jsonStyle('{\r\n\t"a": 1\r\n}')).toEqual({ indent: '\t', newline: '\r\n' });
  });

  it('defaults to two spaces and LF when nothing is indented', () => {
    expect(jsonStyle('{}')).toEqual({ indent: '  ', newline: '\n' });
    expect(jsonStyle('{"a": 1}')).toEqual({ indent: '  ', newline: '\n' });
  });

  it('an explicit style wins over what the text suggests', () => {
    expect(editTopLevelProperty('{}', 'v', [1], { indent: '\t', newline: '\r\n' })).toBe(
      '{\r\n\t"v": [\r\n\t\t1\r\n\t]\r\n}',
    );
  });
});

const START = '<!-- smelt:start -->';
const END = '<!-- smelt:end -->';
const block = `${START}\nour block\n${END}\n`;

describe('upsertMarkerBlock', () => {
  it('an absent or blank file becomes exactly the block', () => {
    expect(upsertMarkerBlock(undefined, block, START, END)).toBe(block);
    expect(upsertMarkerBlock('', block, START, END)).toBe(block);
    expect(upsertMarkerBlock('  \n\n', block, START, END)).toBe(block);
  });

  it('appends after exactly one blank line, whatever the file ended with', () => {
    expect(upsertMarkerBlock('# Mine', block, START, END)).toBe(`# Mine\n\n${block}`);
    expect(upsertMarkerBlock('# Mine\n', block, START, END)).toBe(`# Mine\n\n${block}`);
    expect(upsertMarkerBlock('# Mine\n\n\n\n', block, START, END)).toBe(`# Mine\n\n${block}`);
  });

  it('replaces an existing block in place and does not grow on re-run', () => {
    const stale = `${START}\nold\n${END}\n`;
    const text = `# Mine\n\n${stale}\n## After\n`;
    const once = upsertMarkerBlock(text, block, START, END);
    expect(once).toBe(`# Mine\n\n${block}\n## After\n`);
    expect(upsertMarkerBlock(once, block, START, END)).toBe(once);
  });

  it('absorbs exactly one newline after the end marker', () => {
    const text = `${START}\nold\n${END}\n\n\nmore\n`;
    expect(upsertMarkerBlock(text, block, START, END)).toBe(`${block}\n\nmore\n`);
  });

  it('a start without an end (or an end before its start) is not a block: append', () => {
    expect(upsertMarkerBlock(`x ${START}\n`, block, START, END)).toBe(`x ${START}\n\n${block}`);
    expect(upsertMarkerBlock(`${END}\n${START}\n`, block, START, END)).toBe(
      `${END}\n${START}\n\n${block}`,
    );
  });
});

describe('stripMarkerBlock', () => {
  it('a file without the block comes back unchanged', () => {
    expect(stripMarkerBlock('# Mine\n', START, END)).toBe('# Mine\n');
    expect(stripMarkerBlock(`${END} then ${START}`, START, END)).toBe(`${END} then ${START}`);
  });

  it('a file that is only the block strips to undefined', () => {
    expect(stripMarkerBlock(block, START, END)).toBeUndefined();
    expect(stripMarkerBlock(`\n\n${block}\n\n`, START, END)).toBeUndefined();
  });

  it('collapses the newlines before the block to one and drops the ones after it', () => {
    expect(stripMarkerBlock(`# Mine\n\n\n${block}\n\n## After\n`, START, END)).toBe(
      '# Mine\n## After\n',
    );
  });

  it('is the inverse of upsert on a file that had no block', () => {
    const original = '# Mine\n\nHand-written rules.\n';
    const withBlock = upsertMarkerBlock(original, block, START, END);
    expect(stripMarkerBlock(withBlock, START, END)).toBe(original);
  });
});
