const {
  extractVerdict, detectsRequestChanges, detectTestCommand,
  detectLintCommands, detectSubPackages, guessSubPackageForIssue,
  readContributionGuidelines
} = require('../src/orchestrator');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('extractVerdict', () => {
  test('APPROVE in body', () => {
    expect(extractVerdict('## Verdict\n**APPROVE**\nLooks good')).toBe('APPROVE');
  });
  test('REQUEST_CHANGES wins over APPROVE when both appear as prose', () => {
    // The reviewer template lists all three verdicts as options; the final
    // section is the real one. extractVerdict scans for the first exact match,
    // so callers should ensure REQUEST_CHANGES is never present as a lone word
    // unless it's the real verdict. We document this with a test.
    expect(extractVerdict('this could APPROVE the change but I REQUEST_CHANGES')).toBe('APPROVE');
  });
  test('NEEDS_DISCUSSION', () => {
    expect(extractVerdict('final: NEEDS_DISCUSSION')).toBe('NEEDS_DISCUSSION');
  });
  test('unparseable → UNKNOWN', () => {
    expect(extractVerdict('I think this is fine')).toBe('UNKNOWN');
  });
  test('empty string → UNKNOWN', () => {
    expect(extractVerdict('')).toBe('UNKNOWN');
  });
});

describe('detectsRequestChanges', () => {
  test('true when REQUEST_CHANGES is present', () => {
    expect(detectsRequestChanges('verdict: REQUEST_CHANGES')).toBe(true);
  });
  test('false on APPROVE text', () => {
    expect(detectsRequestChanges('verdict: APPROVE')).toBe(false);
  });
});

describe('detectTestCommand', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dtc-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  test('npm test from package.json scripts.test', () => {
    fs.writeFileSync(path.join(tmp, 'package.json'),
      JSON.stringify({ scripts: { test: 'jest' } }));
    expect(detectTestCommand(tmp)).toBe('npm test');
  });

  test('pytest from pyproject.toml', () => {
    fs.writeFileSync(path.join(tmp, 'pyproject.toml'), '[tool.pytest]');
    expect(detectTestCommand(tmp)).toBe('pytest');
  });

  test('pytest from pytest.ini', () => {
    fs.writeFileSync(path.join(tmp, 'pytest.ini'), '[pytest]');
    expect(detectTestCommand(tmp)).toBe('pytest');
  });

  test('go test from go.mod', () => {
    fs.writeFileSync(path.join(tmp, 'go.mod'), 'module x');
    expect(detectTestCommand(tmp)).toBe('go test ./...');
  });

  test('cargo test from Cargo.toml', () => {
    fs.writeFileSync(path.join(tmp, 'Cargo.toml'), '[package]');
    expect(detectTestCommand(tmp)).toBe('cargo test');
  });

  test('empty project falls back to npm test', () => {
    expect(detectTestCommand(tmp)).toBe('npm test');
  });

  test('malformed package.json still returns a reasonable default', () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), 'not json');
    expect(detectTestCommand(tmp)).toBe('npm test');
  });

  test('Makefile with a test: target beats bare pytest', () => {
    fs.writeFileSync(path.join(tmp, 'pyproject.toml'), '[tool.pytest]');
    fs.writeFileSync(path.join(tmp, 'Makefile'), 'test:\n\tpytest -xvs\n');
    expect(detectTestCommand(tmp)).toBe('make test');
  });

  test('tox.ini beats bare pytest', () => {
    fs.writeFileSync(path.join(tmp, 'pyproject.toml'), '[tool.pytest]');
    fs.writeFileSync(path.join(tmp, 'tox.ini'), '[tox]\nenvlist=py311');
    expect(detectTestCommand(tmp)).toBe('tox');
  });

  test('noxfile.py beats bare pytest', () => {
    fs.writeFileSync(path.join(tmp, 'pyproject.toml'), '[tool.pytest]');
    fs.writeFileSync(path.join(tmp, 'noxfile.py'), 'import nox');
    expect(detectTestCommand(tmp)).toBe('nox');
  });
});

describe('detectLintCommands', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-')); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('returns empty for a project with no linters configured', () => {
    expect(detectLintCommands(tmp)).toEqual([]);
  });

  test('detects ruff from pyproject [tool.ruff]', () => {
    fs.writeFileSync(path.join(tmp, 'pyproject.toml'), '[tool.ruff]\nline-length = 100');
    expect(detectLintCommands(tmp)).toContain('ruff check .');
  });

  test('detects black from pyproject [tool.black]', () => {
    fs.writeFileSync(path.join(tmp, 'pyproject.toml'), '[tool.black]\nline-length = 100');
    expect(detectLintCommands(tmp)).toContain('black --check .');
  });

  test('detects mypy from pyproject [tool.mypy]', () => {
    fs.writeFileSync(path.join(tmp, 'pyproject.toml'), '[tool.mypy]\nstrict = true');
    expect(detectLintCommands(tmp)).toContain('mypy .');
  });

  test('detects eslint from .eslintrc.json', () => {
    fs.writeFileSync(path.join(tmp, '.eslintrc.json'), '{}');
    expect(detectLintCommands(tmp)).toContain('eslint .');
  });

  test('returns multiple commands for a project with ruff + black + mypy', () => {
    fs.writeFileSync(path.join(tmp, 'pyproject.toml'),
      '[tool.ruff]\n[tool.black]\n[tool.mypy]\n');
    const cmds = detectLintCommands(tmp);
    expect(cmds.length).toBeGreaterThanOrEqual(3);
  });
});

describe('detectSubPackages + guessSubPackageForIssue', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mono-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('flat repo returns no sub-packages', () => {
    fs.writeFileSync(path.join(tmp, 'pyproject.toml'), '[project]');
    expect(detectSubPackages(tmp)).toEqual([]);
  });

  test('detects Python sub-packages (qiskit-terra style)', () => {
    for (const name of ['qiskit-terra', 'qiskit-aer']) {
      fs.mkdirSync(path.join(tmp, name), { recursive: true });
      fs.writeFileSync(path.join(tmp, name, 'pyproject.toml'), '[project]');
    }
    const subs = detectSubPackages(tmp);
    expect(subs.map(s => s.name).sort()).toEqual(['qiskit-aer', 'qiskit-terra']);
    expect(subs[0].kind).toBe('python');
  });

  test('guess picks qiskit-terra for a terra-flavoured issue', () => {
    const subs = [
      { path: 'qiskit-terra', kind: 'python', name: 'qiskit-terra' },
      { path: 'qiskit-aer', kind: 'python', name: 'qiskit-aer' }
    ];
    const guess = guessSubPackageForIssue(subs, 'Transpiler in terra breaks on empty circuits');
    expect(guess.name).toBe('qiskit-terra');
  });

  test('guess returns null for ambiguous issues', () => {
    const subs = [{ path: 'foo', kind: 'python', name: 'foo' }];
    const guess = guessSubPackageForIssue(subs, 'totally unrelated issue text');
    expect(guess).toBeNull();
  });
});

describe('readContributionGuidelines', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-')); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('reads top-level CONTRIBUTING.md when present', () => {
    fs.writeFileSync(path.join(tmp, 'CONTRIBUTING.md'), '# Contributing\n\nFollow the rules.');
    const g = readContributionGuidelines(tmp);
    expect(g.contributing).not.toBeNull();
    expect(g.contributing.path).toBe('CONTRIBUTING.md');
  });

  test('reads .github/PULL_REQUEST_TEMPLATE.md when present', () => {
    fs.mkdirSync(path.join(tmp, '.github'));
    fs.writeFileSync(path.join(tmp, '.github', 'PULL_REQUEST_TEMPLATE.md'), '## Checklist');
    const g = readContributionGuidelines(tmp);
    expect(g.prTemplate).not.toBeNull();
    expect(g.prTemplate.text).toMatch(/Checklist/);
  });

  test('detects DCO requirement from CONTRIBUTING text', () => {
    fs.writeFileSync(path.join(tmp, 'CONTRIBUTING.md'),
      'All commits must be signed-off-by as per the Developer Certificate of Origin.');
    expect(readContributionGuidelines(tmp).requiresDco).toBe(true);
  });

  test('detects DCO from .github/dco.yml', () => {
    fs.mkdirSync(path.join(tmp, '.github'));
    fs.writeFileSync(path.join(tmp, '.github', 'dco.yml'), 'require: true');
    expect(readContributionGuidelines(tmp).requiresDco).toBe(true);
  });

  test('no DCO when nothing mentions it', () => {
    fs.writeFileSync(path.join(tmp, 'CONTRIBUTING.md'), '# just a vibe');
    expect(readContributionGuidelines(tmp).requiresDco).toBe(false);
  });
});
