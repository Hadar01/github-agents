// Pipeline helpers: pure functions with no Claude/GitHub/git side effects.
// These tests lock in the audit trail and PR body shape so safety-critical
// fields (pre-fix SHA, test gate, verdict, give-up explanation) never
// silently disappear.

process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
process.env.GITHUB_TOKEN = 'ghp_test';

const { buildAuditTrail, buildPrBody } = require('../src/pipeline');

const baseIssue = { number: 42, title: 'fix login', html_url: 'https://github.com/x/y/issues/42' };
const baseUsage = {
  input_tokens: 100,
  output_tokens: 50,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0
};
const approveReview = '## Verdict\n**APPROVE**\nAll looks fine.';
const engineeringOk = {
  history: [
    { turn: 1, kind: 'thought', text: 'Plan' },
    { turn: 1, kind: 'tool', name: 'read_file', input: { path: 'a.js' }, result: { ok: true } },
    { turn: 2, kind: 'tool', name: 'apply_patch', input: { path: 'src/login.js', old_string: 'x', new_string: 'y' }, result: { ok: true } },
    { turn: 2, kind: 'tool', name: 'run_tests', input: { command: 'npm test' }, result: { ok: true, passed: true } }
  ],
  finalSummary: 'Fixed the bug.',
  sawPassingTests: true,
  sawPassingLint: null,
  completedTurns: 3,
  gaveUp: null
};

describe('buildAuditTrail — human-readable sections', () => {
  test('header shows issue URL, branch, pre-fix SHA with revert hint', () => {
    const audit = buildAuditTrail({
      issue: baseIssue, branch: 'fix/issue-42',
      engineering: engineeringOk, review: approveReview, revision: null,
      totalUsage: baseUsage, preFixSha: 'abc1234'
    });
    expect(audit).toMatch(/# Audit trail — issue #42: fix login/);
    expect(audit).toMatch(/https:\/\/github\.com\/x\/y\/issues\/42/);
    expect(audit).toMatch(/`abc1234`/);
    expect(audit).toMatch(/git reset --hard abc1234/);
  });

  test('Outcome section renders FINISHED on a successful run', () => {
    const audit = buildAuditTrail({
      issue: baseIssue, branch: 'fix/issue-42',
      engineering: engineeringOk, review: approveReview, revision: null,
      totalUsage: baseUsage
    });
    expect(audit).toMatch(/## Outcome/);
    expect(audit).toMatch(/✅ \*\*Finished\*\*/);
    expect(audit).toMatch(/Fixed the bug\./);
  });

  test('Outcome section renders GAVE UP with reason and blockers', () => {
    const audit = buildAuditTrail({
      issue: baseIssue, branch: 'fix/issue-42',
      engineering: {
        ...engineeringOk, finalSummary: null,
        gaveUp: {
          reason: 'too_complex',
          explanation: 'Needed changes across 8 files.',
          blockers: ['no CONTRIBUTING.md', 'tests require CUDA']
        }
      },
      review: null, revision: null, totalUsage: baseUsage
    });
    expect(audit).toMatch(/❌ \*\*Gave up\*\* — `too_complex`/);
    expect(audit).toMatch(/Needed changes across 8 files\./);
    expect(audit).toMatch(/- no CONTRIBUTING\.md/);
    expect(audit).toMatch(/- tests require CUDA/);
  });

  test('Safety gates section lists verdict + test/lint status', () => {
    const audit = buildAuditTrail({
      issue: baseIssue, branch: 'fix/issue-42',
      engineering: engineeringOk, review: approveReview, revision: null,
      totalUsage: baseUsage
    });
    expect(audit).toMatch(/## Safety gates/);
    expect(audit).toMatch(/Self-review verdict: \*\*APPROVE\*\*/);
    expect(audit).toMatch(/Tests observed passing: \*\*YES\*\*/);
  });

  test('Files touched section lists edited paths with op types', () => {
    const audit = buildAuditTrail({
      issue: baseIssue, branch: 'fix/issue-42',
      engineering: engineeringOk, review: null, revision: null,
      totalUsage: baseUsage
    });
    expect(audit).toMatch(/## Files touched/);
    expect(audit).toMatch(/`src\/login\.js`/);
    expect(audit).toMatch(/apply_patch/);
  });

  test('Test runs section reports counts', () => {
    const audit = buildAuditTrail({
      issue: baseIssue, branch: 'fix/issue-42',
      engineering: engineeringOk, review: null, revision: null,
      totalUsage: baseUsage
    });
    expect(audit).toMatch(/## Test runs/);
    expect(audit).toMatch(/Total invocations: 1/);
    expect(audit).toMatch(/Passed: 1/);
  });

  test('Timeline section is present and condensed (one line per turn)', () => {
    const audit = buildAuditTrail({
      issue: baseIssue, branch: 'fix/issue-42',
      engineering: engineeringOk, review: null, revision: null,
      totalUsage: baseUsage
    });
    expect(audit).toMatch(/## Timeline \(condensed\)/);
    expect(audit).toMatch(/- \*\*Turn 1\*\*/);
    expect(audit).toMatch(/- \*\*Turn 2\*\*/);
  });

  test('Full transcript is collapsed in a <details> block', () => {
    const audit = buildAuditTrail({
      issue: baseIssue, branch: 'fix/issue-42',
      engineering: engineeringOk, review: null, revision: null,
      totalUsage: baseUsage
    });
    expect(audit).toMatch(/## Full tool transcript/);
    expect(audit).toMatch(/<details><summary>/);
    expect(audit).toMatch(/<\/details>/);
  });

  test('Cost + turn count are on the header', () => {
    const audit = buildAuditTrail({
      issue: baseIssue, branch: 'fix/issue-42',
      engineering: engineeringOk, review: null, revision: null,
      totalUsage: baseUsage
    });
    expect(audit).toMatch(/\*\*Cost:\*\* \$/);
    expect(audit).toMatch(/\*\*Turns used:\*\* 3/);
  });
});

describe('buildPrBody', () => {
  test('references the issue number', () => {
    const body = buildPrBody({
      issue: baseIssue, engineering: engineeringOk, review: approveReview, revision: null
    });
    expect(body).toMatch(/Resolves #42/);
  });

  test('includes the engineering final summary', () => {
    const body = buildPrBody({
      issue: baseIssue, engineering: engineeringOk, review: null, revision: null
    });
    expect(body).toMatch(/Fixed the bug\./);
  });

  test('prefers revision summary over engineering when revision exists', () => {
    const body = buildPrBody({
      issue: baseIssue, engineering: engineeringOk, review: approveReview,
      revision: { finalSummary: 'Revised fix.' }
    });
    expect(body).toMatch(/Revised fix\./);
  });

  test('embeds the self-review report in a collapsible details block', () => {
    const body = buildPrBody({
      issue: baseIssue, engineering: engineeringOk, review: approveReview, revision: null
    });
    expect(body).toMatch(/<details><summary>Click to expand<\/summary>/);
    expect(body).toMatch(/APPROVE/);
  });

  test('honors project PR template when provided', () => {
    const body = buildPrBody({
      issue: baseIssue, engineering: engineeringOk, review: null, revision: null,
      prTemplate: { path: '.github/PULL_REQUEST_TEMPLATE.md', text: '## Changelog\n\n- [ ] added\n\n## Testing' }
    });
    expect(body).toMatch(/## Changelog/);
    expect(body).toMatch(/- \[ \] added/);
    expect(body).toMatch(/## Testing/);
    // Template appears before our generated sections.
    expect(body.indexOf('## Changelog')).toBeLessThan(body.indexOf('Resolves #42'));
  });
});
