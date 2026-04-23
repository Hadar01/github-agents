require('dotenv').config();

const fs = require('fs');
const path = require('path');
const simpleGit = require('simple-git');

const { runReviewCopilot } = require('./agents/reviewCopilot');
const { parseGithubUrl } = require('./utils/githubUrl');
const { sumUsage, computeCost } = require('./utils/cost');
const { MAX_REVIEW_FILE_BYTES, DEFAULT_MAX_USD_PER_RUN } = require('./config');
const {
  runEngineeringWithSelfReview,
  ensureFork,
  commitAndPush,
  openPullRequest,
  detectTestCommand,
  extractVerdict
} = require('./orchestrator');
const {
  banner, step, info, ok, warn, err,
  usageSummary,
  makeAgentEventHandler, makeStageEventHandler
} = require('./cli/output');

const { ANTHROPIC_API_KEY, GITHUB_TOKEN } = process.env;
const REVIEWABLE_EXTENSIONS = /\.(js|ts|tsx|jsx|py|mjs|cjs)$/i;

let _OctokitCtor = null;
async function getOctokit(token) {
  if (!_OctokitCtor) {
    _OctokitCtor = (await import('@octokit/rest')).Octokit;
  }
  return new _OctokitCtor({ auth: token });
}

// --- arg parsing ---
const RAW_ARGS = process.argv.slice(2);
const POSITIONAL = RAW_ARGS.filter(a => !a.startsWith('--'));
const FLAGS = new Set(RAW_ARGS.filter(a => a.startsWith('--') && !a.includes('=')));
function getOpt(name, fallback) {
  const arg = RAW_ARGS.find(a => a.startsWith(`--${name}=`));
  if (!arg) return fallback;
  return arg.split('=').slice(1).join('=');
}
function getOptFloat(name, fallback) {
  const v = getOpt(name, null);
  if (v === null) return fallback;
  const f = parseFloat(v);
  return Number.isFinite(f) ? f : fallback;
}
function getOptInt(name, fallback) {
  const v = getOpt(name, null);
  if (v === null) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function usage() {
  console.log(`
Usage:
  node src/pipeline.js issue  <github-issue-url> [flags]
  node src/pipeline.js review <github-pr-url>
  node src/pipeline.js triage <github-repo-url>   [--label=bug] [--max=5] [flags]

Flags:
  --dry-run             Run engineering + self-review locally; skip commit/push/PR.
  --fork                Push to your fork of the repo; open PR from fork to upstream.
  --web                 Start a live dashboard on http://localhost:3000
  --port=N              Dashboard port (default 3000).
  --max-cost=2.50       Abort the agent loop if cost (USD) exceeds this. Default ${DEFAULT_MAX_USD_PER_RUN}.
  --label=bug           (triage only) Issue label filter.
  --max=5               (triage only) Max issues to process.

Environment (in .env):
  ANTHROPIC_API_KEY     required — Claude API key
  GITHUB_TOKEN          required — GitHub PAT with repo scope
`);
}

// --- shared helpers ---
async function cloneIfMissing(owner, repo, log) {
  const reposDir = path.join(process.cwd(), 'repos');
  const localPath = path.join(reposDir, `${owner}-${repo}`);
  if (fs.existsSync(localPath)) {
    log(info(`Repo already cloned at ${localPath}`));
    return localPath;
  }
  fs.mkdirSync(reposDir, { recursive: true });
  const cleanUrl = `https://github.com/${owner}/${repo}.git`;
  const cloneUrl = GITHUB_TOKEN
    ? `https://x-access-token:${GITHUB_TOKEN}@github.com/${owner}/${repo}.git`
    : cleanUrl;
  log(info(`Cloning ${owner}/${repo} into ${localPath}`));
  await simpleGit().clone(cloneUrl, localPath);
  if (GITHUB_TOKEN) {
    await simpleGit(localPath).remote(['set-url', 'origin', cleanUrl]);
  }
  return localPath;
}

async function checkoutFixBranch(repoPath, issueNumber) {
  const branch = `fix/issue-${issueNumber}`;
  const git = simpleGit(repoPath);
  const branches = await git.branchLocal();
  if (branches.all.includes(branch)) {
    await git.checkout(branch);
  } else {
    await git.checkoutLocalBranch(branch);
  }
  return branch;
}

function buildAuditTrail({ issue, branch, engineering, review, revision, totalUsage }) {
  const cost = computeCost(totalUsage);
  const lines = [];
  lines.push(`# Audit trail — issue #${issue.number}: ${issue.title}`);
  lines.push('');
  lines.push(`Branch: \`${branch}\``);
  lines.push(`Issue URL: ${issue.html_url}`);
  lines.push('');
  lines.push('## Engineering agent — turn-by-turn');
  for (const entry of engineering.history) {
    if (entry.kind === 'thought') {
      lines.push(`\n**[turn ${entry.turn}] thought**\n\n${entry.text}`);
    } else if (entry.kind === 'tool') {
      const status = entry.result.ok ? 'ok' : `error: ${entry.result.error}`;
      lines.push(`\n**[turn ${entry.turn}] ${entry.name}** — ${status}`);
      lines.push(`\n\`\`\`json\n${JSON.stringify(entry.input).slice(0, 300)}\n\`\`\``);
    }
  }
  if (engineering.finalSummary) {
    lines.push('\n### Engineering PR summary\n\n' + engineering.finalSummary);
  }
  if (review) lines.push('\n## Self-review report\n\n' + review);
  if (revision) {
    lines.push('\n## Revision pass — turn-by-turn');
    for (const entry of revision.history) {
      if (entry.kind === 'thought') {
        lines.push(`\n**[turn ${entry.turn}] thought**\n\n${entry.text}`);
      } else if (entry.kind === 'tool') {
        const status = entry.result.ok ? 'ok' : `error: ${entry.result.error}`;
        lines.push(`\n**[turn ${entry.turn}] ${entry.name}** — ${status}`);
        lines.push(`\n\`\`\`json\n${JSON.stringify(entry.input).slice(0, 300)}\n\`\`\``);
      }
    }
    if (revision.finalSummary) {
      lines.push('\n### Revision PR summary\n\n' + revision.finalSummary);
    }
  }
  lines.push('\n---');
  lines.push('## Cost');
  lines.push(`- input tokens: ${totalUsage.input_tokens.toLocaleString()}`);
  lines.push(`- output tokens: ${totalUsage.output_tokens.toLocaleString()}`);
  lines.push(`- cache_read tokens: ${totalUsage.cache_read_input_tokens.toLocaleString()}`);
  lines.push(`- cache_creation tokens: ${totalUsage.cache_creation_input_tokens.toLocaleString()}`);
  lines.push(`- **total cost: $${cost.total_usd.toFixed(4)}**`);
  return lines.join('\n');
}

function buildPrBody({ issue, engineering, review, revision }) {
  const lines = [];
  lines.push(`Resolves #${issue.number}`);
  lines.push('\n## What changed\n');
  lines.push((revision && revision.finalSummary) || engineering.finalSummary);
  if (review) {
    lines.push('\n## Automated self-review\n');
    lines.push('<details><summary>Click to expand</summary>\n');
    lines.push(review);
    lines.push('\n</details>');
  }
  lines.push('\n---\n🤖 Generated by [github-agent](https://github.com/) — autonomous engineering + self-review with Claude.');
  return lines.join('\n');
}

// --- dashboard wiring ---
async function maybeStartDashboard() {
  if (!FLAGS.has('--web')) return null;
  const { createDashboard } = require('./web/server');
  const dashboard = createDashboard();
  const port = getOptInt('port', 3000);
  await dashboard.start(port);
  console.log(ok(`Dashboard live at http://localhost:${port}`));
  return dashboard;
}

// --- core runner (reusable by both `issue` and `triage`) ---
async function runIssue({ url, octokit, dashboard, options, log }) {
  const parsed = parseGithubUrl(url);
  if (!parsed) return { ok: false, url, error: 'invalid URL' };
  const { owner, repo, number } = parsed;

  log(step(`Issue ${owner}/${repo}#${number}`));

  const [{ data: issue }, { data: repoInfo }] = await Promise.all([
    octokit.issues.get({ owner, repo, issue_number: number }),
    octokit.repos.get({ owner, repo })
  ]);
  log(info(`title: ${issue.title}`));
  log(info(`default branch: ${repoInfo.default_branch}`));

  log(step('Cloning + branching'));
  const repoPath = await cloneIfMissing(owner, repo, log);
  const branch = await checkoutFixBranch(repoPath, number);
  log(ok(`branch: ${branch}`));

  const testCommand = detectTestCommand(repoPath);
  log(info(`test command: ${testCommand}`));
  log(info(`cost ceiling: $${options.maxCost.toFixed(2)}`));

  const onAgent = makeAgentEventHandler(log);
  const onStage = makeStageEventHandler(log);
  const onEvent = (e) => {
    if (e.stage) onStage(e); else onAgent(e);
    if (dashboard) dashboard.pushEvent(e);
  };

  const { engineering, review, revision } = await runEngineeringWithSelfReview({
    issue, repoPath, testCommand,
    costLimitUsd: options.maxCost,
    onEvent
  });

  const totalUsage = sumUsage(engineering.usage, revision && revision.usage);
  log('\n' + usageSummary('Token usage (engineering + revision)', totalUsage));

  const audit = buildAuditTrail({ issue, branch, engineering, review, revision, totalUsage });
  const auditPath = path.join(repoPath, 'audit-trail.md');
  fs.writeFileSync(auditPath, audit);
  log(ok(`audit trail: ${auditPath}`));

  if (!engineering.finalSummary) {
    log(err(`Engineering agent did not finish (${engineering.aborted || 'no finish'}). Skipping PR.`));
    return { ok: false, url, error: engineering.aborted || 'no_finish', totalUsage };
  }

  const verdict = review ? extractVerdict(review) : 'NO_REVIEW';
  log(info(`final review verdict: ${verdict}`));

  if (options.dryRun) {
    log(warn('--dry-run: skipping commit/push/PR'));
    return { ok: true, url, verdict, totalUsage, dryRun: true };
  }

  // Determine push target (fork vs upstream)
  let pushOwner = owner;
  let headOwner = owner;
  if (options.fork) {
    log(step('Ensuring fork'));
    const username = await ensureFork(octokit, owner, repo, onEvent);
    pushOwner = username;
    headOwner = username;
    log(ok(`fork: ${username}/${repo}`));
  }

  log(step('Committing + pushing'));
  const commitMsg = `fix: ${issue.title} (#${number})\n\n${(revision && revision.finalSummary) || engineering.finalSummary}`;
  await commitAndPush({ repoPath, branch, message: commitMsg, pushOwner, repo, token: GITHUB_TOKEN });
  log(ok(`pushed ${branch} to ${pushOwner}/${repo}`));

  log(step('Opening pull request'));
  const pr = await openPullRequest({
    octokit, owner, repo, headOwner, branch,
    base: repoInfo.default_branch,
    title: `fix: ${issue.title}`,
    body: buildPrBody({ issue, engineering, review, revision })
  });
  log(ok(`PR opened: ${pr.html_url}`));
  if (dashboard) dashboard.pushEvent({ stage: 'pr_opened', url: pr.html_url });

  return { ok: true, url, prUrl: pr.html_url, verdict, totalUsage };
}

// --- handlers ---
async function handleIssue(url, options, dashboard) {
  const octokit = await getOctokit(GITHUB_TOKEN);
  const result = await runIssue({ url, octokit, dashboard, options, log: console.log });
  if (!result.ok) process.exit(1);
}

async function handleTriage(repoUrl, options, dashboard) {
  const m = repoUrl.match(/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\/|$)/);
  if (!m) { console.error('Invalid repo URL.'); process.exit(1); }
  const [, owner, repo] = m;

  const octokit = await getOctokit(GITHUB_TOKEN);
  console.log(banner());
  console.log(step(`Triage ${owner}/${repo}`));
  console.log(info(`label filter: ${options.label || '(none)'}`));
  console.log(info(`max issues: ${options.max}`));

  const listParams = {
    owner, repo, state: 'open', per_page: Math.max(options.max * 2, 30)
  };
  if (options.label) listParams.labels = options.label;

  const { data: issues } = await octokit.issues.listForRepo(listParams);
  const realIssues = issues.filter(i => !i.pull_request).slice(0, options.max);
  console.log(ok(`found ${realIssues.length} issue(s) to triage`));

  const results = [];
  for (const issue of realIssues) {
    console.log('\n' + '━'.repeat(60));
    try {
      const r = await runIssue({ url: issue.html_url, octokit, dashboard, options, log: console.log });
      results.push(r);
    } catch (e) {
      console.error(err(`Failed on ${issue.html_url}: ${e.message}`));
      results.push({ ok: false, url: issue.html_url, error: e.message });
    }
  }

  console.log('\n' + '━'.repeat(60));
  console.log(step('Triage summary'));
  let totalCost = 0;
  for (const r of results) {
    const status = r.ok ? (r.dryRun ? '[dry]' : '✓') : '✗';
    const tail = r.prUrl ? r.prUrl : (r.error || r.verdict || '');
    console.log(`  ${status} ${r.url}  ${tail}`);
    if (r.totalUsage) totalCost += computeCost(r.totalUsage).total_usd;
  }
  console.log(`\n${ok(`total spend: $${totalCost.toFixed(4)}`)}`);
}

async function fetchPrDiff(octokit, owner, repo, number) {
  const res = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
    owner, repo, pull_number: number,
    headers: { accept: 'application/vnd.github.v3.diff' }
  });
  return res.data;
}

async function fetchChangedFilesContent(octokit, owner, repo, number, headSha) {
  const { data: changed } = await octokit.pulls.listFiles({
    owner, repo, pull_number: number, per_page: 100
  });
  const fileMap = {};
  for (const f of changed) {
    if (f.status === 'removed') continue;
    if (!REVIEWABLE_EXTENSIONS.test(f.filename)) continue;
    if (f.size > MAX_REVIEW_FILE_BYTES) continue;
    try {
      const { data } = await octokit.repos.getContent({
        owner, repo, path: f.filename, ref: headSha
      });
      if (data.content) {
        fileMap[f.filename] = Buffer.from(data.content, 'base64').toString('utf8');
      }
    } catch (e) {
      console.warn(`Could not fetch ${f.filename}: ${e.message}`);
    }
  }
  return fileMap;
}

async function handleReview(url) {
  const parsed = parseGithubUrl(url);
  if (!parsed) { console.error('Invalid PR URL.'); process.exit(1); }
  const { owner, repo, number } = parsed;

  console.log(banner());
  console.log(step(`PR review ${owner}/${repo}#${number}`));

  const octokit = await getOctokit(GITHUB_TOKEN);
  const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: number });
  const diff = await fetchPrDiff(octokit, owner, repo, number);
  const fileMap = await fetchChangedFilesContent(octokit, owner, repo, number, pr.head.sha);
  console.log(info(`Loaded ${Object.keys(fileMap).length} changed file(s)`));

  console.log(step('Running review copilot'));
  const output = await runReviewCopilot({ pr, diff, fileMap });
  fs.writeFileSync('review-report.md', output);
  console.log(ok('review-report.md'));
}

async function main() {
  if (!ANTHROPIC_API_KEY) { console.error('Missing ANTHROPIC_API_KEY in .env'); process.exit(1); }
  if (!GITHUB_TOKEN) { console.error('Missing GITHUB_TOKEN in .env'); process.exit(1); }

  const [cmd, target] = POSITIONAL;
  const options = {
    dryRun: FLAGS.has('--dry-run'),
    fork: FLAGS.has('--fork'),
    maxCost: getOptFloat('max-cost', DEFAULT_MAX_USD_PER_RUN),
    label: getOpt('label', null),
    max: getOptInt('max', 5)
  };

  const dashboard = await maybeStartDashboard();
  if (cmd !== 'review') console.log(banner());

  if (cmd === 'issue'  && target) return handleIssue(target, options, dashboard);
  if (cmd === 'review' && target) return handleReview(target);
  if (cmd === 'triage' && target) return handleTriage(target, options, dashboard);

  usage();
  process.exit(1);
}

main().catch(e => {
  console.error(err('Pipeline failed:'), e);
  process.exit(1);
});
