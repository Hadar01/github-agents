# Raw output — improved-prompt v2

This is the unedited output of the review copilot **after** the prompt was
hardened with explicit anti-hallucination rules and the pipeline was changed
to also fetch dependency manifests (`pyproject.toml`, `package.json`, …)
into review context.

Compare against `sample-review-tqec-pr894-v1-raw-flawed.md` to see what the
prompt-level fixes change in practice. Notice this version:

- Does **not** claim `pytest-timeout` might be missing (it now sees `pyproject.toml` and could verify).
- Does **not** assert pytest-timeout precedence as fact — it explicitly hedges *"I am not certain of the precedence rules…please confirm"*.
- Recommends a concrete fix that sidesteps the precedence ambiguity entirely (`if not item.get_closest_marker("timeout")`).

The human-curated final version (with citations to pytest source that *answer*
the questions this review hedges on) is `sample-review-tqec-pr894-v3-curated.md`.

---

## 1. Bug Risk

**Marker append order — potential timeout override (speculation, requires library confirmation):**

`tests/conftest.py:9-10` — The code calls `item.add_marker(pytest.mark.timeout(SLOW_TEST_TIMEOUT))` to append a `timeout` marker to items that already carry a `slow` marker. `pytest-timeout` resolves which `timeout` marker to honor when multiple are present on a single test item. I am not certain of the precedence rules for `pytest-timeout` when multiple `timeout` markers exist; please confirm against its docs or source. If `pytest-timeout` uses the *first* marker it finds rather than the *last*, and tests already have an explicit `@pytest.mark.timeout(...)` decorator, the appended marker may lose. Conversely, if a slow test has an explicit `@pytest.mark.timeout(60)`, this code will also append the 300-second marker, which may override the intentional shorter timeout. The safer call, if the library supports it, would be `item.add_marker(..., append=False)` (prepend) or — better — to check whether a `timeout` marker already exists before adding one.

**No drift from the issue's stated intent.** The PR does what the issue asks: uses `conftest.py` to set a higher timeout for `slow`-marked tests.

## 2. Edge Cases

**Tests with an explicit, shorter `timeout` marker:** If any slow test already has `@pytest.mark.timeout(N)` for some `N < 300`, this hook unconditionally appends a second `timeout` marker (`conftest.py:10`). The effective timeout will depend on `pytest-timeout`'s multi-marker behavior (unknown from this context). A guard like `if not item.get_closest_marker("timeout"):` would make the intent explicit and avoid surprises.

**`config` parameter omission:** `pytest_collection_modifyitems` accepts an optional `config` parameter (`def pytest_collection_modifyitems(config, items)`). Omitting it is valid in pytest, so this is not a bug — just noting it is intentional or irrelevant here.

**`SLOW_TEST_TIMEOUT = 300` with no documentation of rationale:** 5 minutes is a reasonable heuristic, but there is no comment explaining why 300 was chosen or whether it was validated against actual slow-test durations. This is a nit, not a blocker.

## 3. Test Coverage

There are no tests for the `conftest.py` hook itself. For a conftest hook this is standard practice — testing pytest hooks in isolation is unusual and generally not expected. The correctness of the hook can be validated by running `pytest -m slow` and observing that the timeout is applied. No gap to flag here beyond the speculative multi-marker concern above.

## 4. Scope Creep

No scope creep. The diff is a single new file (`tests/conftest.py`) that directly implements what the issue requested. No unrelated changes are bundled.

## 5. Verdict

**NEEDS_DISCUSSION**

The implementation is minimal and correctly structured, but there is one unresolved question that warrants discussion before merging: `pytest-timeout`'s behavior when multiple `timeout` markers exist on the same test item is not confirmed from the available context. If it honors the *last*-added marker (append wins), the code works as intended for the common case but will silently override any intentional explicit-timeout annotation on a slow test. If it honors the *first* marker, the appended marker is a no-op for tests that already carry a `timeout`. Adding a guard — `if not item.get_closest_marker("timeout"): item.add_marker(...)` — would make the behavior unambiguous regardless of library internals and is a low-cost change. The team should confirm the intended interaction with tests that carry both `slow` and an explicit `timeout` marker before merging.