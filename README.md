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

<h3 align="center">An AI that ships pull requests — and reviews its own work before opening them.</h3>

<p align="center">
  <a href="#-quick-start">Quick Start</a> •
  <a href="#-what-makes-this-different">Why github-agent</a> •
  <a href="#️-architecture">Architecture</a> •
  <a href="#-safety-guardrails">Safety</a> •
  <a href="#-roadmap">Roadmap</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/model-Claude%20Sonnet-blueviolet?style=flat-square&logo=anthropic" alt="Claude Sonnet">
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="MIT License">
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen?style=flat-square&logo=node.js" alt="Node 18+">
</p>

---

`github-agent` is an **autonomous engineering pipeline** built on Claude. Give it a GitHub issue URL; it clones the repo, edits the code, runs the tests, has a **second AI instance review the diff**, and opens a pull request — all in one command.

```bash
node src/pipeline.js issue https://github.com/your/repo/issues/42
```

---

## ✨ See it in action

```
$ node src/pipeline.js issue https://github.com/your/repo/issues/42

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
  💭 [turn 1] Let me start by exploring the auth module.
  🔧 list_files(src/auth)
  🔧 read_file(src/auth/login.js)
  💭 [turn 2] The issue is at line 47 — email isn't lowercased before lookup.
  🔧 apply_patch(src/auth/login.js, ...)
  🔧 run_tests(npm test)
     → ok
  🔧 finish({"pr_summary":"Lowercase email before lookup..."})
  ✓ Agent finished after 4 turn(s)

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
Most AI coding tools **generate code and hand it to a human.** `github-agent` **ships it** — and audits itself first.

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
| Full audit trail in the PR body | ❌ | partial | ✅ |
| Cost estimate per run | ❌ | ❌ | ✅ |

### The self-review loop — the killer feature

A **second Claude instance**, with a completely fresh context and a different system prompt, audits the diff for:

- 🐛 **Bug risk** — logic errors, off-by-ones, null dereferences, drift from the original issue intent
- 🐛 **Bug risk** — logic errors, off-by-ones, null dereferences
- 🔲 **Edge cases** — inputs the engineering agent didn't consider
- 🧪 **Test coverage** — is the change actually tested?
- 🎯 **Scope creep** — did the agent touch things it shouldn't?

Verdict is one of `APPROVE` / `REQUEST_CHANGES` / `NEEDS_DISCUSSION`. On `REQUEST_CHANGES` the engineering agent does a **revision pass** with the review as input. On anything that isn't `APPROVE`, **the pipeline refuses to open the PR** — you have to pass `--force-pr` to override. No silent bad PRs.

---

## 🔬 Built for big open-source projects

Working on a 50-file toy repo is easy. Working on Qiskit, Cirq, or TQEC is not. `github-agent` has specific affordances for large scientific-Python-class codebases:

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
If the verdict is `REQUEST_CHANGES`, the engineering agent does a **revision pass** with the review feedback as input. The full report ships in the PR body — no black box, no guessing what the AI did.

---

## 🚀 Quick start

### Prerequisites

- Node.js 18+
- An [Anthropic API key](https://console.anthropic.com/)
- A [GitHub Personal Access Token](https://github.com/settings/tokens) — `public_repo` for OSS work, `repo` for private repos
- A [GitHub Personal Access Token](https://github.com/settings/tokens) with `repo` scope

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
git clone <your-fork-url>
cd github-agent
npm install
```

Create a `.env` file in the repo root:

```ini
ANTHROPIC_API_KEY=sk-ant-...
GITHUB_TOKEN=ghp_...
```

### Usage

```bash
# Fix an issue and open a PR (the main event)
node src/pipeline.js issue https://github.com/your/repo/issues/42

# Dry run — full pipeline, no commits/push/PR
node src/pipeline.js issue https://github.com/your/repo/issues/42 --dry-run

# Audit an existing PR (no editing — just the review report)
node src/pipeline.js review https://github.com/your/repo/pull/123
```

Or use the npm shorthand scripts:

```bash
npm run issue -- https://github.com/your/repo/issues/42
npm run review -- https://github.com/your/repo/pull/123
```

---

## 🏗️ Architecture

```
┌─────────────────┐
│  GitHub Issue   │
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────────────────────┐
│  Engineering Agent  (Claude + tool use)             │
│                                                     │
│  Tools:  read_file   list_files   write_file        │
│          apply_patch  run_tests   git_diff          │
│          git_status   finish                        │
│                                                     │
│  Loop:   explore → patch → test → repeat            │
└────────────────────┬────────────────────────────────┘
                     │  diff
                     ▼
┌─────────────────────────────────────────────────────┐
│  Self-Review  (Claude, fresh context)               │
│                                                     │
│  Audits:  bug risk · edge cases                     │
│           test coverage · scope creep               │
│                                                     │
│  Verdict:  APPROVE / REQUEST_CHANGES / DISCUSS      │
└─────────────┬───────────────────────────────────────┘
              │
       ┌──────┴────────────────────┐
       │ APPROVE                   │ REQUEST_CHANGES
       │                           ▼
       │               ┌───────────────────────┐
       │               │  Revision Pass        │
       │               │  (engineering agent   │
       │               │   + review feedback)  │
       │               └──────────┬────────────┘
       │                          │
       ▼                          ▼
┌────────────────────────────────────┐
│  Commit → Push → Open PR           │
│  (PR body includes review report)  │
└────────────────────────────────────┘
```

---

## 🛡️ Safety guardrails

The agent has real write access to files on disk. We've put real fences around it:

| Guardrail | Detail |
|---|---|
| **Path traversal blocked** | `read_file`, `write_file`, `apply_patch` reject any path escaping the repo root |
| **Test command allowlist** | `run_tests` only accepts `npm test`, `pytest`, `go test`, `cargo test`, etc. — no arbitrary shell |
| **Iteration cap** | Hard stop at 18 agent turns per pass |
| **Cost kill-switch** | Configurable per-run USD ceiling (default $5.00) — aborts before overspending |
| **Token leak prevention** | GitHub PAT is used for clone + push but never written to `.git/config` |
| **Patch uniqueness** | `apply_patch` requires the target string to be unique in the file — no accidental multi-site rewrites |
| **`--dry-run` mode** | Full pipeline simulation without committing, pushing, or opening anything |

---

## 💰 Cost transparency

Every run prints a token breakdown and a USD estimate. The audit trail records the same numbers in the PR body.

**Typical cost per issue:** $0.20 – $1.50, depending on repo size and whether the self-review triggers a revision pass.

```
Token usage (engineering + revision)
  input:      12,403 tok   @  $3.00 / MTok
  output:      1,847 tok   @ $15.00 / MTok
  cache read:  8,912 tok   @  $0.30 / MTok
  ─────────────────────────────────────
  estimated cost:  $0.0676
```

> Rates are read from `src/config.js` (`COST_INPUT_PER_MTOK`, `COST_OUTPUT_PER_MTOK`, `COST_CACHE_READ_PER_MTOK`). Update them there if Anthropic's pricing changes.

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
