#!/usr/bin/env node
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const simpleGit = require('simple-git');

const { runReviewCopilot, parseInlineComments, stripInlineCommentsBlock } = require('./agents/reviewCopilot');
const { parseGithubUrl } = require('./utils/githubUrl');
const { parseDiffLines, isCommentable } = require('./utils/diffLines');
const { sumUsage, computeCost } = require('./utils/cost');
const { MAX_REVIEW_FILE_BYTES, DEFAULT_MAX_USD_PER_RUN } = require('./config');
const {
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
  extractVerdict
} = require('./orchestrator');
const { buildRepoMap } = require('./mapper/repoMap');
const { rankFiles } = require('./mapper/fileRelevance');
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

// When running inside GitHub Actions, surface the verdict as a step output
// (consumable by later workflow steps) and as a job-summary panel. No-ops
// locally — both env vars are only set on Actions runners.
function emitGithubActionVerdict(verdict, reportPath) {
  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    try { fs.appendFileSync(out, `verdict=${verdict}\n`); } catch { /* best-effort */ }
  }
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const icon = verdict === 'APPROVE' ? '✅'
               : verdict === 'REQUEST_CHANGES' ? '🛑'
               : verdict === 'NEEDS_DISCUSSION' ? '💬' : '❓';
    let body = `## ${icon} github-agent review — ${verdict}\n\n`;
    try {
      if (reportPath && fs.existsSync(reportPath)) body += fs.readFileSync(reportPath, 'utf8');
    } catch { /* best-effort */ }
    try { fs.appendFileSync(summary, body + '\n'); } catch { /* best-effort */ }
  }
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
                        Use this when you don't have write access to the target.
  --comment             After opening the PR, post a comment on the original issue
                        linking to the PR. Works without repo write access.
  --post                (review only) Post the self-review as a PR review comment.
                        Works on any public PR — no repo write access needed.
  --advisory            (review only) Always exit 0, even on REQUEST_CHANGES /
                        NEEDS_DISCUSSION. Posts findings without failing the run.
                        Used by the GitHub Action's advisory (non-blocking) mode.
  --force-pr            Open the PR even if self-review verdict is REQUEST_CHANGES /
                        NEEDS_DISCUSSION / UNKNOWN, or if tests never passed.
                        Use only when you've inspected the audit trail manually.
  --web                 Start a live dashboard on http://localhost:3000 (localhost only).
  --web-bind-all        Bind the dashboard to 0.0.0.0 instead of 127.0.0.1.
                        Anyone on your LAN can read agent output. Use with care.
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

// Build a simple-git instance whose `git` invocations carry an
// HTTP `Authorization: Basic ...` header at the COMMAND level (`git -c
// http.extraheader=...`). The header is never written to .git/config and
// the token never appears in any URL on disk. Drop-in replacement for the
// old "bake the token into the clone URL, then strip" pattern.
function gitWithToken(baseDir, token) {
  if (!token) return simpleGit(baseDir);
  const auth = Buffer.from(`x-access-token:${token}`).toString('base64');
  return simpleGit({
    baseDir,
    config: [`http.extraheader=AUTHORIZATION: Basic ${auth}`]
  });
}

async function cloneIfMissing(owner, repo, log) {
  const reposDir = path.join(process.cwd(), 'repos');
  const localPath = path.join(reposDir, `${owner}-${repo}`);
  if (fs.existsSync(localPath)) {
    log(info(`Repo already cloned at ${localPath}`));
    return localPath;
  }
  fs.mkdirSync(reposDir, { recursive: true });
  const cleanUrl = `https://github.com/${owner}/${repo}.git`;
  log(info(`Cloning ${owner}/${repo} into ${localPath}`));
  // Auth flows through `-c http.extraheader=...` set by gitWithToken;
  // the URL itself stays clean and nothing token-bearing lands in
  // .git/config or in the remote URL.
  await gitWithToken(undefined, GITHUB_TOKEN).clone(cleanUrl, localPath);
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
  // Ensure a clean working tree — every run starts from a known state,
  // not from whatever the previous run left behind.
  await git.reset(['--hard', 'HEAD']);
  await git.clean('f', ['-d']);
  return branch;
}

// ---- Audit trail rendering --------------------------------------------------
//
// The audit trail is the artefact a human reads when they want to understand
// what the agent did — and, crucially, decide whether to trust the PR. The
// old format dumped every tool call as JSON which was exhaustive but
// unreadable. The new format leads with a human summary, then condenses the
// timeline, and keeps the full trace behind a collapsed `<details>` for the
// cases where someone needs to debug.

function summarizeTool(name, input, result) {
  switch (name) {
    case 'read_file':       return `read \`${input.path}\``;
    case 'list_files':      return `listed \`${input.dir || '/'}\` (${result && result.count} files)`;
    case 'find_relevant_files': return `ranked files for: "${String(input.query || '').slice(0, 60)}"`;
    case 'write_file':      return `wrote \`${input.path}\` (${(input.content || '').length} bytes)`;
    case 'apply_patch':     return `patched \`${input.path}\``;
    case 'apply_patch_range': return `replaced lines ${input.start_line}-${input.end_line} of \`${input.path}\``;
    case 'run_tests':       return `ran tests: \`${input.command}\` → ${result && result.passed ? (result.flaky ? 'PASS (flaky)' : 'PASS') : 'FAIL'}`;
    case 'run_lint':        return `ran lint: \`${input.command}\` → ${result && result.passed ? 'PASS' : 'FAIL'}`;
    case 'git_diff':        return `inspected working diff`;
    case 'git_status':      return `checked git status`;
    case 'finish':          return `signalled finish`;
    case 'give_up':         return `gave up (${input.reason})`;
    default:                return name;
  }
}

function condenseTimeline(history) {
  // Collapse consecutive read_file/list_files from the same turn into one line
  // each; keep edits, test runs, and decisions verbose.
  const byTurn = new Map();
  for (const entry of history) {
    if (!byTurn.has(entry.turn)) byTurn.set(entry.turn, { thoughts: [], tools: [] });
    if (entry.kind === 'thought') byTurn.get(entry.turn).thoughts.push(entry.text);
    else if (entry.kind === 'tool') byTurn.get(entry.turn).tools.push(entry);
  }
  const lines = [];
  for (const [turn, { thoughts, tools }] of byTurn) {
    const oneLineThought = thoughts.join(' ').replace(/\s+/g, ' ').trim();
    const thoughtSnippet = oneLineThought
      ? ` — ${oneLineThought.length > 160 ? oneLineThought.slice(0, 157) + '…' : oneLineThought}`
      : '';
    const toolSummary = tools
      .map(t => {
        const label = summarizeTool(t.name, t.input, t.result);
        if (t.result && t.result.ok === false) return `${label} ✗ (${t.result.error || 'error'})`;
        if (t.name === 'run_tests' && t.result && t.result.flaky) return `${label} ⚠`;
        return label;
      })
      .join('; ');
    lines.push(`- **Turn ${turn}**${thoughtSnippet}${toolSummary ? `\n    - ${toolSummary.replace(/; /g, '\n    - ')}` : ''}`);
  }
  return lines.join('\n');
}

function diffFileStats(history) {
  // Approximate changed-file counts from edit tool calls. Not perfect (the
  // source of truth is `git diff`), but fine for the timeline view.
  const edits = new Map(); // path → { touches: n, kind }
  for (const entry of history) {
    if (entry.kind !== 'tool') continue;
    const p = entry.input && entry.input.path;
    if (!p) continue;
    if (['write_file', 'apply_patch', 'apply_patch_range'].includes(entry.name) &&
        entry.result && entry.result.ok) {
      const e = edits.get(p) || { touches: 0, ops: new Set() };
      e.touches += 1;
      e.ops.add(entry.name);
      edits.set(p, e);
    }
  }
  return edits;
}

function summarizeTestRuns(history) {
  let attempts = 0, passes = 0, flaky = 0, fails = 0, envErrors = 0;
  for (const entry of history) {
    if (entry.kind !== 'tool' || entry.name !== 'run_tests') continue;
    const r = entry.result || {};
    attempts++;
    if (r.passed) passes++;
    if (r.flaky) flaky++;
    if (!r.passed) fails++;
    if (r.env_error) envErrors++;
  }
  return { attempts, passes, flaky, fails, envErrors };
}

function buildAuditTrail({ issue, branch, engineering, review, revision, totalUsage, preFixSha }) {
  const cost = computeCost(totalUsage);
  const verdict = review ? extractVerdict(review) : 'NO_REVIEW';
  const finalSummary = (revision && revision.finalSummary) || engineering.finalSummary;
  const sawTests = engineering.sawPassingTests || (revision && revision.sawPassingTests);
  const sawLint = engineering.sawPassingLint !== null
    ? engineering.sawPassingLint
    : (revision && revision.sawPassingLint);

  const engEdits = diffFileStats(engineering.history);
  const revEdits = revision ? diffFileStats(revision.history) : new Map();
  const allEdits = new Map([...engEdits, ...revEdits]);
  const testStats = summarizeTestRuns([...(engineering.history || []), ...(revision ? revision.history : [])]);

  const lines = [];

  // -------------------- Header --------------------
  lines.push(`# Audit trail — issue #${issue.number}: ${issue.title}`);
  lines.push('');
  lines.push(`**Issue:** ${issue.html_url}`);
  lines.push(`**Branch:** \`${branch}\``);
  if (preFixSha) {
    lines.push(`**Pre-fix HEAD:** \`${preFixSha}\` — revert with \`git reset --hard ${preFixSha}\``);
  }
  lines.push(`**Turns used:** ${engineering.completedTurns}${revision ? ` + ${revision.completedTurns} (revision)` : ''} of ${require('./config').MAX_AGENT_ITERATIONS}`);
  lines.push(`**Cost:** $${cost.total_usd.toFixed(4)} (${totalUsage.input_tokens.toLocaleString()} in, ${totalUsage.output_tokens.toLocaleString()} out, ${totalUsage.cache_read_input_tokens.toLocaleString()} cache-read)`);
  lines.push('');

  // -------------------- Outcome --------------------
  lines.push('## Outcome');
  if (engineering.gaveUp) {
    lines.push('');
    lines.push(`❌ **Gave up** — \`${engineering.gaveUp.reason}\``);
    lines.push('');
    lines.push(engineering.gaveUp.explanation);
    if (engineering.gaveUp.blockers && engineering.gaveUp.blockers.length) {
      lines.push('');
      lines.push('**Blockers:**');
      for (const b of engineering.gaveUp.blockers) lines.push(`- ${b}`);
    }
  } else if (finalSummary) {
    lines.push('');
    lines.push(`✅ **Finished** — ${revision ? 'after revision pass' : 'in single pass'}`);
    lines.push('');
    lines.push(finalSummary);
  } else {
    lines.push('');
    lines.push(`⚠ **Did not finish** — ${engineering.aborted || engineering.stopReason || 'unknown'}`);
  }
  lines.push('');

  // -------------------- Safety gates --------------------
  lines.push('## Safety gates');
  lines.push(`- Self-review verdict: **${verdict}**`);
  lines.push(`- Tests observed passing: **${sawTests ? 'YES' : 'NO'}**`);
  if (sawLint !== null && sawLint !== undefined) {
    lines.push(`- Lint observed passing: **${sawLint ? 'YES' : 'NO'}**`);
  }
  lines.push('');

  // -------------------- Changed files --------------------
  if (allEdits.size) {
    lines.push('## Files touched');
    for (const [p, e] of allEdits) {
      lines.push(`- \`${p}\` — ${e.touches} edit(s) via ${[...e.ops].join(', ')}`);
    }
    lines.push('');
  }

  // -------------------- Tests --------------------
  if (testStats.attempts) {
    lines.push('## Test runs');
    lines.push(`- Total invocations: ${testStats.attempts}`);
    lines.push(`- Passed: ${testStats.passes}${testStats.flaky ? ` (of which flaky: ${testStats.flaky})` : ''}`);
    lines.push(`- Failed: ${testStats.fails}${testStats.envErrors ? ` (including ${testStats.envErrors} environment/import errors)` : ''}`);
    lines.push('');
  }

  // -------------------- Timeline --------------------
  lines.push('## Timeline (condensed)');
  lines.push('');
  lines.push(condenseTimeline(engineering.history));
  if (revision) {
    lines.push('');
    lines.push('### Revision pass');
    lines.push('');
    lines.push(condenseTimeline(revision.history));
  }
  lines.push('');

  // -------------------- Self-review --------------------
  if (review) {
    lines.push('## Self-review report');
    lines.push('');
    lines.push(stripInlineCommentsBlock(review));
    lines.push('');
  }

  // -------------------- Full transcript --------------------
  lines.push('## Full tool transcript');
  lines.push('');
  lines.push('<details><summary>Click to expand — raw tool-call trace for debugging</summary>');
  lines.push('');
  for (const entry of engineering.history) {
    if (entry.kind === 'thought') {
      lines.push(`**[engineering turn ${entry.turn}] thought:** ${entry.text}`);
    } else if (entry.kind === 'tool') {
      const status = entry.result && entry.result.ok ? 'ok' : `error: ${entry.result && entry.result.error}`;
      lines.push(`**[engineering turn ${entry.turn}] ${entry.name}** — ${status}`);
      const inputPreview = JSON.stringify(entry.input || {}).slice(0, 300);
      lines.push(`\`\`\`json\n${inputPreview}\n\`\`\``);
    }
  }
  if (revision) {
    for (const entry of revision.history) {
      if (entry.kind === 'thought') {
        lines.push(`**[revision turn ${entry.turn}] thought:** ${entry.text}`);
      } else if (entry.kind === 'tool') {
        const status = entry.result && entry.result.ok ? 'ok' : `error: ${entry.result && entry.result.error}`;
        lines.push(`**[revision turn ${entry.turn}] ${entry.name}** — ${status}`);
        const inputPreview = JSON.stringify(entry.input || {}).slice(0, 300);
        lines.push(`\`\`\`json\n${inputPreview}\n\`\`\``);
      }
    }
  }
  lines.push('');
  lines.push('</details>');

  return lines.join('\n');
}

function buildPrBody({ issue, engineering, review, revision, prTemplate }) {
  const summary = (revision && revision.finalSummary) || engineering.finalSummary;
  const lines = [];

  // If the project ships a PR template, honor its structure by putting the
  // template text first, then our summary + review below. Keeps the PR from
  // getting rejected on process grounds.
  if (prTemplate && prTemplate.text) {
    lines.push(prTemplate.text.trim());
    lines.push('\n---\n');
  }

  lines.push(`Resolves #${issue.number}`);
  lines.push('\n## What changed\n');
  lines.push(summary);
  if (review) {
    lines.push('\n## Automated self-review\n');
    lines.push('<details><summary>Click to expand</summary>\n');
    // Strip the machine-readable inline-findings block — it's noise in a PR body.
    lines.push(stripInlineCommentsBlock(review));
    lines.push('\n</details>');
  }
  lines.push('\n---\n🤖 Generated by [github-agent](https://github.com/Hadar01/github-agents) — autonomous engineering + self-review with Claude.');
  return lines.join('\n');
}

// Map model-emitted inline findings onto GitHub `createReview` comment objects.
// Findings whose (file, line) is not a commentable diff line are returned in
// `dropped` so the caller can fold them into the review body — never silently
// discard them, and never let a bad anchor 422 the whole review.
function partitionInlineComments(inline, diff) {
  const diffLines = parseDiffLines(diff);
  const anchored = [];
  const dropped = [];
  for (const f of inline) {
    const tag = f.severity === 'blocking' ? '🛑 **blocking**' : '💡 nit';
    if (isCommentable(diffLines, f.file, f.line)) {
      anchored.push({ path: f.file, line: f.line, side: 'RIGHT', body: `${tag} — ${f.comment}` });
    } else {
      dropped.push(f);
    }
  }
  return { anchored, dropped };
}

// Render findings that couldn't be posted inline as a markdown list, appended to
// the review body so they remain visible with their file:line.
function formatDroppedFindings(findings, heading = 'Findings not anchored to a diff line') {
  if (!findings || !findings.length) return '';
  const lines = ['', '---', '', `### ${heading}`, ''];
  for (const f of findings) {
    const sev = f.severity === 'blocking' ? 'blocking' : 'nit';
    lines.push(`- \`${f.file}:${f.line}\` (${sev}) — ${f.comment}`);
  }
  return lines.join('\n');
}

// --- dashboard wiring ---
async function maybeStartDashboard() {
  if (!FLAGS.has('--web')) return null;
  const { createDashboard } = require('./web/server');
  const dashboard = createDashboard();
  const port = getOptInt('port', 3000);
  // Default to 127.0.0.1 — the dashboard streams raw agent output and is not
  // authenticated. --web-bind-all binds 0.0.0.0 with a loud warning.
  const bindAll = FLAGS.has('--web-bind-all');
  const host = bindAll ? '0.0.0.0' : '127.0.0.1';
  await dashboard.start(port, { host });
  if (bindAll) {
    console.log(warn(`Dashboard bound to 0.0.0.0:${port} — reachable from any network interface.`));
    console.log(warn('Anyone on this LAN/VPN can read every agent thought, command output, and stack trace.'));
  } else {
    console.log(ok(`Dashboard live at http://localhost:${port}`));
  }
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

  // Duplicate-PR guard: skip cloning anything if a PR already claims this
  // issue. Cheap remote check, saves a ~30s clone on dense backlogs.
  if (!options.forcePr) {
    const dup = await findExistingPrForIssue(octokit, owner, repo, number);
    if (!dup.ok) {
      log(err(`Duplicate-PR check failed: ${dup.error}`));
      log(warn('Refusing to proceed without a clean dedup check. Re-run with --force-pr to override.'));
      return { ok: false, url, error: 'dedup_check_failed', detail: dup.error };
    }
    if (dup.pr) {
      log(warn(`An open PR already resolves issue #${number}: ${dup.pr.html_url}`));
      log(warn('Skipping. Re-run with --force-pr to process anyway.'));
      return {
        ok: false, url, error: 'duplicate_pr',
        existingPrUrl: dup.pr.html_url
      };
    }
  }

  log(step('Cloning + branching'));
  const repoPath = await cloneIfMissing(owner, repo, log);
  const branch = await checkoutFixBranch(repoPath, number);
  log(ok(`branch: ${branch}`));

  // --- Project context gathering (scientific-Python-class repos) ---
  const testCommand = detectTestCommand(repoPath);
  const lintCommands = detectLintCommands(repoPath);
  const subPackages = detectSubPackages(repoPath);
  const issueText = `${issue.title}\n${issue.body || ''}`;
  const subPackage = guessSubPackageForIssue(subPackages, issueText);
  const contributing = readContributionGuidelines(repoPath);

  log(info(`test command: ${testCommand}`));
  if (lintCommands.length) log(info(`lint commands: ${lintCommands.join(', ')}`));
  if (subPackages.length) {
    log(info(`monorepo sub-packages: ${subPackages.map(s => s.name).join(', ')}`));
    if (subPackage) log(info(`guessed sub-package for issue: ${subPackage.name}`));
  }
  if (contributing.contributing) log(info(`CONTRIBUTING.md found at ${contributing.contributing.path}`));
  if (contributing.requiresDco) log(warn('Project requires DCO Signed-off-by — will auto-sign commits.'));
  log(info(`cost ceiling: $${options.maxCost.toFixed(2)}`));

  // Pre-compute a shortlist of likely-relevant files from the issue text so
  // the agent doesn't burn turns walking the tree on big repos.
  let relevantFileHints = [];
  try {
    const repoMap = buildRepoMap(repoPath, { maxFiles: 5000 });
    relevantFileHints = rankFiles({
      repoPath, files: repoMap.files, issueText, topK: 20
    });
    if (relevantFileHints.length) {
      log(info(`${relevantFileHints.length} file(s) prefiltered as likely relevant`));
    }
  } catch (e) {
    log(warn(`relevance prefilter failed (${e.message}); agent will explore on its own`));
  }

  const preFixSha = (await simpleGit(repoPath).revparse(['HEAD'])).trim();
  log(info(`pre-fix HEAD: ${preFixSha}`));

  const onAgent = makeAgentEventHandler(log);
  const onStage = makeStageEventHandler(log);
  const onEvent = (e) => {
    if (e.stage) onStage(e); else onAgent(e);
    if (dashboard) dashboard.pushEvent(e);
  };

  const { engineering, review, revision } = await runEngineeringWithSelfReview({
    issue, repoPath, testCommand,
    costLimitUsd: options.maxCost,
    onEvent,
    lintCommands, subPackage, contributing: contributing.contributing,
    relevantFileHints
  });

  const totalUsage = sumUsage(engineering.usage, revision && revision.usage);
  log('\n' + usageSummary('Token usage (engineering + revision)', totalUsage));

  const audit = buildAuditTrail({
    issue, branch, engineering, review, revision, totalUsage, preFixSha
  });
  const auditPath = path.join(repoPath, 'audit-trail.md');
  fs.writeFileSync(auditPath, audit);
  log(ok(`audit trail: ${auditPath}`));

  // The agent may have gracefully given up. That's a recognised outcome, not
  // a failure — surface it clearly and optionally drop an explanation comment
  // on the issue so the human who picks it up has context.
  if (engineering.gaveUp) {
    const g = engineering.gaveUp;
    log(warn(`Agent gave up: ${g.reason}`));
    log(info(g.explanation));
    if (g.blockers && g.blockers.length) {
      log(info(`Blockers: ${g.blockers.join('; ')}`));
    }
    if (options.comment) {
      try {
        const body = `🤖 github-agent attempted this issue but could not complete it automatically.\n\n` +
                     `**Reason:** \`${g.reason}\`\n\n${g.explanation}\n\n` +
                     (g.blockers && g.blockers.length
                       ? `**What would unblock progress:**\n${g.blockers.map(b => `- ${b}`).join('\n')}\n\n`
                       : '') +
                     `No PR was opened.`;
        const { data: c } = await octokit.issues.createComment({
          owner, repo, issue_number: number, body
        });
        log(ok(`posted give-up explanation to issue: ${c.html_url}`));
      } catch (e) {
        log(warn(`could not post give-up comment: ${e.message}`));
      }
    }
    return { ok: false, url, error: 'gave_up', gaveUp: g, totalUsage };
  }

  if (!engineering.finalSummary) {
    log(err(`Engineering agent did not finish (${engineering.aborted || 'no finish'}). Skipping PR.`));
    return { ok: false, url, error: engineering.aborted || 'no_finish', totalUsage };
  }

  const verdict = review ? extractVerdict(review) : 'NO_REVIEW';
  log(info(`final review verdict: ${verdict}`));

  // ---- SAFETY GATES ----
  // We do not silently ship diffs that failed their own self-review, were
  // produced without a passing test run, or whose review never completed.
  // Pass --force-pr to override (e.g. for known-false-positive reviews).
  const gateReasons = [];
  if (verdict === 'REQUEST_CHANGES') gateReasons.push('self-review verdict is REQUEST_CHANGES');
  if (verdict === 'UNKNOWN')         gateReasons.push('review verdict could not be parsed');
  if (verdict === 'NO_REVIEW')       gateReasons.push('self-review did not complete');
  if (verdict === 'NEEDS_DISCUSSION') gateReasons.push('self-review flagged NEEDS_DISCUSSION');
  const sawPassingTests = engineering.sawPassingTests ||
                          (revision && revision.sawPassingTests);
  if (!sawPassingTests) gateReasons.push('no successful test run observed during the agent session');

  if (gateReasons.length && !options.forcePr) {
    for (const reason of gateReasons) log(err(`gate: ${reason}`));
    log(warn('Refusing to open a PR. Re-run with --force-pr to override, or inspect audit-trail.md and diff manually.'));
    return { ok: false, url, verdict, totalUsage, error: 'pr_gate_blocked', gateReasons };
  }
  if (gateReasons.length && options.forcePr) {
    for (const reason of gateReasons) log(warn(`--force-pr set; proceeding despite: ${reason}`));
  }

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
  let commitMsg = `fix: ${issue.title} (#${number})\n\n${(revision && revision.finalSummary) || engineering.finalSummary}`;
  if (contributing.requiresDco) {
    // Use the authenticated GitHub user's identity for the sign-off — that's
    // who's taking responsibility for the submission under DCO.
    try {
      const { data: user } = await octokit.users.getAuthenticated();
      const signEmail = user.email || `${user.login}@users.noreply.github.com`;
      const signName = user.name || user.login;
      commitMsg += `\n\nSigned-off-by: ${signName} <${signEmail}>`;
      log(info('added DCO Signed-off-by trailer'));
    } catch (e) {
      log(warn(`could not build DCO trailer: ${e.message}`));
    }
  }
  await commitAndPush({ repoPath, branch, message: commitMsg, pushOwner, repo, token: GITHUB_TOKEN });
  log(ok(`pushed ${branch} to ${pushOwner}/${repo}`));

  log(step('Opening pull request'));
  const pr = await openPullRequest({
    octokit, owner, repo, headOwner, branch,
    base: repoInfo.default_branch,
    title: `fix: ${issue.title}`,
    body: buildPrBody({
      issue, engineering, review, revision,
      prTemplate: contributing.prTemplate
    })
  });
  log(ok(`PR opened: ${pr.html_url}`));
  if (dashboard) dashboard.pushEvent({ stage: 'pr_opened', url: pr.html_url });

  // Optional: drop a comment on the original issue linking to the PR. Works
  // on repos where you don't have write access — GitHub lets any
  // authenticated user comment on public issues.
  if (options.comment) {
    try {
      const { data: c } = await octokit.issues.createComment({
        owner, repo, issue_number: number,
        body: `🤖 I've opened a pull request addressing this issue: ${pr.html_url}\n\n(Generated by [github-agent](https://github.com/Hadar01/github-agents).)`
      });
      log(ok(`commented on issue: ${c.html_url}`));
    } catch (e) {
      log(warn(`could not comment on issue: ${e.message}`));
    }
  }

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
  // Use `changes` (additions + deletions) as a fast proxy for file size —
  // `pulls.listFiles` does not return blob size. Skip generated-looking
  // paths. Cap total bytes loaded so a multi-megabyte PR can't blow the
  // review prompt's context window.
  const CHANGE_LIMIT = 4000; // lines-changed proxy for "too big"
  const GENERATED_PATH = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|Gopkg\.lock|poetry\.lock|composer\.lock|\.min\.(?:js|css)|dist\/|build\/)/;
  let bytesLoaded = 0;
  const skipped = [];

  for (const f of changed) {
    if (f.status === 'removed') continue;
    if (!REVIEWABLE_EXTENSIONS.test(f.filename)) continue;
    if (GENERATED_PATH.test(f.filename)) { skipped.push(`${f.filename} (generated)`); continue; }
    if ((f.changes || 0) > CHANGE_LIMIT) { skipped.push(`${f.filename} (${f.changes} changed lines)`); continue; }
    if (bytesLoaded >= MAX_REVIEW_FILE_BYTES * 5) { skipped.push(`${f.filename} (review budget exhausted)`); continue; }

    try {
      const { data } = await octokit.repos.getContent({
        owner, repo, path: f.filename, ref: headSha
      });
      if (data.content) {
        const text = Buffer.from(data.content, 'base64').toString('utf8');
        if (text.length > MAX_REVIEW_FILE_BYTES) {
          skipped.push(`${f.filename} (${text.length} bytes)`);
          continue;
        }
        fileMap[f.filename] = text;
        bytesLoaded += text.length;
      }
    } catch (e) {
      console.warn(`Could not fetch ${f.filename}: ${e.message}`);
    }
  }
  if (skipped.length) {
    console.warn(warn(`Skipped ${skipped.length} file(s) from review context: ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ` (+${skipped.length - 5} more)` : ''}`));
  }

  // ALSO pull dependency-manifest files even if they're not in the diff.
  // The review prompt requires "check the dep manifest before claiming a
  // library might be missing" — without this, the rule can't be satisfied.
  // Cheap (a handful of small files), high signal.
  const MANIFEST_PATHS = [
    'pyproject.toml', 'requirements.txt', 'requirements-dev.txt',
    'setup.cfg', 'setup.py', 'tox.ini', 'noxfile.py',
    'package.json',
    'Cargo.toml',
    'go.mod',
  ];
  // Fetch in parallel — sequential awaits cost ~270 ms each on a typical
  // octokit round trip, so 10 sequential calls add ~2.7 s of latency to
  // every review. Promise.all collapses that to one round trip's worth.
  await Promise.all(MANIFEST_PATHS.map(async (manifestPath) => {
    if (fileMap[manifestPath]) return; // already fetched if it was in the diff
    try {
      const { data } = await octokit.repos.getContent({
        owner, repo, path: manifestPath, ref: headSha
      });
      if (data.content) {
        const text = Buffer.from(data.content, 'base64').toString('utf8');
        if (text.length <= MAX_REVIEW_FILE_BYTES) fileMap[manifestPath] = text;
      }
    } catch (e) {
      // 404 = manifest not in this project, which is the common case. Anything
      // else (401, 403, 5xx, network) is a real signal we should surface so
      // the caller knows the review's manifest context may be incomplete.
      if (e.status !== 404) {
        console.warn(warn(`Could not fetch ${manifestPath} for review context: ${e.status || e.code || e.message}`));
      }
    }
  }));
  return fileMap;
}

async function handleReview(url, options = {}) {
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
  const output = await runReviewCopilot({
    pr, diff, fileMap,
    issueTitle: pr.title,
    issueBody: pr.body
  });
  // Split the human-readable review from the machine-readable inline findings.
  // review-report.md and any posted body show the clean prose; the structured
  // findings become inline PR comments.
  const inline = parseInlineComments(output);
  const report = stripInlineCommentsBlock(output);
  fs.writeFileSync('review-report.md', report);
  console.log(ok('review-report.md'));
  if (inline.length) console.log(info(`${inline.length} inline finding(s) parsed from review`));

  // Prominent, machine-readable verdict — so humans and CI both see it.
  const verdict = extractVerdict(report);
  emitGithubActionVerdict(verdict, 'review-report.md');
  console.log('\n' + step(`VERDICT: ${verdict}`));
  if (verdict === 'APPROVE') console.log(ok('PR looks safe to merge (per automated review).'));
  else if (verdict === 'REQUEST_CHANGES') console.log(err('PR has blocking issues. See review-report.md.'));
  else if (verdict === 'NEEDS_DISCUSSION') console.log(warn('PR needs human discussion. See review-report.md.'));
  else console.log(warn('Verdict could not be parsed. Treat as NEEDS_DISCUSSION.'));

  if (options.post) {
    // Works on any public PR: authenticated users can submit a COMMENT review
    // without write access to the target repo.
    console.log(step('Posting review as PR review comment'));
    const event = verdict === 'APPROVE' ? 'APPROVE'
                : verdict === 'REQUEST_CHANGES' ? 'REQUEST_CHANGES'
                : 'COMMENT';
    const credit = '🤖 Automated review by [github-agent](https://github.com/Hadar01/github-agents).';

    // Findings that anchor to a changed line are posted inline; the rest are
    // folded into the review body so nothing is lost.
    const { anchored, dropped } = partitionInlineComments(inline, diff);
    if (anchored.length) {
      console.log(info(`anchoring ${anchored.length} inline comment(s)${dropped.length ? `; ${dropped.length} folded into summary` : ''}`));
    }
    const body = `${credit}\n\n**Verdict:** ${verdict}\n\n${report}${formatDroppedFindings(dropped)}`;
    // Body used when inline anchoring is unavailable (422 retry / issue-comment
    // fallback): list ALL findings with their file:line in the prose.
    const bodyAllInline = `${credit}\n\n**Verdict:** ${verdict}\n\n${report}${formatDroppedFindings(inline)}`;

    try {
      let submitted;
      try {
        ({ data: submitted } = await octokit.pulls.createReview({
          owner, repo, pull_number: number, event, body,
          ...(anchored.length ? { comments: anchored } : {})
        }));
      } catch (e) {
        // A single bad inline anchor 422s the entire review. Retry once with a
        // summary-only review (all findings in the body) so it still lands.
        if (e.status === 422 && anchored.length) {
          console.log(warn('inline anchors rejected (422); reposting as a summary-only review.'));
          ({ data: submitted } = await octokit.pulls.createReview({
            owner, repo, pull_number: number, event, body: bodyAllInline
          }));
        } else {
          throw e;
        }
      }
      console.log(ok(`Posted: ${submitted.html_url}`));
    } catch (e) {
      // Falling back to a plain issue-style comment — this works even when
      // the token doesn't have permission to submit an APPROVE/REQUEST_CHANGES
      // review on the target repo.
      console.log(warn(`createReview failed (${e.status || e.code || e.message}); falling back to issue comment.`));
      try {
        const { data: comment } = await octokit.issues.createComment({
          owner, repo, issue_number: number,
          body: `🤖 **Automated review** (verdict: **${verdict}**)\n\n${report}${formatDroppedFindings(inline)}`
        });
        console.log(ok(`Posted comment: ${comment.html_url}`));
      } catch (e2) {
        console.log(err(`Comment post failed: ${e2.message}`));
      }
    }
  }

  // Advisory mode (the Action's non-blocking default): post findings but never
  // fail the run, so a REQUEST_CHANGES verdict shows up as a comment + job
  // summary without turning the PR check red.
  if (options.advisory) {
    if (verdict !== 'APPROVE') {
      console.log(warn(`--advisory: verdict is ${verdict} but exiting 0 (non-blocking).`));
    }
    return;
  }

  // Exit code so CI can gate merges on this.
  if (verdict === 'REQUEST_CHANGES') process.exit(1);
  if (verdict === 'UNKNOWN' || verdict === 'NEEDS_DISCUSSION') process.exit(2);
}

async function main() {
  if (!ANTHROPIC_API_KEY) { console.error('Missing ANTHROPIC_API_KEY in .env'); process.exit(1); }
  if (!GITHUB_TOKEN) { console.error('Missing GITHUB_TOKEN in .env'); process.exit(1); }

  const [cmd, target] = POSITIONAL;
  const options = {
    dryRun: FLAGS.has('--dry-run'),
    fork: FLAGS.has('--fork'),
    forcePr: FLAGS.has('--force-pr'),
    comment: FLAGS.has('--comment'),
    post: FLAGS.has('--post'),
    advisory: FLAGS.has('--advisory'),
    maxCost: getOptFloat('max-cost', DEFAULT_MAX_USD_PER_RUN),
    label: getOpt('label', null),
    max: getOptInt('max', 5)
  };

  const dashboard = await maybeStartDashboard();
  if (cmd !== 'review') console.log(banner());

  if (cmd === 'issue'  && target) return handleIssue(target, options, dashboard);
  if (cmd === 'review' && target) return handleReview(target, options);
  if (cmd === 'triage' && target) return handleTriage(target, options, dashboard);

  usage();
  process.exit(1);
}

// Only run when invoked directly — this lets tests require() the pipeline
// helpers (buildAuditTrail, buildPrBody, runIssue) without auto-starting main.
if (require.main === module) {
  main().catch(e => {
    console.error(err('Pipeline failed:'), e);
    process.exit(1);
  });
}

module.exports = {
  buildAuditTrail,
  buildPrBody,
  runIssue,
  handleReview,
  handleTriage,
  emitGithubActionVerdict,
  partitionInlineComments,
  formatDroppedFindings
};
