// Inline review comments: the review emits a machine-readable section 6 with a
// json array of findings; we parse it, strip it from the human report, and
// anchor each finding to a commentable diff line. These tests lock that
// pipeline so a malformed model output degrades gracefully (no throw, no lost
// findings, no 422-causing anchors).

process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
process.env.GITHUB_TOKEN = 'ghp_test';

const { parseInlineComments, stripInlineCommentsBlock } = require('../src/agents/reviewCopilot');
const { partitionInlineComments, formatDroppedFindings } = require('../src/pipeline');

const REVIEW = `## 1. Bug Risk
Token may be null at \`src/login.js:12\`.

## 5. Verdict
**REQUEST_CHANGES**

Because of the null deref.

## 6. Inline Comments (machine-readable)

\`\`\`json
[
  { "file": "src/login.js", "line": 12, "severity": "blocking", "comment": "token may be null here." },
  { "file": "src/login.js", "line": 99, "severity": "nit", "comment": "line not in diff." }
]
\`\`\`
`;

const DIFF = `diff --git a/src/login.js b/src/login.js
--- a/src/login.js
+++ b/src/login.js
@@ -10,4 +10,5 @@ function login(user) {
   const token = sign(user);
   if (!token) {
+    throw new Error('no token');
   }
   return token;
`;

describe('parseInlineComments', () => {
  test('extracts well-formed findings from section 6', () => {
    const out = parseInlineComments(REVIEW);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ file: 'src/login.js', line: 12, severity: 'blocking', comment: 'token may be null here.' });
  });

  test('returns [] when there is no json block', () => {
    expect(parseInlineComments('## 5. Verdict\n**APPROVE**')).toEqual([]);
  });

  test('returns [] on malformed json instead of throwing', () => {
    const bad = '## 6. Inline Comments\n```json\n[ {not valid json ]\n```';
    expect(parseInlineComments(bad)).toEqual([]);
  });

  test('drops entries missing a file, line, or comment', () => {
    const partial = '## 6. Inline Comments\n```json\n[{"file":"a.js","comment":"no line"},{"file":"b.js","line":3,"comment":"ok"}]\n```';
    const out = parseInlineComments(partial);
    expect(out).toHaveLength(1);
    expect(out[0].file).toBe('b.js');
  });

  test('normalizes unknown severity to nit', () => {
    const s = '## 6. Inline Comments\n```json\n[{"file":"a.js","line":1,"severity":"sev1","comment":"x"}]\n```';
    expect(parseInlineComments(s)[0].severity).toBe('nit');
  });
});

describe('stripInlineCommentsBlock', () => {
  test('removes section 6 from the human report', () => {
    const stripped = stripInlineCommentsBlock(REVIEW);
    expect(stripped).not.toMatch(/```json/);
    expect(stripped).not.toMatch(/Inline Comments/);
    expect(stripped).toMatch(/## 5. Verdict/);   // earlier sections survive
    expect(stripped).toMatch(/REQUEST_CHANGES/);
  });
});

describe('partitionInlineComments', () => {
  test('anchors in-diff findings and drops out-of-diff ones', () => {
    const inline = parseInlineComments(REVIEW);
    const { anchored, dropped } = partitionInlineComments(inline, DIFF);
    expect(anchored).toHaveLength(1);
    expect(anchored[0]).toMatchObject({ path: 'src/login.js', line: 12, side: 'RIGHT' });
    expect(anchored[0].body).toMatch(/blocking/);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].line).toBe(99);
  });
});

describe('formatDroppedFindings', () => {
  test('renders nothing for an empty list', () => {
    expect(formatDroppedFindings([])).toBe('');
  });

  test('lists file:line for each dropped finding', () => {
    const md = formatDroppedFindings([{ file: 'a.js', line: 4, severity: 'nit', comment: 'tidy' }]);
    expect(md).toMatch(/`a\.js:4`/);
    expect(md).toMatch(/tidy/);
  });
});
