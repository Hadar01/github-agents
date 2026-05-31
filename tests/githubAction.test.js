// GitHub Action integration contract: the `review` subcommand must surface its
// verdict to the Actions runner via GITHUB_OUTPUT (so `outputs.verdict` works)
// and GITHUB_STEP_SUMMARY (so the verdict shows in the job summary). These tests
// lock that wiring in — break it and the Action silently stops reporting.

process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
process.env.GITHUB_TOKEN = 'ghp_test';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { emitGithubActionVerdict } = require('../src/pipeline');

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gh-action-')), 'f');
}

describe('emitGithubActionVerdict', () => {
  const saved = { out: process.env.GITHUB_OUTPUT, sum: process.env.GITHUB_STEP_SUMMARY };
  afterEach(() => {
    if (saved.out === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = saved.out;
    if (saved.sum === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = saved.sum;
  });

  test('writes verdict=<V> to GITHUB_OUTPUT', () => {
    const out = tmpFile();
    process.env.GITHUB_OUTPUT = out;
    delete process.env.GITHUB_STEP_SUMMARY;
    emitGithubActionVerdict('REQUEST_CHANGES', null);
    expect(fs.readFileSync(out, 'utf8')).toMatch(/^verdict=REQUEST_CHANGES$/m);
  });

  test('writes a titled panel + the report body to GITHUB_STEP_SUMMARY', () => {
    const sum = tmpFile();
    const report = tmpFile();
    fs.writeFileSync(report, 'Bug at foo.js:12 — null deref.');
    process.env.GITHUB_STEP_SUMMARY = sum;
    delete process.env.GITHUB_OUTPUT;
    emitGithubActionVerdict('APPROVE', report);
    const written = fs.readFileSync(sum, 'utf8');
    expect(written).toMatch(/## ✅ github-agent review — APPROVE/);
    expect(written).toMatch(/Bug at foo\.js:12 — null deref\./);
  });

  test('is a no-op (no throw) when neither env var is set', () => {
    delete process.env.GITHUB_OUTPUT;
    delete process.env.GITHUB_STEP_SUMMARY;
    expect(() => emitGithubActionVerdict('NEEDS_DISCUSSION', null)).not.toThrow();
  });
});
