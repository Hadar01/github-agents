# Contributing to github-agent

Thanks for your interest. This project ships real code to real repos, so we
hold the contributor workflow to the same bar as the runtime safety rails.

## Getting the project running locally

```bash
git clone https://github.com/Hadar01/github-agents.git
cd github-agents
npm install
cp .env.example .env
# ANTHROPIC_API_KEY=sk-ant-...
# GITHUB_TOKEN=ghp_...  (scope: public_repo for OSS work, repo for private)
```

Sanity-check your install:

```bash
npm test
node src/pipeline.js        # should print usage
```

Everything should go green on Node 18, 20, or 22.

## Before you open a PR

Run the full suite:

```bash
npm test
```

If you touched anything in `src/agents/` or `src/pipeline.js`, also smoke-test
the CLI end-to-end on a throwaway issue **in dry-run mode** (no push, no PR):

```bash
node src/pipeline.js issue https://github.com/<you>/<sandbox>/issues/<n> --dry-run
```

## PR etiquette

- **One behavior change per PR.** Safety rails, features, and refactors ship
  separately. Bundling makes review painful and audit trails muddy.
- **Add a test with every behavior change.** Every tool, every safety gate,
  every verdict-handling branch is covered today — keep it that way.
- **Run `npm test` locally before pushing.** CI runs on Linux/Windows/macOS ×
  Node 18/20/22; flakes caught locally are cheaper than matrix re-runs.
- **No emojis in code or commit messages** unless a file already uses them
  (dashboard HTML, banner, and CONTRIBUTING are the only places with any).
- **Never commit secrets.** `.env` is gitignored — keep it that way.

## Where things live

| Area | Directory |
|------|-----------|
| CLI entry / orchestration | `src/pipeline.js`, `src/orchestrator.js` |
| Engineering agent loop | `src/agents/agentLoop.js` |
| Tool schemas + sandboxed handlers | `src/agents/tools.js` |
| Prompt templates | `src/prompts/` |
| Repo walker (big-project safe) | `src/mapper/repoMap.js` |
| Cost math (source of the kill switch) | `src/utils/cost.js` |
| Terminal output + web dashboard | `src/cli/output.js`, `src/web/` |
| Tests | `tests/` |

## Safety-critical code paths (extra review needed)

Changes here need a second pair of eyes and a dedicated test:

- `src/agents/tools.js` — `safeJoin`, `parseTestCommand`, path traversal, the
  command allowlist. These are the security perimeter.
- `src/pipeline.js` — the PR gate in `runIssue`. Breaking this lets bad PRs
  ship silently.
- `src/agents/agentLoop.js` — `sawPassingTests` bookkeeping and the cost
  ceiling check. Breaking either unblocks shipment without verification.

## Filing an issue

If you're reporting a bug you hit while running the agent, please include:

- The subcommand (`issue`, `review`, `triage`) and flags used.
- The `audit-trail.md` the agent produced (it's gitignored — copy/paste the
  summary + final-turn output, redacting any repo-specific text).
- Node and npm versions (`node -v && npm -v`).
- OS.

## Using the agent on repos you don't own

The CLI supports fork-based contributions without write access to the target:

```bash
node src/pipeline.js issue <issue-url> --fork --comment
```

`--fork` pushes to your own fork and opens the PR from there. `--comment`
posts a link-back to the original issue so the issue author sees your PR.
Same idea for PR review:

```bash
node src/pipeline.js review <pr-url> --post
```

`--post` submits the review as a PR review comment. Works on any public
repo — GitHub lets any authenticated user comment on public PRs.
