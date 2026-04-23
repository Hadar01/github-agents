# github-agent

> An AI that ships PRs — **and reviews its own work before opening them.**

`github-agent` is an autonomous engineering pipeline built on Claude Opus. Give it a GitHub issue URL; it clones the repo, edits files, runs tests, audits its own diff with a second Claude instance, and opens a pull request — all in one command.

```bash
$ node src/pipeline.js issue https://github.com/your/repo/issues/42

   ╔════════════════════════════════════════════╗
   ║   github-agent — autonomous PR engineer    ║
   ║   engineering → self-review → ship         ║
   ╚════════════════════════════════════════════╝

▸ Issue your/repo#42
  title: Login fails when email contains uppercase
  default branch: main

▸ Cloning + branching
  ✓ branch: fix/issue-42
  test command: npm test

▸ Engineering agent — autonomous fix loop
  💭 [turn 1] Let me start by exploring the auth module.
  🔧 list_files(src/auth)
  🔧 read_file(src/auth/login.js)
  💭 [turn 2] The issue is at line 47 — email isn't lowercased before lookup.
  🔧 apply_patch(src/auth/login.js, ...)
  🔧 run_tests(npm test)
     → ok
  🔧 finish({"pr_summary":"Lowercase email at..."})
  ✓ Agent finished after 4 turn(s)

▸ Self-review — auditing the diff
  ✓ Review verdict: APPROVE

Token usage (engineering + revision)
  input: 12,403 tok · output: 1,847 tok · cache_read: 8,912 tok
  cost: $0.3284

▸ Committing + pushing
  ✓ pushed fix/issue-42 to your/repo

▸ Opening pull request
  ✓ PR opened: https://github.com/your/repo/pull/431
```

## What makes this different

Most AI coding tools generate code and hand it to a human. `github-agent` ships it.

| | Copilot / Cursor | Devin / SWE-agent | **github-agent** |
|---|---|---|---|
| Generates code | ✅ | ✅ | ✅ |
| Runs tests autonomously | ❌ | ✅ | ✅ |
| Opens the PR | ❌ | ✅ | ✅ |
| **Reviews its own diff before shipping** | ❌ | ❌ | ✅ |
| **Revises based on its own review** | ❌ | ❌ | ✅ |
| Ships an audit trail you can defend | ❌ | partial | ✅ |

The killer feature is the **self-review loop**: a second Claude instance, with a different system prompt and zero context from the engineering pass, audits the diff for bug risk, edge cases, test coverage, and scope creep. If the verdict is `REQUEST_CHANGES`, the engineering agent does a revision pass with the review feedback as input. The full report ships in the PR body — no black box.

## Architecture

```
┌─────────────────┐
│ GitHub issue    │
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────────────────────┐
│ Engineering Agent (Claude Opus + tool use)          │
│   Tools: read_file, list_files, write_file,         │
│          apply_patch, run_tests, git_diff,          │
│          git_status, finish                         │
│   Loop: explore → patch → test → repeat             │
└────────┬────────────────────────────────────────────┘
         │  diff
         ▼
┌─────────────────────────────────────────────────────┐
│ Self-Review (Claude Opus, fresh context)            │
│   Audits: bug risk, edge cases, test coverage,      │
│           scope creep                               │
│   Verdict: APPROVE / REQUEST_CHANGES / DISCUSS      │
└────────┬────────────────────────────────────────────┘
         │
    ┌────┴─────┐
    │          │ REQUEST_CHANGES
    │APPROVE   ▼
    │     ┌────────────────────┐
    │     │ Revision pass      │
    │     │ (engineering agent │
    │     │  with review as    │
    │     │  feedback)         │
    │     └────┬───────────────┘
    │          │
    ▼          ▼
┌─────────────────────┐
│ Commit + push + PR  │  ← PR body includes self-review report
└─────────────────────┘
```

## Quick start

```bash
git clone <this repo>
cd github-agent
npm install

cp .env.example .env
# fill in:
#   ANTHROPIC_API_KEY=sk-ant-...
#   GITHUB_TOKEN=ghp_...   (needs `repo` scope on the target)

# Try it (dry run — no commits, no PR)
node src/pipeline.js issue https://github.com/your/repo/issues/42 --dry-run

# Actually ship a PR
node src/pipeline.js issue https://github.com/your/repo/issues/42

# Review an existing PR (no autonomous editing — just the audit)
node src/pipeline.js review https://github.com/your/repo/pull/123
```

## Safety guardrails

The agent has real write access to the repo on disk. We've put real fences around it:

- **Path traversal blocked.** `read_file`, `write_file`, `apply_patch` reject any path that escapes the repo root.
- **Test command allowlist.** `run_tests` only accepts commands prefixed with `npm test`, `pytest`, `go test`, `cargo test`, etc. — no arbitrary shell.
- **Iteration cap.** The agent has 18 turns max. Beyond that the loop hard-stops.
- **Token leak prevention.** GitHub PAT is used for clone + push but never persisted to `.git/config` (we strip the remote URL after clone).
- **Apply-patch uniqueness.** `apply_patch` requires the target string to be unique in the file — no accidental multi-site rewrites.
- **`--dry-run` mode.** Run end-to-end without committing/pushing/opening anything.

## Cost transparency

Every run prints token usage and a USD estimate. The audit trail records the same numbers. Typical issue: $0.20 – $1.50 depending on repo size and how many revision passes the self-review triggers.

## Project structure

```
src/
  pipeline.js              ← CLI entry
  orchestrator.js          ← engineering → self-review → revision → PR
  config.js                ← model, limits, costs
  agents/
    engineeringAgent.js    ← issue → autonomous fix
    reviewCopilot.js       ← diff → structured audit
    agentLoop.js           ← multi-turn tool-use loop with telemetry
    tools.js               ← tool schemas + sandboxed handlers
  prompts/
    engineering.js         ← agentic system prompt + revision prompt
    review.js              ← review system prompt + verdict format
  mapper/
    repoMap.js             ← walk + read source files
    contextSelector.js     ← (legacy) Claude-picked relevant files
  utils/
    githubUrl.js           ← parse owner/repo/number from GitHub URLs
  cli/
    output.js              ← pretty terminal + cost summary
tests/
  tools.test.js            ← path traversal, allowlist, apply_patch uniqueness
  repoMap.test.js
  githubUrl.test.js
  stripFences.test.js
```

## Tests

```bash
npm test
```

## Roadmap

- Web dashboard streaming the live agent feed (great for ops + demos)
- Fork-and-PR mode for repos where you don't have write access
- Multi-issue batch mode (`triage` subcommand)
- LangSmith / Helicone telemetry export
- Pluggable language adapters (rustfmt + cargo, gofmt + go vet, ruff + pytest)

## License

MIT
