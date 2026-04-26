# Marker-precedence empirical verification

Self-contained pytest project that runtime-verifies the central behavioral
claim in [`../sample-review-tqec-pr894-v3-curated.md`](../sample-review-tqec-pr894-v3-curated.md):

> When a slow test also carries an explicit `@pytest.mark.timeout(N)`
> decorator, the conftest's appended marker is silently ignored — the
> original decorator wins.

The curated review derives this from reading pytest and pytest-timeout
source code. This directory makes it observable at runtime.

## Files

| File | Role |
|---|---|
| `conftest.py` | Verbatim copy (modulo formatting) of `tests/conftest.py` from [`tqec/tqec` PR #894](https://github.com/tqec/tqec/pull/894). |
| `pyproject.toml` | Registers the `slow` marker so pytest doesn't warn about an unknown marker. Deliberately omits the `timeout = 30` baseline that lives in tqec's pyproject — we only want to test the marker-vs-marker interaction. |
| `test_marker_precedence.py` | Three test cases probing the three relevant configurations: `slow + explicit-timeout(1)`, `slow only`, `no markers`. |
| `verify_precedence.py` | Plugin-based inspector that runs `pytest --collect-only` with a hook that prints the resolved timeout marker for each item. **No tests are actually executed** — sidesteps platform-dependent pytest-timeout behavior. |

## How to reproduce

```bash
pip install pytest pytest-timeout         # tested with 8.3.5 / 2.4.0
cd examples/verify-marker-precedence
python verify_precedence.py
```

## Recorded output

Run on `pytest 8.3.5 + pytest-timeout 2.4.0` (Python 3.8.0, Windows):

```
test_marker_precedence.py::test_explicit_short_timeout_should_win
test_marker_precedence.py::test_only_slow_marker_uses_conftest_timeout
test_marker_precedence.py::test_no_markers_unaffected

================================================================
Marker precedence inspection (no tests executed)
================================================================

test_marker_precedence.py::test_explicit_short_timeout_should_win
  all timeout markers found: [(1,), (300,)]
  effective (get_closest_marker): (1,)

test_marker_precedence.py::test_only_slow_marker_uses_conftest_timeout
  all timeout markers found: [(300,)]
  effective (get_closest_marker): (300,)

test_marker_precedence.py::test_no_markers_unaffected
  all timeout markers found: []
  effective (get_closest_marker): None


3 tests collected in 0.00s
```

## Reading the result

The first test has **both** timeout markers attached to its item — `(1,)` was
applied during decoration (module load), `(300,)` was appended by the
conftest's `pytest_collection_modifyitems` hook after collection. Both are
visible via `iter_markers`.

`get_closest_marker("timeout")` returns the **first** one (`(1,)`), because
within the same node's `own_markers` list, that's the iteration order. The
explicit decorator wins; the conftest's marker is shadowed.

This is the runtime-observable consequence of the citation chain in
v3-curated.md:

1. `add_marker(marker, append=True)` (default) appends to `own_markers`.
   ([pytest source][1])
2. `iter_markers(name=...)` yields markers from `own_markers` in order.
   ([pytest source][1])
3. `get_closest_marker(...)` returns `next(iter_markers(...), default)`.
   ([pytest source][1])
4. pytest-timeout reads exactly that. ([pytest-timeout source][2])

[1]: https://github.com/pytest-dev/pytest/blob/main/src/_pytest/nodes.py
[2]: https://github.com/pytest-dev/pytest-timeout/blob/master/pytest_timeout.py

## Why this matters for the v3-curated review

The recommended fix in the curated review —

```python
if item.get_closest_marker("slow") and not item.get_closest_marker("timeout"):
    item.add_marker(pytest.mark.timeout(SLOW_TEST_TIMEOUT))
```

— is **mechanically equivalent** to today's behaviour for tests with an
explicit timeout, because the explicit one already wins. It's a clarity
nudge, not a bug fix. The recorded output above is what makes that claim
checkable: every reviewer can re-run this script in 30 seconds and see
which marker wins.
