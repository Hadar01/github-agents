<h1 align="center">
  <br>
  🤖 github-agent
  <br>
</h1>

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
  🔧 finish({"pr_summary":"Lowercase email before lookup..."})
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

---

## 🏆 What makes this different

Most AI coding tools **generate code and hand it to a human.** `github-agent` **ships it** — and audits itself first.

|  | Copilot / Cursor | Devin / SWE-agent | **github-agent** |
|---|:---:|:---:|:---:|
| Generates code | ✅ | ✅ | ✅ |
| Runs tests autonomously | ❌ | ✅ | ✅ |
| Opens the PR for you | ❌ | ✅ | ✅ |
| **Reviews its own diff before shipping** | ❌ | ❌ | ✅ |
| **Revises based on its own review** | ❌ | ❌ | ✅ |
| Full audit trail in the PR body | ❌ | partial | ✅ |
| Cost estimate per run | ❌ | ❌ | ✅ |

### The self-review loop — the killer feature

A **second Claude instance**, with a completely fresh context and a different system prompt, audits the diff for:

- 🐛 **Bug risk** — logic errors, off-by-ones, null dereferences
- 🔲 **Edge cases** — inputs the engineering agent didn't consider
- 🧪 **Test coverage** — is the change actually tested?
- 🎯 **Scope creep** — did the agent touch things it shouldn't?

If the verdict is `REQUEST_CHANGES`, the engineering agent does a **revision pass** with the review feedback as input. The full report ships in the PR body — no black box, no guessing what the AI did.

---

## 🚀 Quick start

### Prerequisites

- Node.js 18+
- An [Anthropic API key](https://console.anthropic.com/)
- A [GitHub Personal Access Token](https://github.com/settings/tokens) with `repo` scope

### Installation

```bash
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
│   ├── pipeline.js          ← CLI entry point
│   ├── orchestrator.js      ← engineering → self-review → revision → PR
│   ├── config.js            ← model, limits, cost rates
│   ├── agents/
│   │   ├── engineeringAgent.js  ← issue → autonomous fix
│   │   ├── reviewCopilot.js     ← diff → structured audit
│   │   ├── agentLoop.js         ← multi-turn tool-use loop + telemetry
│   │   └── tools.js             ← tool schemas + sandboxed handlers
│   ├── prompts/
│   │   ├── engineering.js       ← agentic system prompt + revision prompt
│   │   └── review.js            ← review system prompt + verdict format
│   ├── mapper/
│   │   ├── repoMap.js           ← walk + read source files
│   │   └── contextSelector.js   ← (legacy) Claude-picked relevant files
│   ├── utils/
│   │   └── githubUrl.js         ← parse owner/repo/number from GitHub URLs
│   └── cli/
│       └── output.js            ← pretty terminal output + cost summary
└── tests/
    ├── tools.test.js            ← path traversal, allowlist, apply_patch uniqueness
    ├── repoMap.test.js
    ├── githubUrl.test.js
    └── stripFences.test.js
```

---

## 🧪 Tests

```bash
npm test
```

The test suite covers the security-critical paths: path traversal prevention, the test-command allowlist, `apply_patch` uniqueness enforcement, repo mapping, and GitHub URL parsing.

---

## 🗺️ Roadmap

- [ ] **Web dashboard** — streaming live agent feed (great for ops + demos)
- [ ] **Fork-and-PR mode** — for repos where you don't have write access
- [ ] **Batch mode** — process multiple issues in one run (`triage` subcommand)
- [ ] **Telemetry export** — LangSmith / Helicone integration
- [ ] **Language adapters** — `rustfmt` + `cargo`, `gofmt` + `go vet`, `ruff` + `pytest`

---

## 📄 License

[MIT](LICENSE) — use it, fork it, ship it.
