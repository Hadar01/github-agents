# GitHub Engineering Agent

## What this is
A two-agent system:
1. **Engineering Agent** — takes a GitHub issue, maps the repo, selects relevant 
   files, writes a minimal fix, verifies against tests, opens a PR
2. **Review Copilot** — takes a PR, audits the diff for bugs/edge cases, 
   writes a structured review report

## Stack
Node.js, Anthropic SDK, Octokit, simple-git

## Architecture rules — always follow these
- NEVER write code without first listing assumptions explicitly
- ALWAYS run existing tests before declaring a fix complete  
- Work on a new git branch per issue: fix/issue-{number}
- If a file's purpose is ambiguous, STOP and ask — do not guess
- Produce audit-trail.md for every run

## Project structure to build
src/
  mapper/repoMap.js          — file tree + dependency graph
  mapper/contextSelector.js  — uses Claude to pick relevant files for an issue
  agents/engineeringAgent.js — issue → fix → test → PR
  agents/reviewCopilot.js    — PR → audit → report
  prompts/engineering.js     — prompt templates
  prompts/review.js          — prompt templates
  pipeline.js                — CLI entry point
tests/
.env

## Commands
- node src/pipeline.js issue <github-issue-url>
- node src/pipeline.js review <github-pr-url>
- npm test