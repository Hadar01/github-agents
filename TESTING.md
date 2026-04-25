# Live testing guide

`npm test` covers logic. This guide walks through exercising every shipped
feature against **real GitHub** (or a tightly-scoped sandbox) so you can
verify behaviour end-to-end.

## Set up a sandbox repository (recommended)

The safest way to test destructive behaviours (PR opening, commits, comments)
is on a throwaway repo you own. Five minutes of setup buys you confidence.

```bash
# 1. Make a tiny buggy Node project
mkdir ~/agent-sandbox && cd ~/agent-sandbox
git init -b main
npm init -y
cat > calc.js <<'EOF'
function add(a, b) { return a - b; }   // deliberate bug
module.exports = { add };
EOF
cat > calc.test.js <<'EOF'
const { add } = require('./calc');
test('add returns sum', () => {
  expect(add(2, 3)).toBe(5);
});
EOF
npm install --save-dev jest >/dev/null 2>&1
npm pkg set scripts.test=jest
git add -A && git commit -m "Initial buggy calculator"

# 2. Push to GitHub (assumes gh CLI; otherwise create on github.com manually)
gh repo create agent-sandbox --public --source=. --push
gh issue create --title "add() returns wrong result" \
                --body "Expected add(2, 3) to be 5 but tests fail. Please fix."
```

Replace `<you>` with your GitHub username everywhere below.

---

## 1. Dry-run end-to-end (the smoke test)

Verifies: agent loop, tool use, run_tests, self-review, audit trail, dashboard.
**No commit / push / PR.**

```bash
cd ~/desktop/github-agent
node src/pipeline.js issue https://github.com/<you>/agent-sandbox/issues/1 \
  --dry-run --web
```

Open `http://localhost:3000` in a browser to watch the live event feed.

**Expected:** terminal shows turn-by-turn thoughts and tool calls; dashboard
mirrors them; audit trail written to `repos/<you>-agent-sandbox/audit-trail.md`.

```bash
# Inspect the audit trail
cat ~/desktop/github-agent/repos/<you>-agent-sandbox/audit-trail.md
```

You should see the new sections: **Outcome**, **Safety gates**, **Files
touched**, **Test runs**, **Timeline (condensed)**, **Self-review report**,
collapsed **Full tool transcript**.

---

## 2. Real PR shipment (sandbox)

```bash
node src/pipeline.js issue https://github.com/<you>/agent-sandbox/issues/1
```

**Expected:** `pushed fix/issue-1 to <you>/agent-sandbox` → `PR opened: ...`.

Open the PR on github.com — the body should include `Resolves #1`, the
engineering summary, and the collapsed self-review report.

---

## 3. PR safety gate (the new "won't ship bad work" guarantee)

Pick an issue the agent will likely fail to fix cleanly — e.g. ask it to
"prove the Riemann hypothesis in calc.js." Or break the test command so no
test ever passes.

```bash
gh issue create --title "Implement Riemann hypothesis proof in calc.js" \
                --body "Please add a complete formal proof of the Riemann hypothesis."
node src/pipeline.js issue https://github.com/<you>/agent-sandbox/issues/2
```

**Expected:**
- Agent either calls `give_up` (best case), or calls `finish` after a flailing
  patch with no passing test run.
- Pipeline prints `gate: ...` lines and **refuses to open the PR**.
- Console says `Refusing to open a PR. Re-run with --force-pr to override`.

To verify the override works:

```bash
node src/pipeline.js issue https://github.com/<you>/agent-sandbox/issues/2 --force-pr
```

---

## 4. `give_up` graceful exit

The agent calls `give_up` when an issue is out of scope. Easiest way to force
it: file an issue that needs missing infrastructure.

```bash
gh issue create --title "Add CUDA-accelerated matrix solver" \
                --body "We need a GPU-backed matrix solver. Implement it."
node src/pipeline.js issue https://github.com/<you>/agent-sandbox/issues/3 \
  --comment
```

**Expected:**
- Audit trail outcome: `❌ Gave up — too_complex` (or similar reason) with
  explanation + blockers.
- A comment posted on issue #3 with the give-up reason and blockers list.
- No PR opened.

---

## 5. Cost ceiling kill switch

```bash
node src/pipeline.js issue https://github.com/<you>/agent-sandbox/issues/1 \
  --max-cost=0.01 --dry-run
```

**Expected:** terminal prints `Cost limit hit at turn N: $X > $0.01` after
the first or second turn. Audit trail's Outcome section shows
`⚠ Did not finish — cost_limit`.

---

## 6. Triage subcommand

Process up to N open issues by label in one batch.

```bash
gh issue create --title "Doc typo in README" --body "Says 'helo'." --label bug
gh issue create --title "calc.js needs JSDoc" --body "No comments." --label bug

node src/pipeline.js triage https://github.com/<you>/agent-sandbox \
  --label=bug --max=3 --dry-run --web
```

**Expected:** triage summary at the end with one line per issue: `✓` (PR
opened), `[dry]`, or `✗` (skipped/failed). `total spend: $X.XXXX` at bottom.

---

## 7. Duplicate-PR guard

Run the same issue command twice in a row.

```bash
node src/pipeline.js issue https://github.com/<you>/agent-sandbox/issues/1
# … wait for it to open the PR …
node src/pipeline.js issue https://github.com/<you>/agent-sandbox/issues/1
```

**Expected (second run):**
```
⚠ An open PR already resolves issue #1: https://github.com/<you>/agent-sandbox/pull/N
⚠ Skipping. Re-run with --force-pr to process anyway.
```

No clone, no agent loop, no token spend.

---

## 8. Fork-and-PR mode (works on repos you don't own)

Pick a public repo where you don't have write access. Bonus: pick one where
you've got a small bug to fix already.

```bash
node src/pipeline.js issue https://github.com/some/public-repo/issues/123 \
  --fork --comment --dry-run
```

**Expected:**
- `✓ fork: <you>/public-repo` (creates fork on first run, finds existing
  fork on subsequent).
- After the agent finishes, terminal would push to `<you>/public-repo` and
  open PR upstream — but `--dry-run` skips that.

Drop `--dry-run` to actually ship. The PR appears as `<you>:fix/issue-123 →
<upstream>:main` and `--comment` posts a link-back on the source issue.

---

## 9. Review subcommand + `--post`

Audit any public PR. Exits non-zero on `REQUEST_CHANGES`, so it's wireable
into CI as a pre-merge gate.

```bash
node src/pipeline.js review https://github.com/some/public-repo/pull/456
echo "exit code: $?"
```

**Expected output ends with:**
```
▸ VERDICT: APPROVE          ← or REQUEST_CHANGES / NEEDS_DISCUSSION / UNKNOWN
✓ PR looks safe to merge (per automated review).
exit code: 0
```

**With `--post`:**

```bash
node src/pipeline.js review https://github.com/some/public-repo/pull/456 --post
```

Submits the review as a PR review comment (or falls back to an issue
comment if the token can't submit a formal review).

---

## 10. Big-project / monorepo / lint detection

This is hard to fully test without actually running on Qiskit-class repos
(which the cost ceiling makes risky). The cheap proxy is to confirm the
detection logic fires on the right project shape.

```bash
# In a Python project with pyproject.toml + tox.ini + ruff config:
cd /path/to/python-project
node ~/desktop/github-agent/src/pipeline.js issue \
  https://github.com/<you>/<repo>/issues/X --dry-run | head -20
```

**Expected (in the "Cloning + branching" section):**
```
test command: tox        ← or `make test` / `nox` if those exist
lint commands: ruff check ., black --check ., mypy .
monorepo sub-packages: terra, aer, ...   ← only if subdirs have own pyproject.toml
guessed sub-package for issue: terra
CONTRIBUTING.md found at CONTRIBUTING.md
N file(s) prefiltered as likely relevant
```

---

## 11. `apply_patch` fallback + `apply_patch_range`

Run the agent on a Python file with mixed tabs/spaces and watch the audit
trail. Look for `(whitespace-normalized match)` in the engineering timeline.
The fallback fires when the model produces a slightly off whitespace pattern.

The `apply_patch_range` tool is the agent's last-resort knob — you'll see
`replaced lines X-Y of <file>` in the timeline when it kicks in.

These are mostly observable through audit trails, not via a deterministic
trigger script.

---

## 12. CI matrix verification

Push the branch to GitHub. The `tests` workflow runs the suite on **Linux
/ macOS / Windows × Node 18 / 20 / 22**.

```bash
gh run watch    # follow the latest run live
```

**Expected:** all 9 cells green. The most likely failure is Windows + npm:
`parseAllowlistedCommand` shims `npm.cmd` on Windows; if a new node-based
tool gets added to the allowlist without the shim, that test cell will be
the first to fail.

---

## When something looks wrong

- **`audit-trail.md` is your friend.** It has Outcome, Safety gates, Files
  touched, Test runs, and a condensed Timeline up top — and a full
  `<details>` transcript at the bottom for raw debugging.
- **The dashboard (`--web`)** is the fastest way to see *why* the agent
  picked the wrong file or burned a turn on a dead end.
- **Re-run with `--max-cost=0.50`** while debugging so a runaway loop can't
  rack up serious money.
- **`--dry-run` everything** until you trust the run on that repo type.
