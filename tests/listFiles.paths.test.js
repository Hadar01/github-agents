// Regression test for the list_files path bug: when an agent calls
// list_files({ dir: 'src' }), returned paths must be usable directly with
// read_file — i.e. prefixed with 'src/...', not relative to the subdir.
const fs = require('fs');
const os = require('os');
const path = require('path');

const { dispatchTool } = require('../src/agents/tools');

describe('list_files path semantics (regression)', () => {
  let tmpDir;
  let ctx;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lfp-'));
    fs.mkdirSync(path.join(tmpDir, 'src', 'auth'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'auth', 'login.js'), 'const login = () => {};');
    fs.writeFileSync(path.join(tmpDir, 'src', 'app.js'), 'const x = 1;');
    ctx = { repoPath: tmpDir };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('list_files with no dir returns repo-root-relative paths', async () => {
    const r = await dispatchTool('list_files', { dir: '' }, ctx);
    expect(r.ok).toBe(true);
    expect(r.files).toContain('src/app.js');
    expect(r.files).toContain('src/auth/login.js');
  });

  test('list_files on a subdir returns paths that read_file can consume directly', async () => {
    const r = await dispatchTool('list_files', { dir: 'src' }, ctx);
    expect(r.ok).toBe(true);
    expect(r.files).toContain('src/app.js');
    expect(r.files).toContain('src/auth/login.js');

    // Critical part of the regression: feed one of the returned paths
    // directly into read_file. Before the fix this would throw ENOENT.
    const read = await dispatchTool('read_file', { path: r.files[0] }, ctx);
    expect(read.ok).toBe(true);
  });

  test('list_files flags truncation when result exceeds the cap', async () => {
    // Create 501 files so the 500-cap kicks in.
    for (let i = 0; i < 501; i++) {
      fs.writeFileSync(path.join(tmpDir, `many-${i}.js`), '');
    }
    const r = await dispatchTool('list_files', { dir: '' }, ctx);
    expect(r.ok).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.total).toBeGreaterThan(r.count);
    expect(r.note).toMatch(/truncated/);
  });

  test('list_files returns an error for a nonexistent dir', async () => {
    const r = await dispatchTool('list_files', { dir: 'does/not/exist' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found/);
  });
});
