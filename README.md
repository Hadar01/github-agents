<h1 align="center">
  <br>
  🤖 github-agent
  <br>
</h1>

<h3 align="center">An AI that ships pull requests — and reviews its own work before opening them.</h3>

<p align="center">
  <a href="#-quick-start">Quick Start</a> •
  <a href="#-what-makes-this-different">Why github-agent</a> •
  <a href="#-built-for-big-open-source-projects">Big Projects</a> •
  <a href="#️-architecture">Architecture</a> •
  <a href="#️-safety-guardrails">Safety</a> •
  <a href="#️-roadmap">Roadmap</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/model-Claude%20Sonnet%204.6-blueviolet?style=flat-square&logo=anthropic" alt="Claude Sonnet 4.6">
  <img src="https://img.shields.io/badge/tests-127%20passing-brightgreen?style=flat-square" alt="127 tests passing">
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen?style=flat-square&logo=node.js" alt="Node 18+">
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="MIT License">
  <img src="https://img.shields.io/badge/CI-Linux%20%7C%20macOS%20%7C%20Windows-555?style=flat-square&logo=githubactions" alt="CI matrix">
</p>

---

`github-agent` is an **autonomous engineering pipeline** built on Claude. Give it a GitHub issue URL; it clones the repo, edits the code, runs the tests, **has a second AI instance review the diff**, refuses to ship a PR that fails its own review, and opens a pull request — all in one command.

```bash
node src/pipeline.js issue https://github.com/your/repo/issues/42
```

---

## ✨ See it in action

```
$ node src/pipeline.js issue https://github.com/qiskit/qiskit/issues/9421 --fork --comment

   ╔════════════════════════════════════════════╗
   ║   github-agent — autonomous PR engineer    ║
   ║   engineering → self-review → ship         ║
   ╚════════════════════════════════════════════╝

▸ Issue qiskit/qiskit#9421
  title: Transpiler drops global phase on conditional gates
  default branch: main

▸ Cloning + branching
  ✓ branch: fix/issue-9421
  test command: tox
  lint commands: ruff check ., black --check ., mypy .
  monorepo sub-packages: terra, aer, ibmq
  guessed sub-package for issue: terra
  CONTRIBUTING.md found at CONTRIBUTING.md
  Project requires DCO Signed-off-by — will auto-sign commits.
  20 file(s) prefiltered as likely relevant
  pre-fix HEAD: 3f4a1b2

▸ Engineering agent — autonomous fix loop
  💭 [turn 1] Scoring the shortlist — transpiler/passes/optimization looks like the hit.
  🔧 find_relevant_files(query="transpiler global phase conditional gates")
  🔧 read_file(qiskit/transpiler/passes/optimization/consolidate_blocks.py)
  💭 [turn 2] Found it — line 142 drops .global_phase on IfElseOp. Patching.
  🔧 apply_patch(qiskit/transpiler/passes/optimization/consolidate_blocks.py, ...)
  🔧 run_tests(tox)      → PASS
  🔧 run_lint(ruff check .)   → PASS
  🔧 run_lint(mypy .)         → PASS
  🔧 finish({"pr_summary":"Preserve global_phase through IfElseOp consolidation..."})
  ✓ Agent finished after 6 turn(s)

▸ Self-review — auditing the diff
  ✓ Review verdict: APPROVE

Token usage (engineering + revision)
  input: 18,204 tok · output: 2,131 tok · cache_read: 14,067 tok
  cost: $0.4912

▸ Committing + pushing
  ✓ added DCO Signed-off-by trailer
  ✓ pushed fix/issue-9421 to Hadar01/qiskit

▸ Opening pull request
  ✓ PR opened: https://github.com/qiskit/qiskit/pull/11504
  ✓ commented on issue: https://github.com/qiskit/qiskit/issues/9421#issuecomment-...
```

---

## 🏆 What makes this different

Most AI coding tools **generate code and hand it to a human.** `github-agent` **ships it** — and audits itself first, refuses to ship bad work, and handles OSS repos you don't own.

|  | Copilot / Cursor | Devin / SWE-agent | **github-agent** |
|---|:---:|:---:|:---:|
| Generates code | ✅ | ✅ | ✅ |
| Runs tests autonomously | ❌ | ✅ | ✅ |
| Runs project linters autonomously | ❌ | partial | ✅ |
| Opens the PR for you | ❌ | ✅ | ✅ |
| **Reviews its own diff before shipping** | ❌ | ❌ | ✅ |
| **Refuses to ship on bad self-review** | ❌ | ❌ | ✅ |
| **Revises based on its own review** | ❌ | ❌ | ✅ |
| Knows when to give up | ❌ | ❌ | ✅ |
| Works on repos you don't own (fork + PR) | ❌ | ❌ | ✅ |
| Human-readable audit trail in PR body | ❌ | partial | ✅ |
| Cost estimate + kill switch per run | ❌ | ❌ | ✅ |

### The self-review loop — the killer feature

A **second Claude instance**, with a completely fresh context and a different system prompt, audits the diff for:

- 🐛 **Bug risk** — logic errors, off-by-ones, null dereferences, drift from the original issue intent
- 🔲 **Edge cases** — inputs the engineering agent didn't consider
- 🧪 **Test coverage** — is the change actually tested?
- 🎯 **Scope creep** — did the agent touch things it shouldn't?

Verdict is one of `APPROVE` / `REQUEST_CHANGES` / `NEEDS_DISCUSSION`. On `REQUEST_CHANGES` the engineering agent does a **revision pass** with the review as input. On anything that isn't `APPROVE`, **the pipeline refuses to open the PR** — you have to pass `--force-pr` to override. No silent bad PRs.

---

## 🔬 Built for big open-source projects

Working on a 50-file toy repo is easy. Working on Qiskit, Cirq, VIO is not. `github-agent` has specific affordances for large scientific-Python-class codebases:

| Problem on a Qiskit-scale repo | What github-agent does |
|---|---|
| Thousands of files — context blows up | **Keyword relevance prefilter** scores every file against issue text; top-20 injected as starting hint. No embeddings API needed. |
| Narrow language support misses `.pyx`/`.pxd`/`.pyi`/`.rst`/config | Walks all of them, plus `Makefile`, `tox.ini`, `noxfile.py`, `CONTRIBUTING.md`, PR templates. |
| Monorepos with sub-packages (`qiskit-terra`, `qiskit-aer`, …) | **Auto-detects sub-packages**, guesses from issue text which one the change belongs to, tells the agent. |
| Test command isn't bare `pytest` — it's `tox`, `nox`, `make test` | Priority-ordered detection: Makefile `test:` target → `make test`. `tox.ini` → `tox`. `noxfile.py` → `nox`. Then Python/Node/Rust. |
| CI gates on `ruff`, `black`, `mypy` — not just tests | **Lint gate**: auto-detects configured linters and the agent must pass them all before `finish()`. |
| Deeply-indented Python makes `apply_patch` brittle | **Whitespace-normalized fallback** + `apply_patch_range` (replace by line numbers) when strings won't disambiguate. |
| DCO sign-off / PR templates / CONTRIBUTING.md rules | All read and honored. `Signed-off-by:` trailer appended automatically. PR template preserved at top of PR body. |
| Scientific deps fail to install (BLAS/CUDA/compiled extensions) | `run_tests` detects `ModuleNotFoundError`/`ImportError` and flags `env_error:true`. The agent **gives up gracefully** instead of thrashing. |
| Complex issues need human judgment | The agent can call `give_up({reason, explanation, blockers})`. With `--comment` it posts the reason on the issue so a human picks up with full context. |
| Duplicate runs open duplicate PRs | **Duplicate-PR guard** — scans open PRs for `Resolves/Fixes/Closes #N` or matching `fix/issue-N` branch before cloning. |

> 🛑 **Honest limitation:** we don't provision test environments. If a repo needs GPU / BLAS / conda, you'll want to run the agent inside a pre-warmed Docker image. That executor is on the roadmap.

---

## 🧑‍⚖️ For maintainers wary of AI-generated PR noise

If you maintain a repo and you're (rightly) sceptical about AI tools dumping
generic *"consider error handling"* comments into your PR threads — read this.

**The `review` subcommand is offline by default.**

```bash
node src/pipeline.js review https://github.com/your-repo/pull/123
# → writes review-report.md to disk; never posts anywhere
# → exits 1 on REQUEST_CHANGES, 2 on NEEDS_DISCUSSION/UNKNOWN
# → exits 0 only on APPROVE
```

Posting to the PR requires an explicit `--post` flag. The default workflow is:

1. Run `review` offline on a PR you'd otherwise review by hand.
2. Read `review-report.md`. Cut anything speculative.
3. **Manually** decide whether the curated output is worth pasting into the
   thread. If not, throw it away — nothing was posted, no noise added.

Bug-risk findings must cite `file:line`. The verdict prompt biases toward
`NEEDS_DISCUSSION` rather than rubber-stamping `APPROVE`. The exit-code-on-
verdict design makes it CI-gateable as a *"block merge until a human
acknowledges the bot's concerns"* check, without ever opening a PR comment.

See [`examples/`](examples/) for sample artifacts produced by real runs.

---

## 🤝 Contributing to repos you don't own

You can run `github-agent` on any public open-source project, even without write access. A `public_repo`-scoped PAT is enough.

```bash
# Fork-and-PR: pushes to your own fork, opens PR upstream, links back to the issue.
node src/pipeline.js issue https://github.com/qiskit/qiskit/issues/9421 --fork --comment

# Review a PR in a project you're not a maintainer of.
# --post submits the review as a PR comment (falls back to issue comment if permissions block).
node src/pipeline.js review https://github.com/qiskit/qiskit/pull/11504 --post

# Triage multiple issues in one shot.
node src/pipeline.js triage https://github.com/qiskit/qiskit --label=bug --max=5 --fork --comment
```

The review subcommand **exits non-zero** on `REQUEST_CHANGES` so you can wire it straight into CI as a pre-merge gate.

---

## 🚀 Quick start

### Prerequisites

- Node.js 18+
- An [Anthropic API key](https://console.anthropic.com/)
- A [GitHub Personal Access Token](https://github.com/settings/tokens) — `public_repo` for OSS work, `repo` for private repos

### Installation

```bash
git clone https://github.com/Hadar01/github-agents.git
cd github-agents
npm install
cp .env.example .env
# edit .env:
#   ANTHROPIC_API_KEY=sk-ant-...
#   GITHUB_TOKEN=ghp_...
```

### Your first run

```bash
# Dry run first — full pipeline, no commits/push/PR
node src/pipeline.js issue https://github.com/your/repo/issues/42 --dry-run

# Ship it for real
node src/pipeline.js issue https://github.com/your/repo/issues/42

# Review an existing PR (no editing — just the audit)
node src/pipeline.js review https://github.com/your/repo/pull/123
```

Or use the npm shorthand scripts:

```bash
npm run issue  -- https://github.com/your/repo/issues/42
npm run review -- https://github.com/your/repo/pull/123
```

---

## 📖 Commands & flags

```
node src/pipeline.js issue  <issue-url>   [flags]
node src/pipeline.js review <pr-url>      [flags]
node src/pipeline.js triage <repo-url>    [flags]
```

| Flag | Subcommand | Effect |
|---|---|---|
| `--dry-run` | `issue`, `triage` | Full pipeline — skip commit/push/PR. |
| `--fork` | `issue`, `triage` | Push to your fork; open PR from fork to upstream. |
| `--comment` | `issue`, `triage` | Post a link-back comment on the original issue after PR opens. |
| `--post` | `review` | Submit review as a PR review comment (or issue comment fallback). |
| `--force-pr` | `issue`, `triage` | Override PR safety gate. Ship on `REQUEST_CHANGES` / no passing tests. |
| `--web` | any | Start a **live dashboard** at `http://localhost:3000`. |
| `--port=N` | any | Dashboard port (default `3000`). |
| `--max-cost=2.50` | any | Hard-abort agent if run cost (USD) exceeds this. Default `$5.00`. |
| `--label=bug` | `triage` | Only process issues with this label. |
| `--max=5` | `triage` | Cap batch size. |

---

## 🏗️ Architecture

```
┌─────────────────┐
│  GitHub Issue   │
└────────┬────────┘
         │
         ▼
┌───────────────────────────────────────────────────────────┐
│  Project discovery  (zero-cost, local)                    │
│    · detect test command (make/tox/nox/pytest/npm/...)    │
│    · detect linters (ruff/black/mypy/eslint/...)          │
│    · detect monorepo sub-packages + guess target          │
│    · read CONTRIBUTING.md, PR template, DCO requirement   │
│    · prefilter top-20 relevant files by keyword score     │
│    · check for duplicate open PR                          │
└────────┬──────────────────────────────────────────────────┘
         │
         ▼
┌───────────────────────────────────────────────────────────┐
│  Engineering Agent  (Claude + tool use, cost-capped)      │
│                                                           │
│  Tools:  read_file    list_files    find_relevant_files   │
│          write_file   apply_patch   apply_patch_range     │
│          run_tests    run_lint      git_diff              │
│          git_status   finish        give_up               │
│                                                           │
│  Loop:   explore → patch → test → lint → repeat           │
└────────┬──────────────────────────────────────────────────┘
         │  diff
         ▼
┌───────────────────────────────────────────────────────────┐
│  Self-Review  (Claude, fresh context + issue text)        │
│                                                           │
│  Audits:  bug risk · edge cases                           │
│           test coverage · scope creep                     │
│           drift from original issue intent                │
│                                                           │
│  Verdict: APPROVE / REQUEST_CHANGES / NEEDS_DISCUSSION    │
└────────┬──────────────────────────────────────────────────┘
         │
   ┌─────┴─────────────────────────┐
   │ APPROVE                       │ REQUEST_CHANGES
   │                               ▼
   │                  ┌───────────────────────┐
   │                  │  Revision Pass        │
   │                  │  (engineering agent   │
   │                  │   + review feedback)  │
   │                  └──────────┬────────────┘
   │                             │
   ▼                             ▼
┌───────────────────────────────────────────────────────────┐
│  Safety gate: require passing tests + clean verdict       │
│  On pass → commit (with DCO) → push (fork or upstream)    │
│          → open PR (honors PR template)                   │
│          → optional: comment on source issue              │
│  On fail → audit-trail.md written, PR blocked             │
└───────────────────────────────────────────────────────────┘
```

---

## 🛡️ Safety guardrails

The agent has real write access to files on disk, real API tokens, and real cost. We've put real fences around it:

| Guardrail | Detail |
|---|---|
| **Path traversal blocked** | `read_file`, `write_file`, `apply_patch*` reject any path escaping the repo root |
| **No shell interpretation** | `run_tests` / `run_lint` tokenize the command, reject shell metacharacters (`;`, `&&`, backticks, `$(…)`), and spawn with `shell: false` |
| **PR gate on bad self-review** | `REQUEST_CHANGES`, `NEEDS_DISCUSSION`, unparseable verdict, or no passing tests → PR is **blocked**. `--force-pr` to override |
| **Review exits non-zero for CI** | `pipeline.js review` exits `1` on `REQUEST_CHANGES`, `2` on `NEEDS_DISCUSSION`/`UNKNOWN` |
| **Iteration cap** | Hard stop at 18 agent turns per pass |
| **Cost kill-switch** | Configurable per-run USD ceiling (default $5.00) — aborts before overspending |
| **Token leak prevention** | GitHub PAT used for clone + push but never written to `.git/config` (remote URL stripped after clone) |
| **Patch uniqueness** | `apply_patch` requires a unique match; fallback to whitespace-normalized match; errors include closest-line hints |
| **No accidental file wipes** | `write_file` refuses to overwrite an existing file unless `overwrite:true` is explicitly passed |
| **Pre-fix HEAD in audit** | Every run records the starting SHA with a ready-to-paste `git reset --hard <sha>` revert |
| **Flaky-test tolerance** | `run_tests` retries 3× on failure; passes on retry are flagged `flaky:true`, not treated as clean |
| **Graceful give-up** | Agent can abort with `give_up({reason, explanation, blockers})` — no half-fixes shipped |
| **API retries** | Anthropic calls retry with exponential backoff on 429/529/network errors |
| **`--dry-run` mode** | Full pipeline simulation without committing, pushing, or opening anything |

---

## 💰 Cost transparency

Every run prints a token breakdown and a USD estimate. The same numbers land in the audit trail and the PR body.

**Typical cost per issue:** $0.20 – $1.50, depending on repo size and whether the self-review triggers a revision pass. Bigger repos (Qiskit-scale) trend toward the upper end.

```
Token usage (engineering + revision)
  input:        18,204 tok · output:    2,131 tok
  cache_read:   14,067 tok · cache_create:    0 tok
  ───────────────────────────────────────────────
  cost: $0.4912  (in $0.2731 + out $0.1598 + cache_r $0.0211 + cache_c $0.0000)
```

> Rates live in `src/config.js` (`COST_INPUT_PER_MTOK`, `COST_OUTPUT_PER_MTOK`, `COST_CACHE_READ_PER_MTOK`, `COST_CACHE_CREATION_PER_MTOK`). Update them if Anthropic pricing changes.

---

## 📋 Audit trail

Every run writes `audit-trail.md` (gitignored). Designed to be skimmable by a human reviewer in under a minute:

```
# Audit trail — issue #9421: Transpiler drops global phase on conditional gates

**Issue:**        https://github.com/qiskit/qiskit/issues/9421
**Branch:**       fix/issue-9421
**Pre-fix HEAD:** 3f4a1b2 — revert with git reset --hard 3f4a1b2
**Turns used:**   6 of 18
**Cost:**         $0.4912

## Outcome
✅ Finished — in single pass
Preserve global_phase through IfElseOp consolidation...

## Safety gates
- Self-review verdict: APPROVE
- Tests observed passing: YES
- Lint observed passing: YES

## Files touched
- qiskit/transpiler/passes/optimization/consolidate_blocks.py — 1 edit via apply_patch

## Test runs
- Total invocations: 1 · Passed: 1 · Failed: 0

## Timeline (condensed)
- Turn 1 — Scoring the shortlist…
  - ranked files for: "transpiler global phase conditional gates"
  - read qiskit/transpiler/passes/optimization/consolidate_blocks.py
- Turn 2 — Found it — line 142 drops .global_phase…
  - patched qiskit/transpiler/passes/optimization/consolidate_blocks.py
- Turn 3 — ran tests: tox → PASS; ran lint: ruff check . → PASS; ran lint: mypy . → PASS
- Turn 4 — signalled finish

## Self-review report
[full reviewer output]

## Full tool transcript
<details>…raw trace for debugging…</details>
```

---

## 📁 Project structure

```
github-agent/
├── src/
│   ├── pipeline.js              ← CLI entry + subcommands
│   ├── orchestrator.js          ← engineering → review → revision → PR + project discovery
│   ├── config.js                ← model, limits, cost rates
│   ├── agents/
│   │   ├── engineeringAgent.js  ← issue → autonomous fix
│   │   ├── reviewCopilot.js     ← diff → structured audit
│   │   ├── agentLoop.js         ← multi-turn tool-use loop, retries, cost ceiling
│   │   └── tools.js             ← tool schemas + sandboxed handlers
│   ├── prompts/
│   │   ├── engineering.js       ← agentic system prompt, monorepo/lint/contrib hints
│   │   └── review.js            ← review system prompt + verdict format
│   ├── mapper/
│   │   ├── repoMap.js           ← big-project file walker, ignore-dirs, truncation
│   │   └── fileRelevance.js     ← keyword scorer — starting-file prefilter
│   ├── utils/
│   │   ├── cost.js              ← pricing math (input/output/cache)
│   │   └── githubUrl.js         ← parse owner/repo/number from URLs
│   ├── cli/
│   │   └── output.js            ← pretty terminal + cost summary
│   └── web/
│       ├── server.js            ← Express SSE dashboard
│       └── public/index.html    ← live agent feed
├── tests/                       ← 127 tests across 9 suites
└── .github/workflows/test.yml   ← CI matrix: Linux/macOS/Windows × Node 18/20/22
```

---

## 🧪 Tests

```bash
npm test
```

**127 tests across 9 suites** covering path traversal, shell-injection guards, patch fallback strategies, repo walker truncation, big-project ignore-dirs, orchestrator verdict parsing, monorepo detection, CONTRIBUTING/DCO reading, cost math (including cache creation), audit trail structure, PR body + template honoring, and a mocked-SDK end-to-end run with retry semantics.

CI runs the full suite on **Linux / macOS / Windows × Node 18 / 20 / 22** for every push and pull request. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the contributor workflow and [`TESTING.md`](TESTING.md) for live, end-to-end feature testing recipes.

---

## 🗺️ Roadmap

- [ ] **Docker/devcontainer executor** — so `pytest` works on Qiskit-class repos that need BLAS / CUDA / compiled extensions
- [ ] **Embedding-based relevance** — drop-in replacement for the keyword prefilter on very abstract issues
- [ ] **Parallel triage** — one dashboard pane per issue when batching
- [ ] **LangSmith / Helicone telemetry export**
- [ ] **Pluggable language adapters** — `rustfmt`+`cargo`, `gofmt`+`go vet`, etc.

---

## 🤝 Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Short version: one behaviour change per PR, add a test with every behaviour change, `npm test` must be green on Node 18/20/22.

---

## 📄 License

[MIT](LICENSE) — use it, fork it, ship it.
