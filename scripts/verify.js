#!/usr/bin/env node
// End-to-end live verification of every shipped feature.
// No Anthropic API calls, no GitHub access — just exercises every code path
// against synthetic temp directories so you can see the real behavior.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
  blue: '\x1b[34m', cyan: '\x1b[36m', magenta: '\x1b[35m'
};
let passes = 0, fails = 0;

function section(title) {
  console.log(`\n${C.bold}${C.cyan}━━ ${title} ━━${C.reset}`);
}
function pass(msg) {
  passes++;
  console.log(`${C.green}  ✓${C.reset} ${msg}`);
}
function fail(msg, detail) {
  fails++;
  console.log(`${C.red}  ✗ ${msg}${C.reset}${detail ? `\n    ${detail}` : ''}`);
}
function info(msg) {
  console.log(`${C.dim}    ${msg}${C.reset}`);
}
function check(label, ok, detail) {
  if (ok) pass(label); else fail(label, detail);
}

function mkTmp(prefix = 'verify-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function rm(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ---------------------------------------------------------------------------
async function main() {
  // ──────────────────────────────────────────────────────────────────────
  section('1. Module exports — pipeline can be required without auto-running');
  const pipeline = require('../src/pipeline');
  check('exports.buildAuditTrail is a function', typeof pipeline.buildAuditTrail === 'function');
  check('exports.buildPrBody is a function', typeof pipeline.buildPrBody === 'function');
  check('exports.runIssue is a function', typeof pipeline.runIssue === 'function');

  // ──────────────────────────────────────────────────────────────────────
  section('2. Path traversal — safeJoin blocks escape attempts');
  const { safeJoin, parseTestCommand, parseLintCommand, dispatchTool } = require('../src/agents/tools');
  const tmpRepo = mkTmp('repo-');
  fs.writeFileSync(path.join(tmpRepo, 'inside.txt'), 'ok');
  check('inside-repo path resolves',
    safeJoin(tmpRepo, 'inside.txt') === path.resolve(tmpRepo, 'inside.txt'));
  let threw = false;
  try { safeJoin(tmpRepo, '../../etc/passwd'); } catch { threw = true; }
  check('../../etc/passwd is rejected', threw);
  threw = false;
  try { safeJoin(tmpRepo, '/etc/passwd'); } catch { threw = true; }
  check('/etc/passwd is rejected', threw);

  // ──────────────────────────────────────────────────────────────────────
  section('3. Shell injection — parseTestCommand / parseLintCommand');
  for (const dangerous of ['npm test; rm -rf /', 'npm test && curl evil.sh', 'npm test `whoami`', 'npm test $(id)']) {
    const r = parseTestCommand(dangerous);
    check(`rejects: ${dangerous}`, r.error && /metacharacter/.test(r.error));
  }
  check('accepts: npm run test -- --watchAll=false',
    !parseTestCommand('npm run test -- --watchAll=false').error);
  check('accepts: pytest tests/ -v',
    !parseTestCommand('pytest tests/ -v').error);
  check('accepts: tox',
    !parseTestCommand('tox').error);
  check('accepts: nox',
    !parseTestCommand('nox').error);
  check('accepts: make test',
    !parseTestCommand('make test').error);
  check('lint: ruff check . accepted',
    !parseLintCommand('ruff check .').error);
  check('lint: black --check . accepted',
    !parseLintCommand('black --check .').error);
  check('lint: mypy . accepted',
    !parseLintCommand('mypy .').error);
  check('lint: eslint . accepted',
    !parseLintCommand('eslint .').error);
  check('lint: rm -rf / rejected',
    /allowlist/.test(parseLintCommand('rm -rf /').error || ''));

  // ──────────────────────────────────────────────────────────────────────
  section('4. write_file overwrite safety');
  fs.writeFileSync(path.join(tmpRepo, 'existing.js'), 'old');
  let r = await dispatchTool('write_file',
    { path: 'existing.js', content: 'NEW' },
    { repoPath: tmpRepo });
  check('refuses to overwrite without overwrite:true', !r.ok && /already exists/.test(r.error));
  r = await dispatchTool('write_file',
    { path: 'existing.js', content: 'NEW', overwrite: true },
    { repoPath: tmpRepo });
  check('overwrites when overwrite:true is passed', r.ok && r.overwrote === true);
  r = await dispatchTool('write_file',
    { path: 'newfile.js', content: 'hi' },
    { repoPath: tmpRepo });
  check('creates new files without overwrite flag', r.ok && r.overwrote === false);

  // ──────────────────────────────────────────────────────────────────────
  section('5. apply_patch fallback strategies');
  // Exact match
  fs.writeFileSync(path.join(tmpRepo, 'p1.js'), 'const x = 1;\n');
  r = await dispatchTool('apply_patch',
    { path: 'p1.js', old_string: 'const x = 1;', new_string: 'const x = 42;' },
    { repoPath: tmpRepo });
  check('exact match patches', r.ok && /exact match/.test(r.message));

  // Whitespace-normalized: file uses tabs, agent sends spaces
  fs.writeFileSync(path.join(tmpRepo, 'p2.py'), 'def foo():\n\treturn\t\t1\n');
  r = await dispatchTool('apply_patch',
    { path: 'p2.py', old_string: 'def foo():\n    return  1', new_string: 'def foo():\n    return 2' },
    { repoPath: tmpRepo });
  check('whitespace-normalized fallback succeeds on tabs-vs-spaces drift',
    r.ok && /whitespace-normalized/.test(r.message));
  info(`patched file now: ${JSON.stringify(fs.readFileSync(path.join(tmpRepo, 'p2.py'), 'utf8'))}`);

  // Closest-line hint on miss
  fs.writeFileSync(path.join(tmpRepo, 'p3.js'),
    'const a = 1;\nconst actually_relevant_thing = 3;\nconst b = 2;\n');
  r = await dispatchTool('apply_patch',
    { path: 'p3.js', old_string: 'const totally_not_there = 3;', new_string: 'X' },
    { repoPath: tmpRepo });
  check('miss returns descriptive error', !r.ok && /not found/.test(r.error));

  // ──────────────────────────────────────────────────────────────────────
  section('6. apply_patch_range — line-based edits');
  fs.writeFileSync(path.join(tmpRepo, 'lines.txt'), 'A\nB\nC\nD\n');
  r = await dispatchTool('apply_patch_range',
    { path: 'lines.txt', start_line: 2, end_line: 3, new_content: 'X\nY\nZ' },
    { repoPath: tmpRepo });
  const after = fs.readFileSync(path.join(tmpRepo, 'lines.txt'), 'utf8');
  check('replaces lines 2..3 correctly', r.ok && after === 'A\nX\nY\nZ\nD\n');
  info(`file now: ${JSON.stringify(after)}`);
  r = await dispatchTool('apply_patch_range',
    { path: 'lines.txt', start_line: 1, end_line: 99, new_content: 'X' },
    { repoPath: tmpRepo });
  check('rejects out-of-range line numbers', !r.ok && /Invalid range/.test(r.error));

  // ──────────────────────────────────────────────────────────────────────
  section('7. give_up tool — graceful escape hatch');
  r = await dispatchTool('give_up', {
    reason: 'too_complex',
    explanation: 'Would need changes across 8 files including a C extension.',
    blockers: ['no test environment', 'unfamiliar Cython internals']
  }, { repoPath: tmpRepo });
  check('returns gave_up:true with structured reason',
    r.ok && r.gave_up === true && r.reason === 'too_complex');
  check('preserves explanation', r.explanation.includes('8 files'));
  check('preserves blockers list', Array.isArray(r.blockers) && r.blockers.length === 2);
  info(`reason: ${r.reason} · blockers: ${r.blockers.length}`);

  // ──────────────────────────────────────────────────────────────────────
  section('8. find_relevant_files — keyword scorer');
  const ranked = await dispatchTool('find_relevant_files',
    { query: 'login email uppercase bug', top_k: 5 },
    { repoPath: tmpRepo });
  // tmpRepo doesn't have login files, so ranked will be empty — that's fine
  check('returns ok with candidates array', ranked.ok && Array.isArray(ranked.candidates));

  // Now with a more realistic repo
  const relRepo = mkTmp('rel-');
  fs.mkdirSync(path.join(relRepo, 'src', 'auth'), { recursive: true });
  fs.writeFileSync(path.join(relRepo, 'src', 'auth', 'login.py'),
    'def login(email, password):\n    return email.lower()\n');
  fs.writeFileSync(path.join(relRepo, 'src', 'app.py'),
    'from .auth.login import login\n');
  fs.writeFileSync(path.join(relRepo, 'src', 'unrelated.py'),
    'def compute_fft():\n    pass\n');
  const ranked2 = await dispatchTool('find_relevant_files',
    { query: 'Login fails when email is uppercase', top_k: 3 },
    { repoPath: relRepo });
  check('ranks login.py first for an issue about login + email',
    ranked2.ok && ranked2.candidates[0] &&
    ranked2.candidates[0].path === 'src/auth/login.py');
  info(`top-3: ${ranked2.candidates.map(c => `${c.path}(${c.score})`).join(', ')}`);
  rm(relRepo);

  // ──────────────────────────────────────────────────────────────────────
  section('9. Big-project file walker — extensions, ignore-dirs, truncation');
  const { buildRepoMap } = require('../src/mapper/repoMap');
  const bigRepo = mkTmp('big-');
  fs.mkdirSync(path.join(bigRepo, 'src'), { recursive: true });
  for (const ext of ['py', 'pyx', 'pxd', 'pyi', 'rs', 'go', 'java', 'toml', 'md', 'rst']) {
    fs.writeFileSync(path.join(bigRepo, 'src', `f.${ext}`), '// stub');
  }
  fs.writeFileSync(path.join(bigRepo, 'Makefile'), 'test:\n\tpytest\n');
  fs.writeFileSync(path.join(bigRepo, 'tox.ini'), '[tox]');
  // big-project artefact dirs that must be ignored
  for (const ignored of ['node_modules', 'target', 'vendor', '.mypy_cache', '.pytest_cache', '.tox', '_build', 'site']) {
    fs.mkdirSync(path.join(bigRepo, ignored));
    fs.writeFileSync(path.join(bigRepo, ignored, 'junk.py'), 'noise');
  }
  const walked = buildRepoMap(bigRepo);
  check('walks .pyx', walked.files.includes('src/f.pyx'));
  check('walks .pxd', walked.files.includes('src/f.pxd'));
  check('walks .pyi', walked.files.includes('src/f.pyi'));
  check('walks .rs', walked.files.includes('src/f.rs'));
  check('walks .toml/.md/.rst (config + docs)',
    walked.files.includes('src/f.toml') &&
    walked.files.includes('src/f.md') &&
    walked.files.includes('src/f.rst'));
  check('recognises Makefile', walked.files.includes('Makefile'));
  check('recognises tox.ini', walked.files.includes('tox.ini'));
  check('skips node_modules/target/vendor/.mypy_cache/.pytest_cache/.tox/_build/site',
    !walked.files.some(f => /node_modules|target|vendor|mypy_cache|pytest_cache|\.tox|_build|site/.test(f)));
  info(`walked ${walked.total} files; truncated=${walked.truncated}`);

  // truncation
  for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(bigRepo, `extra-${i}.py`), '');
  const small = buildRepoMap(bigRepo, { maxFiles: 5 });
  check('truncated:true with cap',
    small.truncated && small.cap === 5 && small.files.length === 5);
  info(`returned ${small.files.length} of ${small.total} (truncated=${small.truncated})`);
  rm(bigRepo);

  // ──────────────────────────────────────────────────────────────────────
  section('10. Test command detection — Makefile/tox/nox/npm/pytest/etc.');
  const {
    detectTestCommand, detectLintCommands,
    detectSubPackages, guessSubPackageForIssue,
    readContributionGuidelines,
    extractVerdict
  } = require('../src/orchestrator');

  const cases = [
    { setup: { 'Makefile': 'test:\n\tpytest\n' }, expect: 'make test' },
    { setup: { 'tox.ini': '[tox]', 'pyproject.toml': '[tool.pytest]' }, expect: 'tox' },
    { setup: { 'noxfile.py': 'import nox', 'pyproject.toml': '[tool.pytest]' }, expect: 'nox' },
    { setup: { 'package.json': '{"scripts":{"test":"jest"}}' }, expect: 'npm test' },
    { setup: { 'pyproject.toml': '[tool.pytest]' }, expect: 'pytest' },
    { setup: { 'go.mod': 'module x' }, expect: 'go test ./...' },
    { setup: { 'Cargo.toml': '[package]' }, expect: 'cargo test' },
    { setup: {}, expect: 'npm test' /* fallback */ },
  ];
  for (const c of cases) {
    const t = mkTmp('det-');
    for (const [name, content] of Object.entries(c.setup)) {
      fs.writeFileSync(path.join(t, name), content);
    }
    const got = detectTestCommand(t);
    check(`${JSON.stringify(c.setup)} → ${c.expect}`, got === c.expect, `got: ${got}`);
    rm(t);
  }

  // ──────────────────────────────────────────────────────────────────────
  section('11. Lint command detection — ruff/black/mypy/eslint');
  const lintCases = [
    { setup: { 'pyproject.toml': '[tool.ruff]\n[tool.black]\n[tool.mypy]\n' },
      expects: ['ruff check .', 'black --check .', 'mypy .'] },
    { setup: { '.eslintrc.json': '{}', '.prettierrc': '{}' },
      expects: ['eslint .', 'prettier --check .'] },
    { setup: {}, expects: [] }
  ];
  for (const c of lintCases) {
    const t = mkTmp('lint-');
    for (const [name, content] of Object.entries(c.setup)) {
      fs.writeFileSync(path.join(t, name), content);
    }
    const got = detectLintCommands(t);
    const allFound = c.expects.every(e => got.includes(e));
    check(`${JSON.stringify(c.setup)} → ${JSON.stringify(c.expects)}`,
      got.length === c.expects.length && allFound, `got: ${JSON.stringify(got)}`);
    rm(t);
  }

  // ──────────────────────────────────────────────────────────────────────
  section('12. Monorepo subpackage detection (Qiskit-style)');
  const mono = mkTmp('mono-');
  for (const sub of ['qiskit-terra', 'qiskit-aer', 'qiskit-ibmq']) {
    fs.mkdirSync(path.join(mono, sub));
    fs.writeFileSync(path.join(mono, sub, 'pyproject.toml'), '[project]');
  }
  const subs = detectSubPackages(mono);
  check('detects all 3 subpackages', subs.length === 3);
  check('classified as python', subs.every(s => s.kind === 'python'));
  info(`subs: ${subs.map(s => s.name).join(', ')}`);
  const guess = guessSubPackageForIssue(subs, 'Transpiler in terra breaks empty circuits');
  check('guesses qiskit-terra for a terra-flavored issue',
    guess && guess.name === 'qiskit-terra');
  info(`guessed: ${guess && guess.name}`);
  const noGuess = guessSubPackageForIssue(subs, 'completely unrelated text');
  check('returns null when nothing matches', noGuess === null);
  rm(mono);

  // ──────────────────────────────────────────────────────────────────────
  section('13. CONTRIBUTING.md / PR template / DCO detection');
  const contribRepo = mkTmp('cg-');
  fs.writeFileSync(path.join(contribRepo, 'CONTRIBUTING.md'),
    'All contributions must be Signed-off-by per the Developer Certificate of Origin.');
  fs.mkdirSync(path.join(contribRepo, '.github'));
  fs.writeFileSync(path.join(contribRepo, '.github', 'PULL_REQUEST_TEMPLATE.md'),
    '## Checklist\n- [ ] Tests added\n- [ ] Docs updated');
  const cg = readContributionGuidelines(contribRepo);
  check('reads CONTRIBUTING.md', cg.contributing && cg.contributing.path === 'CONTRIBUTING.md');
  check('reads PR template', cg.prTemplate && /Checklist/.test(cg.prTemplate.text));
  check('detects DCO from CONTRIBUTING text', cg.requiresDco === true);
  rm(contribRepo);

  // DCO from .github/dco.yml
  const dcoRepo = mkTmp('dco-');
  fs.mkdirSync(path.join(dcoRepo, '.github'));
  fs.writeFileSync(path.join(dcoRepo, '.github', 'dco.yml'), 'require: true');
  check('detects DCO from .github/dco.yml',
    readContributionGuidelines(dcoRepo).requiresDco === true);
  rm(dcoRepo);

  // ──────────────────────────────────────────────────────────────────────
  section('14. Verdict extraction');
  check('APPROVE → APPROVE', extractVerdict('## Verdict\n**APPROVE**\n') === 'APPROVE');
  check('REQUEST_CHANGES → REQUEST_CHANGES',
    extractVerdict('Final: REQUEST_CHANGES — see notes.') === 'REQUEST_CHANGES');
  check('NEEDS_DISCUSSION → NEEDS_DISCUSSION',
    extractVerdict('verdict: NEEDS_DISCUSSION') === 'NEEDS_DISCUSSION');
  check('unparseable → UNKNOWN', extractVerdict('idk lol') === 'UNKNOWN');

  // ──────────────────────────────────────────────────────────────────────
  section('15. Cost math — input/output/cache_read/cache_creation');
  const { computeCost } = require('../src/utils/cost');
  const { COST_INPUT_PER_MTOK, COST_OUTPUT_PER_MTOK,
          COST_CACHE_READ_PER_MTOK, COST_CACHE_CREATION_PER_MTOK } = require('../src/config');
  info(`config: $${COST_INPUT_PER_MTOK}/in $${COST_OUTPUT_PER_MTOK}/out $${COST_CACHE_READ_PER_MTOK}/cache-read $${COST_CACHE_CREATION_PER_MTOK}/cache-create`);
  const cost = computeCost({
    input_tokens: 1_000_000, output_tokens: 1_000_000,
    cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000
  });
  const expected = COST_INPUT_PER_MTOK + COST_OUTPUT_PER_MTOK + COST_CACHE_READ_PER_MTOK + COST_CACHE_CREATION_PER_MTOK;
  check(`computeCost includes cache_creation (${cost.total_usd.toFixed(4)} == ${expected.toFixed(4)})`,
    Math.abs(cost.total_usd - expected) < 0.001);

  // ──────────────────────────────────────────────────────────────────────
  section('16. Audit trail — human-readable rendering');
  const { buildAuditTrail, buildPrBody } = pipeline;
  const fakeIssue = { number: 42, title: 'fix login', html_url: 'https://github.com/x/y/issues/42' };
  const fakeUsage = {
    input_tokens: 100, output_tokens: 50,
    cache_read_input_tokens: 0, cache_creation_input_tokens: 0
  };
  const fakeEng = {
    history: [
      { turn: 1, kind: 'thought', text: 'Looking at auth module' },
      { turn: 1, kind: 'tool', name: 'read_file', input: { path: 'src/auth/login.js' }, result: { ok: true } },
      { turn: 2, kind: 'tool', name: 'apply_patch', input: { path: 'src/auth/login.js' }, result: { ok: true } },
      { turn: 3, kind: 'tool', name: 'run_tests', input: { command: 'npm test' }, result: { ok: true, passed: true, attempts: 1 } },
      { turn: 4, kind: 'tool', name: 'run_lint', input: { command: 'eslint .' }, result: { ok: true, passed: true } }
    ],
    finalSummary: 'Lowercased email before lookup.',
    sawPassingTests: true, sawPassingLint: true,
    completedTurns: 5, gaveUp: null
  };
  const audit = buildAuditTrail({
    issue: fakeIssue, branch: 'fix/issue-42',
    engineering: fakeEng, review: '## Verdict\n**APPROVE**\n',
    revision: null, totalUsage: fakeUsage, preFixSha: 'abc1234'
  });
  check('audit has Outcome section with FINISHED', /## Outcome\s+\n+✅ \*\*Finished\*\*/.test(audit));
  check('audit has Safety gates section', /## Safety gates/.test(audit));
  check('audit lists Tests observed passing: YES', /Tests observed passing: \*\*YES\*\*/.test(audit));
  check('audit lists Lint observed passing: YES', /Lint observed passing: \*\*YES\*\*/.test(audit));
  check('audit has Files touched section', /## Files touched/.test(audit) && /src\/auth\/login\.js/.test(audit));
  check('audit has Test runs section with counts', /## Test runs/.test(audit) && /Total invocations: 1/.test(audit));
  check('audit has Timeline (condensed)', /## Timeline \(condensed\)/.test(audit));
  check('audit has Full transcript collapsed in <details>', /<details>/.test(audit) && /## Full tool transcript/.test(audit));
  check('audit shows pre-fix SHA + revert command', /abc1234/.test(audit) && /git reset --hard abc1234/.test(audit));

  // GAVE UP variant
  const gaveUpEng = {
    ...fakeEng, finalSummary: null, sawPassingTests: false, sawPassingLint: null,
    gaveUp: { reason: 'too_complex', explanation: 'Would need 8 files changed.', blockers: ['no test env'] }
  };
  const audit2 = buildAuditTrail({
    issue: fakeIssue, branch: 'fix/issue-42',
    engineering: gaveUpEng, review: null, revision: null,
    totalUsage: fakeUsage, preFixSha: 'abc1234'
  });
  check('audit renders ❌ Gave up with reason', /❌ \*\*Gave up\*\* — `too_complex`/.test(audit2));
  check('audit lists blockers when given up', /- no test env/.test(audit2));

  // ──────────────────────────────────────────────────────────────────────
  section('17. PR body — Resolves + summary + review block + template');
  const body = buildPrBody({
    issue: fakeIssue, engineering: fakeEng,
    review: '## Verdict\n**APPROVE**\nLooks good.',
    revision: null
  });
  check('PR body contains "Resolves #42"', /Resolves #42/.test(body));
  check('PR body contains the engineering summary', /Lowercased email/.test(body));
  check('PR body collapses review in <details>', /<details><summary>Click to expand<\/summary>/.test(body));

  const bodyWithTemplate = buildPrBody({
    issue: fakeIssue, engineering: fakeEng,
    review: '## Verdict\n**APPROVE**\n',
    revision: null,
    prTemplate: { path: '.github/PULL_REQUEST_TEMPLATE.md', text: '## Checklist\n- [ ] Tests added' }
  });
  check('PR template appears at top when provided',
    bodyWithTemplate.indexOf('## Checklist') < bodyWithTemplate.indexOf('Resolves #42'));

  // ──────────────────────────────────────────────────────────────────────
  section('18. CLI — usage prints when invoked with no args');
  const { execSync } = require('child_process');
  let helpOut = '';
  try {
    helpOut = execSync('node src/pipeline.js', { encoding: 'utf8' });
  } catch (e) {
    // process.exit(1) when no args — that's intentional, capture stdout
    helpOut = (e.stdout || '') + (e.stderr || '');
  }
  check('usage shows issue/review/triage subcommands',
    /Usage:/.test(helpOut) && /issue/.test(helpOut) && /review/.test(helpOut) && /triage/.test(helpOut));
  check('usage lists --fork / --comment / --post / --force-pr / --web / --max-cost',
    /--fork/.test(helpOut) && /--comment/.test(helpOut) && /--post/.test(helpOut) &&
    /--force-pr/.test(helpOut) && /--web/.test(helpOut) && /--max-cost/.test(helpOut));

  // ──────────────────────────────────────────────────────────────────────
  section('19. Web dashboard — server starts + serves /events');
  const { createDashboard } = require('../src/web/server');
  const dash = createDashboard();
  const server = await dash.start(0); // 0 = random free port
  const port = server.address().port;
  info(`dashboard listening on port ${port}`);
  // Push an event before connecting — buffer should replay it.
  dash.pushEvent({ stage: 'verify_test', message: 'hello from verify.js' });
  // Hit /events with a quick HTTP request and check the SSE format.
  const http = require('http');
  await new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/events`, (res) => {
      check('GET /events returns 200', res.statusCode === 200);
      check('Content-Type is text/event-stream',
        /text\/event-stream/.test(res.headers['content-type'] || ''));
      let received = '';
      res.on('data', (chunk) => {
        received += chunk.toString('utf8');
        if (received.includes('verify_test')) {
          check('SSE replays buffered events to new subscriber', true);
          req.destroy();
          resolve();
        }
      });
      setTimeout(() => {
        if (!received.includes('verify_test')) {
          check('SSE replays buffered events to new subscriber', false, 'no event received in 1s');
        }
        req.destroy();
        resolve();
      }, 1000);
    });
    req.on('error', () => {
      check('SSE connection succeeds', false);
      resolve();
    });
  });
  server.close();

  // ──────────────────────────────────────────────────────────────────────
  rm(tmpRepo);

  console.log(`\n${C.bold}━━ Summary ━━${C.reset}`);
  console.log(`${C.green}  passed: ${passes}${C.reset}`);
  console.log(`  failed: ${fails === 0 ? C.green : C.red}${fails}${C.reset}`);
  if (fails > 0) process.exit(1);
}

main().catch(e => {
  console.error(`${C.red}verify.js crashed:${C.reset}`, e);
  process.exit(2);
});
