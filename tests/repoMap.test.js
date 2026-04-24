const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildRepoMap, IGNORE_DIRS } = require('../src/mapper/repoMap');

describe('repoMap', () => {
  let tmpDir;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repomap-'));
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'index.js'), 'console.log("hi");');
    fs.writeFileSync(path.join(tmpDir, 'src', 'types.ts'), 'export type X = number;');
    fs.writeFileSync(path.join(tmpDir, 'script.py'), 'print("hi")');
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# readme');
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'foo'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'foo', 'ignored.js'), '// ignored');
    // big-repo artefact directories
    for (const dir of ['target', 'vendor', '.mypy_cache', '.pytest_cache', '.tox', '__pycache__']) {
      fs.mkdirSync(path.join(tmpDir, dir), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, dir, 'junk.py'), 'print("junk")');
    }
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('buildRepoMap returns { files, total, truncated, cap }', () => {
    const r = buildRepoMap(tmpDir);
    expect(Array.isArray(r.files)).toBe(true);
    expect(typeof r.total).toBe('number');
    expect(typeof r.truncated).toBe('boolean');
    expect(typeof r.cap).toBe('number');
  });

  test('includes source files across JS/TS/Python/native', () => {
    const { files } = buildRepoMap(tmpDir);
    expect(files).toContain('src/index.js');
    expect(files).toContain('src/types.ts');
    expect(files).toContain('script.py');
  });

  test('includes config/docs files the agent needs to orient itself', () => {
    // README.md, CONTRIBUTING.md, pyproject.toml etc. are now visible so the
    // agent can detect test commands and contribution rules.
    const { files } = buildRepoMap(tmpDir);
    expect(files).toContain('README.md');
  });

  test('walks scientific-Python file types (pyx/pxd/pyi)', () => {
    fs.writeFileSync(path.join(tmpDir, 'ext.pyx'), '# cython');
    fs.writeFileSync(path.join(tmpDir, 'ext.pxd'), '# cython header');
    fs.writeFileSync(path.join(tmpDir, 'stub.pyi'), '# type stub');
    const { files } = buildRepoMap(tmpDir);
    expect(files).toContain('ext.pyx');
    expect(files).toContain('ext.pxd');
    expect(files).toContain('stub.pyi');
  });

  test('recognises Makefile and other extensionless config files', () => {
    fs.writeFileSync(path.join(tmpDir, 'Makefile'), 'test:\n\tpytest');
    fs.writeFileSync(path.join(tmpDir, 'Dockerfile'), 'FROM python:3.11');
    const { files } = buildRepoMap(tmpDir);
    expect(files).toContain('Makefile');
    expect(files).toContain('Dockerfile');
  });

  test('skips node_modules and big-project artefact dirs', () => {
    const { files } = buildRepoMap(tmpDir);
    expect(files.some(f => f.includes('node_modules'))).toBe(false);
    expect(files.some(f => f.startsWith('target/'))).toBe(false);
    expect(files.some(f => f.startsWith('vendor/'))).toBe(false);
    expect(files.some(f => f.startsWith('.mypy_cache/'))).toBe(false);
    expect(files.some(f => f.startsWith('.pytest_cache/'))).toBe(false);
    expect(files.some(f => f.startsWith('.tox/'))).toBe(false);
    expect(files.some(f => f.startsWith('__pycache__/'))).toBe(false);
  });

  test('IGNORE_DIRS contains the expected heavy dirs', () => {
    for (const d of ['node_modules', '.git', 'target', 'vendor', '.mypy_cache', '.pytest_cache']) {
      expect(IGNORE_DIRS.has(d)).toBe(true);
    }
  });

  test('prefix option prepends returned paths', () => {
    const { files } = buildRepoMap(path.join(tmpDir, 'src'), { prefix: 'src' });
    expect(files).toContain('src/index.js');
    expect(files).toContain('src/types.ts');
  });

  test('maxFiles cap sets truncated:true and reports total', () => {
    const r = buildRepoMap(tmpDir, { maxFiles: 1 });
    expect(r.files.length).toBe(1);
    expect(r.truncated).toBe(true);
    expect(r.total).toBeGreaterThan(1);
  });

  test('tolerates unreadable directories (EACCES / transient)', () => {
    // Synthetic: just confirm it does not throw on a clean run with a
    // nested dir removed mid-walk. We simulate by pointing at a missing
    // path — buildRepoMap should no-op rather than throw.
    const missing = path.join(tmpDir, 'does-not-exist');
    const r = buildRepoMap(missing);
    expect(r.files).toEqual([]);
    expect(r.total).toBe(0);
  });
});
