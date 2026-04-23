const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildRepoMap, buildContextMap } = require('../src/mapper/repoMap');

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
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('buildRepoMap returns an array of js/ts/py files and skips node_modules', () => {
    const files = buildRepoMap(tmpDir);
    expect(Array.isArray(files)).toBe(true);
    expect(files).toContain('src/index.js');
    expect(files).toContain('src/types.ts');
    expect(files).toContain('script.py');
    expect(files).not.toContain('README.md');
    expect(files.some(f => f.includes('node_modules'))).toBe(false);
  });

  test('buildContextMap returns an object mapping paths to file contents', () => {
    const files = buildRepoMap(tmpDir);
    const map = buildContextMap(tmpDir, files);
    expect(typeof map).toBe('object');
    expect(map).not.toBeNull();
    expect(map['src/index.js']).toBe('console.log("hi");');
    expect(map['script.py']).toBe('print("hi")');
  });
});
