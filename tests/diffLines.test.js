const { parseDiffLines, isCommentable } = require('../src/utils/diffLines');

// A representative two-file unified diff: one modified file with a deletion +
// additions, one brand-new file.
const SAMPLE_DIFF = `diff --git a/src/login.js b/src/login.js
index 1111111..2222222 100644
--- a/src/login.js
+++ b/src/login.js
@@ -10,7 +10,8 @@ function login(user) {
   const token = sign(user);
   if (!token) {
-    return null;
+    throw new Error('no token');
+    // unreachable, but here for the test
   }
   return token;
 }
diff --git a/src/new.js b/src/new.js
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/new.js
@@ -0,0 +1,3 @@
+export function hi() {
+  return 'hi';
+}
`;

describe('parseDiffLines', () => {
  const map = parseDiffLines(SAMPLE_DIFF);

  test('tracks new-side line numbers for added and context lines', () => {
    const lines = map.get('src/login.js');
    expect(lines).toBeDefined();
    // hunk starts at new line 10: ctx 10,11; added 12,13; ctx 14,15,16.
    expect([...lines].sort((a, b) => a - b)).toEqual([10, 11, 12, 13, 14, 15, 16]);
  });

  test('records all lines of a newly added file', () => {
    const lines = map.get('src/new.js');
    expect([...lines].sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  test('deleted lines do not advance or appear on the new side', () => {
    // The old `return null;` (a `-` line) must not show up as a RIGHT anchor,
    // and must not have shifted the added-line numbering.
    const lines = map.get('src/login.js');
    expect(lines.has(12)).toBe(true);  // first added line is 12, not 13
  });

  test('handles empty / non-string input without throwing', () => {
    expect(parseDiffLines('').size).toBe(0);
    expect(parseDiffLines(null).size).toBe(0);
  });
});

describe('isCommentable', () => {
  const map = parseDiffLines(SAMPLE_DIFF);

  test('true for a line inside a hunk', () => {
    expect(isCommentable(map, 'src/login.js', 12)).toBe(true);
  });

  test('false for a line outside any hunk', () => {
    expect(isCommentable(map, 'src/login.js', 99)).toBe(false);
  });

  test('false for a file not in the diff', () => {
    expect(isCommentable(map, 'src/other.js', 1)).toBe(false);
  });
});
