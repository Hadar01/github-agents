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

async function runEngineeringWithSelfReview({ issue, repoPath, testCommand, costLimitUsd, onEvent }) {
  onEvent({ stage: 'engineering_start' });
  const engineering = await runEngineeringAgent({
    issue, repoPath, testCommand, costLimitUsd, onEvent
  });

  if (!engineering.finalSummary) {
    onEvent({ stage: 'engineering_aborted', reason: engineering.aborted || 'no_finish' });
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
    fileMap: {}
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

function detectTestCommand(repoPath) {
  const pkgPath = path.join(repoPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.scripts && pkg.scripts.test) return 'npm test';
    } catch {}
  }
  if (fs.existsSync(path.join(repoPath, 'pytest.ini')) ||
      fs.existsSync(path.join(repoPath, 'pyproject.toml'))) {
    return 'pytest';
  }
  if (fs.existsSync(path.join(repoPath, 'go.mod'))) return 'go test ./...';
  if (fs.existsSync(path.join(repoPath, 'Cargo.toml'))) return 'cargo test';
  return 'npm test';
}

module.exports = {
  runEngineeringWithSelfReview,
  ensureFork,
  commitAndPush,
  openPullRequest,
  detectTestCommand,
  extractVerdict,
  detectsRequestChanges
};
