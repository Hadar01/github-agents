const fs = require('fs');
const os = require('os');
const path = require('path');

const { dispatchTool, safeJoin, ALLOWED_TEST_COMMAND_PREFIXES } = require('../src/agents/tools');

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
      expect(ALLOWED_TEST_COMMAND_PREFIXES).toContain('npm test');
      expect(ALLOWED_TEST_COMMAND_PREFIXES).toContain('pytest');
      expect(ALLOWED_TEST_COMMAND_PREFIXES).toContain('go test');
    });
  });

  describe('finish', () => {
    test('returns finished flag and summary', async () => {
      const r = await dispatchTool('finish', { pr_summary: 'Fixed the bug.' }, ctx);
      expect(r.ok).toBe(true);
      expect(r.finished).toBe(true);
      expect(r.pr_summary).toBe('Fixed the bug.');
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
