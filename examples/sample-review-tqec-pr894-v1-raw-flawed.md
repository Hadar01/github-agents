# ⚠️ FLAWED OUTPUT — kept as a teaching artifact

This file is the **raw output of an earlier version of the review copilot
prompt**. Multiple findings turned out to be factually wrong when verified
against pytest and pytest-timeout source.

**Do not use this as a model of the tool's current behavior.** It exists in
the repo to document:
- what hallucination from a code-review LLM actually looks like in practice;
- why we then hardened the system prompt (see `src/prompts/review.js` rule set
  starting "Anti-hallucination rules");
- why the maintainer-facing workflow includes a manual curation step.

## What was wrong with this v1 review (verified against source)

| Original claim | Reality |
|---|---|
| "Silent no-op if `pytest-timeout` is not installed" | `tqec/pyproject.toml` pins `pytest-timeout>=2.4.0`. The plugin is always installed. The reviewer didn't have `pyproject.toml` in context — fixed in v2 by also fetching dependency manifests. |
| "If `pytest-timeout` iterates in reverse … slow tests could silently receive the wrong timeout" | Per pytest source, `get_closest_marker` returns the first marker yielded by `iter_markers`. For function-level markers in `own_markers`, that's the first one added. The behavior is deterministic, not version-dependent. |
| "Tests with an explicit `@pytest.mark.timeout(N)` will have their timeout overridden by the conftest" | **Backwards.** Because the conftest *appends* (`add_marker(append=True)`) and `get_closest_marker` returns the *first* matching marker, an existing decorator wins. The conftest's marker is silently ignored when an explicit one exists. |
| "If CI passes `--timeout=X` on the command line, that takes precedence over marker-based timeouts" | **Wrong direction.** Per [pytest-timeout docs](https://pypi.org/project/pytest-timeout/) the documented precedence (low → high) is: config → env var → CLI `--timeout` → marker. Markers outrank CLI. |

The improved-prompt output is in `sample-review-tqec-pr894-v2-raw.md`. The
human-curated final reviewer notes are in `sample-review-tqec-pr894-v3-curated.md`.

---

# Original v1 raw output (DO NOT TRUST)

## 1. Bug Risk

**Marker ordering / override risk (`tests/conftest.py:9-10`)**

`item.add_marker(pytest.mark.timeout(SLOW_TEST_TIMEOUT))` appends the marker. When `pytest-timeout` resolves the effective timeout for a test item it looks for the *first* matching marker (highest priority). If a specific test already carries its own `@pytest.mark.timeout(N)` annotation, the conftest-added marker will be appended *after* that one, which is actually correct behavior for most pytest-timeout versions (first marker wins). However, if `pytest-timeout` iterates in reverse or any future version changes precedence, slow tests could silently receive the wrong timeout. There is no guard against double-application.

**No `append` kwarg specified (`tests/conftest.py:10`)**

`add_marker` defaults to `append=True` in modern pytest, but making this explicit (`item.add_marker(..., append=True)`) documents intent and prevents a surprise if the default ever changes.

**Silent no-op if `pytest-timeout` is not installed (`tests/conftest.py:10`)**

The hook happily adds a `timeout` marker regardless of whether `pytest-timeout` is installed. If the plugin is absent, the marker is ignored without warning. There is no `pytest.importorskip` or requirements check to surface this misconfiguration.

**Drift from issue intent**: The issue says the *default* timeout is 30 s. That default appears to come from a `pyproject.toml`/`pytest.ini` `timeout =` setting (not visible in this diff). The conftest only increases timeouts for slow tests; it does not verify or document what the baseline is. If that baseline setting is ever removed, slow tests would get 300 s but fast tests would get *no* timeout at all — silently.

## 2. Edge Cases

- **Test already marked with `@pytest.mark.timeout`**: A developer who decorates a slow test with a custom timeout (e.g., 600 s for a particularly heavy test) will now have *two* timeout markers. Behavior depends entirely on `pytest-timeout` internals (which marker takes precedence). The conftest should check for an existing `timeout` marker before adding one.
- **Nested/parametrized slow tests**: `get_closest_marker("slow")` works correctly for parametrized items and inherited class-level markers, so this is low risk, but worth confirming if the test suite uses class-based tests.
- **`SLOW_TEST_TIMEOUT = 300` hardcoded**: 300 s (5 min) may be too short for some future slow tests and too long for others. Consider making this configurable via a `pytest.ini` option or environment variable.
- **`--timeout` CLI override interaction**: If CI passes `--timeout=X` on the command line, that takes precedence over marker-based timeouts in some `pytest-timeout` versions, making the conftest logic a no-op in those environments without warning.

## 3. Test Coverage

There is no test verifying that the hook correctly applies the marker. Conftest hooks are notoriously easy to accidentally break (e.g., a rename of `get_closest_marker` in a future pytest version). A meta-test (e.g., using `pytester`/`testdir` fixtures) that:

1. Defines a dummy slow test,
2. Runs collection via the conftest hook,
3. Asserts the `timeout` marker is present with value `300`,

would lock in the intended behavior. The absence of such a test means a silent regression is possible.

## 4. Scope Creep

None detected. The diff is minimal and directly addresses the stated issue. Only `tests/conftest.py` is touched.

## 5. Verdict

**NEEDS_DISCUSSION**

The implementation is directionally correct but has two issues worth resolving before merge: (1) there is no guard against double-application when a slow test already carries an explicit `timeout` marker, which can produce surprising behavior depending on `pytest-timeout` version; and (2) the interaction with the global `timeout` baseline (presumably set elsewhere) is undocumented and fragile — removing that baseline setting would silently disable timeouts for all non-slow tests. These are not outright blockers but represent enough ambiguity in intended behavior that a brief discussion (or at minimum inline comments documenting the assumptions) is warranted before approval.