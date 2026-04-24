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
git clone https://github.com/Hadar01/github-agents.git
cd github-agents
npm install

cp .env.example .env
# fill in:
#   ANTHROPIC_API_KEY=sk-ant-...
#   GITHUB_TOKEN=ghp_...   (scope: public_repo for OSS, repo for private)

# Try it (dry run — no commits, no PR)
node src/pipeline.js issue https://github.com/your/repo/issues/42 --dry-run

# Actually ship a PR
node src/pipeline.js issue https://github.com/your/repo/issues/42

# Review an existing PR (no autonomous editing — just the audit)
node src/pipeline.js review https://github.com/your/repo/pull/123
```

## Contributing to repos you don't own

You can run the agent on any public repo, even without write access:

```bash
# Fork-and-PR: pushes to your fork, opens PR from fork to upstream,
# and leaves a comment on the original issue pointing at your PR.
node src/pipeline.js issue https://github.com/some/project/issues/99 \
  --fork --comment

# Review a PR in a project you're not a maintainer of.
# --post submits the review as a PR review comment (falls back to an
# issue-style comment if your token can't submit a formal review).
node src/pipeline.js review https://github.com/some/project/pull/42 --post
```

Both flags work with a `public_repo` scoped PAT — no `repo` scope required.

## Flags

| Flag | Effect |
|---|---|
| `--dry-run` | Run engineering + self-review locally; skip commit/push/PR. |
| `--fork` | Push to your own fork; open PR from fork to upstream. |
| `--comment` | After opening a PR, post a comment on the original issue linking to it. |
| `--post` | (review only) Submit the review as a PR review comment — no write access needed. |
| `--force-pr` | Open a PR even if self-review verdict is REQUEST_CHANGES or tests never passed. Use sparingly. |
| `--web` | Start a live event dashboard on `http://localhost:3000`. |
| `--port=N` | Dashboard port. |
| `--max-cost=2.50` | Abort the agent if cost (USD) exceeds this. |
| `--label=bug` `--max=5` | (triage only) Filter issues by label and cap batch size. |

## Audit trail

Every run writes `audit-trail.md` in the repo root (gitignored). Sections:

1. **Header** — issue URL, branch, pre-fix HEAD (with ready-to-paste revert),
   total turns, total cost.
2. **Outcome** — one-line ✅ Finished / ❌ Gave up / ⚠ Did not finish, with
   the final PR summary or give-up explanation.
3. **Safety gates** — verdict, `tests observed passing`, `lint observed
   passing`.
4. **Files touched** — each edited path with the number of edits and which
   tool made them.
5. **Test runs** — total / passed / flaky / failed / env-errors.
6. **Timeline (condensed)** — one bullet per turn: thought + tool summary.
7. **Self-review report** — full reviewer output.
8. **Full tool transcript** — collapsed `<details>` for debugging.

Designed to be skimmable by a reviewer in under a minute.

## Safety guardrails

The agent has real write access to the repo on disk. We've put real fences around it:

- **Path traversal blocked.** `read_file`, `write_file`, `apply_patch` reject any path that escapes the repo root.
- **No shell interpretation in `run_tests`.** Commands are tokenized, matched against a structured allowlist, rejected if they contain any shell metacharacter (`;`, `&&`, backticks, `$()`, …), then spawned with `shell: false`.
- **PR won't open on a bad self-review.** If the review verdict is `REQUEST_CHANGES`, `NEEDS_DISCUSSION`, or unparseable, the PR is blocked. Same if the agent never observed a passing `run_tests` call. Override with `--force-pr` only after reading the audit trail.
- **Non-zero exit codes on review failure.** `node src/pipeline.js review ...` exits `1` on `REQUEST_CHANGES` and `2` on `NEEDS_DISCUSSION`/`UNKNOWN` so CI can gate on the verdict.
- **Iteration cap.** The agent has 18 turns max. Beyond that the loop hard-stops.
- **Cost ceiling kill switch.** Hard-abort the agent if cumulative spend crosses `--max-cost=N`.
- **Token leak prevention.** GitHub PAT is used for clone + push but never persisted to `.git/config` (we strip the remote URL after clone).
- **Apply-patch uniqueness.** `apply_patch` requires the target string to be unique in the file — no accidental multi-site rewrites.
- **Pre-fix HEAD in the audit trail.** Every run records the starting SHA with a ready-to-paste `git reset --hard <sha>` revert.
- **Flaky-test tolerance.** `run_tests` retries up to 3× on failure; a test that passes on retry is flagged `flaky:true` rather than treated as a pass.
- **`--dry-run` mode.** Run end-to-end without committing/pushing/opening anything.

## Big-project support (Qiskit / Cirq / TQEC-class repos)

Working on a flat ~50-file repo is easy. Qiskit-scale repos need more. The
agent has these specific affordances for big scientific-Python codebases:

- **Wide file-type coverage.** Walks `.py`, `.pyx`, `.pxd`, `.pyi`,
  `.c`/`.cpp`/`.h`, `.rs`, `.go`, `.java`, plus config/docs (`.toml`, `.cfg`,
  `.ini`, `.yaml`, `.md`, `.rst`) and special files (`Makefile`, `tox.ini`,
  `noxfile.py`, `CONTRIBUTING.md`, PR templates). No more blind spots.
- **Keyword relevance prefilter.** Before turn 1, the pipeline scores repo
  files against the issue text (basename + content tokens, no external API)
  and injects the top-20 as a starting hint. Lightweight; replaceable with
  embeddings later.
- **Monorepo awareness.** Detects Python/Node/Rust sub-packages
  (`qiskit-terra`, `qiskit-aer`, …) and guesses from issue text which
  sub-package the change belongs to. Surfaces this as a hint in the prompt.
- **Richer test-command detection.** `Makefile` with a `test:` target →
  `make test`. `tox.ini` → `tox`. `noxfile.py` → `nox`. Falls back to
  `pytest` only when none of those exist.
- **Lint gate.** Detects `ruff`, `black`, `mypy`, `flake8`, `pylint`,
  `eslint`, `prettier` from their config files and exposes `run_lint` to
  the agent. Running tests green but failing `ruff` is the most common
  scientific-Python CI failure — the agent is told to fix both.
- **Patch fallback.** `apply_patch` first tries exact match, then
  whitespace-normalized match (handles tabs-vs-spaces drift in deep Python
  indentation). Errors include closest-line hints. `apply_patch_range`
  replaces lines by number — last-resort option when strings won't
  disambiguate.
- **Safer `write_file`.** Refuses to overwrite an existing file unless
  `overwrite:true` is passed. No more silent whole-file wipes.
- **Context-window protection.** `buildRepoMap` caps at 2000 files;
  `list_files` caps at 500 with `truncated:true` + a guidance note telling
  the agent to narrow its query. Ignore-dirs list covers `node_modules`,
  `target`, `vendor`, `.mypy_cache`, `.pytest_cache`, `.ruff_cache`, `.tox`,
  `.nox`, `_build`, `site`, `.gradle`, `.idea`, `.turbo`, etc.
- **Graceful give-up.** The agent can call `give_up({ reason, explanation,
  blockers })` instead of hitting the iteration limit with a half-fix.
  Known reasons: `too_complex`, `missing_env`, `test_env_missing`,
  `insufficient_info`, `needs_human`, `out_of_scope`. With `--comment`
  the explanation is posted to the original issue.
- **CONTRIBUTING.md and PR template honored.** Extracts the first 2 KB of
  `CONTRIBUTING.md` into the agent's prompt so it learns the project's
  commit-message / DCO / style rules. If the project ships a PR template
  (`.github/PULL_REQUEST_TEMPLATE.md`), the PR body preserves its structure.
- **DCO sign-off.** Detects DCO requirement (`.github/dco.yml` or
  "Signed-off-by" in `CONTRIBUTING.md`) and appends `Signed-off-by:` to
  commits automatically.
- **Duplicate-PR guard.** Before cloning, searches open PRs for
  `Resolves/Fixes/Closes #N` or a matching `fix/issue-N` branch. If one
  exists, skips with a link. Triage summary shows the skip.

### Honest limitations on the biggest repos

- **We don't provision test environments.** If Qiskit's test suite needs
  BLAS / compiled extensions / GPU / conda, `pytest` will fail with import
  errors on a vanilla runner. The agent sees `env_error:true` on the
  `run_tests` result and is told to `give_up("test_env_missing")` rather
  than thrash. A proper fix would be a Docker/devcontainer executor —
  that's on the roadmap.
- **Relevance prefilter is keyword-based, not semantic.** Works well on
  issues that name files/functions by string; weaker on abstract bug
  reports. Dropping in embeddings is a ~50-line replacement.

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
    repoMap.js             ← walk + read source files, big-project ignores
    fileRelevance.js       ← keyword scorer for starting-file prefilter
  utils/
    githubUrl.js           ← parse owner/repo/number from GitHub URLs
  cli/
    output.js              ← pretty terminal + cost summary
tests/
  tools.test.js                   ← traversal, allowlist, patch fallback, give_up
  repoMap.test.js                 ← ignores, extensions, truncation, subdir prefix
  listFiles.paths.test.js         ← list_files returns repo-root-relative paths
  orchestrator.test.js            ← test/lint detection, monorepo, CONTRIBUTING
  fileRelevance.test.js           ← keyword scorer ranks likely-relevant first
  pipeline.unit.test.js           ← audit-trail sections, PR body, DCO
  cost.test.js                    ← input/output/cache pricing math
  githubUrl.test.js
  agentLoop.integration.test.js   ← mocked-SDK end-to-end + retries + sawTests
```

## Tests

```bash
npm test
```

CI runs the suite on Linux / macOS / Windows across Node 18, 20, and 22.
See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the contributor workflow.

## Roadmap

- LangSmith / Helicone telemetry export
- Pluggable language adapters (rustfmt + cargo, gofmt + go vet, ruff + pytest)
- Parallel triage (one dashboard pane per issue)

## License

MIT
