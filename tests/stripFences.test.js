const { stripFences } = require('../src/mapper/contextSelector');

describe('stripFences', () => {
  test('passes through plain JSON unchanged', () => {
    expect(stripFences('["a", "b"]')).toBe('["a", "b"]');
  });

  test('strips ```json ... ``` fences', () => {
    const input = '```json\n["a", "b"]\n```';
    expect(stripFences(input)).toBe('["a", "b"]');
  });

  test('strips bare ``` ... ``` fences', () => {
    const input = '```\n["a", "b"]\n```';
    expect(stripFences(input)).toBe('["a", "b"]');
  });

  test('trims surrounding whitespace', () => {
    expect(stripFences('   ["a"]   ')).toBe('["a"]');
  });

  test('handles non-string input via String coercion', () => {
    expect(stripFences(42)).toBe('42');
  });
});
