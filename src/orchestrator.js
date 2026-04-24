const fs = require('fs');
const path = require('path');
const simpleGit = require('simple-git');

const { runEngineeringAgent, runRevisionPass } = require('./agents/engineeringAgent');
const { runReviewCopilot } = require('./agents/reviewCopilot');
const { MAX_REVISION_PASSES } = require('./config');

function detectsRequestChanges(reviewText) {
  return /\bREQUEST_CHANGES\b/.test(reviewText);
}

function extractVerdict(reviewText) {
  if (/\bAPPROVE\b/.test(reviewText)) return 'APPROVE';
  if (/\bREQUEST_CHANGES\b/.test(reviewText)) return 'REQUEST_CHANGES';
  if (/\bNEEDS_DISCUSSION\b/.test(reviewText)) return 'NEEDS_DISCUSSION';
  return 'UNKNOWN';
}

async function runEngineeringWithSelfReview({
  issue, repoPath, testCommand, costLimitUsd, onEvent,
  lintCommands, subPackage, contributing, relevantFileHints
}) {
  onEvent({ stage: 'engineering_start' });
  const engineering = await runEngineeringAgent({
    issue, repoPath, testCommand, costLimitUsd, onEvent,
    lintCommands, subPackage, contributing, relevantFileHints
  });

  if (!engineering.finalSummary) {
    onEvent({
      stage: 'engineering_aborted',
      reason: engineering.aborted || 'no_finish',
      gaveUp: engineering.gaveUp || undefined
    });
    return { engineering, review: null, revision: null };
  }

  const diff = await simpleGit(repoPath).diff();
  if (!diff.trim()) {
    onEvent({ stage: 'no_diff' });
    return { engineering, review: null, revision: null };
  }

  onEvent({ stage: 'self_review_start' });
  const review = await runReviewCopilot({
    pr: { title: issue.title, body: engineering.finalSummary },
    diff,
    fileMap: {},
    issueTitle: issue.title,
    issueBody: issue.body || ''
  });
  onEvent({ stage: 'self_review_done', verdict: extractVerdict(review) });

  let revision = null;
  if (detectsRequestChanges(review) && MAX_REVISION_PASSES > 0) {
    onEvent({ stage: 'revision_start' });
    revision = await runRevisionPass({
      issue, repoPath, testCommand, costLimitUsd,
      reviewText: review,
      currentDiff: diff,
      onEvent
    });
    onEvent({ stage: 'revision_done', summary: revision.finalSummary });
  }

  return { engineering, review, revision };
}

async function ensureFork(octokit, upstreamOwner, repo, onEvent = () => {}) {
  const { data: user } = await octokit.users.getAuthenticated();
  const username = user.login;

  try {
    await octokit.repos.get({ owner: username, repo });
    onEvent({ stage: 'fork_exists', user: username });
    return username;
  } catch (e) {
    if (e.status !== 404) throw e;
    onEvent({ stage: 'fork_creating', user: username });
    await octokit.repos.createFork({ owner: upstreamOwner, repo });

    // Fork creation is async on GitHub's side. Poll briefly.
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        await octokit.repos.get({ owner: username, repo });
        onEvent({ stage: 'fork_ready', user: username });
        return username;
      } catch {}
    }
    throw new Error(`Fork ${username}/${repo} did not become ready within 20s`);
  }
}

async function commitAndPush({ repoPath, branch, message, pushOwner, repo, token }) {
  const git = simpleGit(repoPath);
  await git.add('.');
  await git.commit(message);
  const pushUrl = `https://x-access-token:${token}@github.com/${pushOwner}/${repo}.git`;
  await git.push(pushUrl, branch, ['--set-upstream']);
}

async function openPullRequest({ octokit, owner, repo, headOwner, branch, base, title, body }) {
  const head = headOwner === owner ? branch : `${headOwner}:${branch}`;
  const { data: pr } = await octokit.pulls.create({
    owner, repo, head, base, title, body
  });
  return pr;
}

function exists(p) { try { return fs.existsSync(p); } catch { return false; } }
function readIfExists(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Test command detection
//
// Walked in priority order; returns the *most specific* runner the project
// defines, not just "pytest" as a fallback. For scientific-Python repos like
// Qiskit/Cirq/TQEC the actual test entrypoint is usually tox, nox, or a
// Makefile target — not bare pytest.
function detectTestCommand(repoPath) {
  // 1. Makefile with a `test:` target.
  for (const name of ['Makefile', 'makefile', 'GNUmakefile']) {
    const mk = readIfExists(path.join(repoPath, name));
    if (mk && /^\s*test\s*:/m.test(mk)) return 'make test';
  }

  // 2. tox / nox — strong signals when present.
  if (exists(path.join(repoPath, 'tox.ini'))) return 'tox';
  if (exists(path.join(repoPath, 'noxfile.py'))) return 'nox';

  // 3. Node (package.json scripts.test).
  const pkgPath = path.join(repoPath, 'package.json');
  if (exists(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.scripts && pkg.scripts.test) return 'npm test';
    } catch {}
  }

  // 4. Python.
  if (exists(path.join(repoPath, 'pytest.ini')) ||
      exists(path.join(repoPath, 'pyproject.toml')) ||
      exists(path.join(repoPath, 'setup.cfg'))) {
    return 'pytest';
  }

  // 5. Go / Rust.
  if (exists(path.join(repoPath, 'go.mod'))) return 'go test ./...';
  if (exists(path.join(repoPath, 'Cargo.toml'))) return 'cargo test';

  return 'npm test';
}

// ---------------------------------------------------------------------------
// Lint / format / typecheck command detection.
//
// Returns a list — a well-run Python project has several of these gated in
// CI, and getting tests green while failing ruff is a common silent failure.
function detectLintCommands(repoPath) {
  const cmds = [];
  const pyproject = readIfExists(path.join(repoPath, 'pyproject.toml')) || '';
  const setupCfg = readIfExists(path.join(repoPath, 'setup.cfg')) || '';
  const tooling = pyproject + '\n' + setupCfg;

  if (exists(path.join(repoPath, 'ruff.toml')) || /\[tool\.ruff\b/.test(tooling)) cmds.push('ruff check .');
  if (/\[tool\.black\b/.test(tooling) || exists(path.join(repoPath, '.black'))) cmds.push('black --check .');
  if (/\[tool\.mypy\b/.test(tooling) || exists(path.join(repoPath, 'mypy.ini'))) cmds.push('mypy .');
  if (exists(path.join(repoPath, '.flake8')) || /\[flake8\b/.test(tooling)) cmds.push('flake8 .');
  if (exists(path.join(repoPath, '.pylintrc')) || /\[tool\.pylint\b/.test(tooling)) cmds.push('pylint');

  // JS/TS
  if (exists(path.join(repoPath, '.eslintrc')) ||
      exists(path.join(repoPath, '.eslintrc.json')) ||
      exists(path.join(repoPath, '.eslintrc.js')) ||
      exists(path.join(repoPath, 'eslint.config.js'))) {
    cmds.push('eslint .');
  }
  if (exists(path.join(repoPath, '.prettierrc')) ||
      exists(path.join(repoPath, '.prettierrc.json')) ||
      exists(path.join(repoPath, 'prettier.config.js'))) {
    cmds.push('prettier --check .');
  }

  return cmds;
}

// ---------------------------------------------------------------------------
// Monorepo sub-package detection.
//
// Looks for Python/Node/Rust sub-packages one level deep. Returns
// [{ path, kind, name }]. Empty = flat repo.
function detectSubPackages(repoPath) {
  const results = [];
  let entries = [];
  try {
    entries = fs.readdirSync(repoPath, { withFileTypes: true });
  } catch { return results; }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const sub = path.join(repoPath, entry.name);
    if (exists(path.join(sub, 'pyproject.toml')) || exists(path.join(sub, 'setup.py'))) {
      results.push({ path: entry.name, kind: 'python', name: entry.name });
    } else if (exists(path.join(sub, 'package.json'))) {
      results.push({ path: entry.name, kind: 'node', name: entry.name });
    } else if (exists(path.join(sub, 'Cargo.toml'))) {
      results.push({ path: entry.name, kind: 'rust', name: entry.name });
    }
  }
  return results;
}

// Guess which sub-package an issue refers to, by scoring issue text against
// sub-package names.
function guessSubPackageForIssue(subPackages, issueText) {
  if (!subPackages.length || !issueText) return null;
  const text = String(issueText).toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const sub of subPackages) {
    const name = sub.name.toLowerCase();
    // Match on full name and on the last hyphen-segment (qiskit-terra → terra).
    const tail = name.split(/[-_]/).pop();
    let score = 0;
    if (text.includes(name)) score += 5;
    if (tail && tail.length >= 3 && text.includes(tail)) score += 2;
    if (score > bestScore) { bestScore = score; best = sub; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Contribution guidelines: reads CONTRIBUTING + PR template, detects DCO.
function readContributionGuidelines(repoPath) {
  const candidates = [
    'CONTRIBUTING.md', 'CONTRIBUTING.rst', 'CONTRIBUTING',
    path.join('.github', 'CONTRIBUTING.md'),
    path.join('docs', 'CONTRIBUTING.md')
  ];
  let contributing = null;
  for (const c of candidates) {
    const full = path.join(repoPath, c);
    const txt = readIfExists(full);
    if (txt) { contributing = { path: c, text: txt }; break; }
  }

  const prTemplateCandidates = [
    path.join('.github', 'PULL_REQUEST_TEMPLATE.md'),
    path.join('.github', 'pull_request_template.md'),
    path.join('docs', 'pull_request_template.md'),
    'PULL_REQUEST_TEMPLATE.md'
  ];
  let prTemplate = null;
  for (const c of prTemplateCandidates) {
    const full = path.join(repoPath, c);
    const txt = readIfExists(full);
    if (txt) { prTemplate = { path: c, text: txt }; break; }
  }

  // DCO detection: most projects mention "Signed-off-by" or "DCO" in
  // CONTRIBUTING or ship a .github/dco.yml.
  const dcoYml = exists(path.join(repoPath, '.github', 'dco.yml')) ||
                 exists(path.join(repoPath, '.dco.yml'));
  const dcoMentioned = contributing && /signed[- ]off[- ]by|\bDCO\b|Developer Certificate of Origin/i.test(contributing.text);
  const requiresDco = Boolean(dcoYml || dcoMentioned);

  return { contributing, prTemplate, requiresDco };
}

// ---------------------------------------------------------------------------
// Duplicate PR guard: scan open PRs for ones that already resolve the issue.
async function findExistingPrForIssue(octokit, owner, repo, issueNumber) {
  try {
    const { data: prs } = await octokit.pulls.list({
      owner, repo, state: 'open', per_page: 100
    });
    const needleBranch = `fix/issue-${issueNumber}`;
    const needleBody = new RegExp(`(resolves|closes|fixes)\\s+#${issueNumber}\\b`, 'i');
    for (const pr of prs) {
      if (pr.head && pr.head.ref === needleBranch) return pr;
      if (pr.body && needleBody.test(pr.body)) return pr;
      if (pr.title && needleBody.test(pr.title)) return pr;
    }
  } catch {
    // Non-fatal — just skip the dedupe check on API failure.
  }
  return null;
}

module.exports = {
  runEngineeringWithSelfReview,
  ensureFork,
  commitAndPush,
  openPullRequest,
  detectTestCommand,
  detectLintCommands,
  detectSubPackages,
  guessSubPackageForIssue,
  readContributionGuidelines,
  findExistingPrForIssue,
  extractVerdict,
  detectsRequestChanges
};
