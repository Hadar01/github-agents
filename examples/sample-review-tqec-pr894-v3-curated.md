# Curated review — `tqec/tqec` PR #894

This is the human-curated review of [PR #894](https://github.com/tqec/tqec/pull/894),
distilled from the v2 raw output (`sample-review-tqec-pr894-v2-raw.md`)
after verifying every behavioural claim against pytest and pytest-timeout
source.

The agent's raw v2 output had to hedge on pytest-timeout's multi-marker
precedence because the library docs don't address it. Looking at pytest source
resolves the ambiguity — and the resolution is **less alarming** than the v1
raw output suggested. This version answers the question rather than
speculating about it.

---

## Verdict: NEEDS_DISCUSSION

Not blocking. One concrete behavioural footgun is worth a brief discussion or
a one-line guard before merging.

## What works

- **The diff is minimal and faithful to the issue.** A single new file
  `tests/conftest.py`, no unrelated changes, behaviour scoped to tests
  carrying the `slow` marker.
- **The dependency is real.** `pyproject.toml` pins
  `pytest-timeout>=2.4.0` under the `test` extra, and the `slow` marker is
  registered in `[tool.pytest.ini_options]`. No "what if it's not installed"
  concern applies here.

## One subtle behavioural footgun

When a slow test **also** carries an explicit `@pytest.mark.timeout(N)`
decorator, the conftest's appended marker is silently ignored — the original
decorator wins. Whether this is desirable depends on author intent:

- A developer who writes `@pytest.mark.timeout(900)` on a particularly heavy
  slow test (because they know 300 s is too short) **gets the behaviour they
  expected**: their 900 is preserved.
- A developer who writes `@pytest.mark.timeout(60)` on a slow test (perhaps
  for debugging, perhaps by accident) **does not get the conftest's 300 s
  bump** — they get 60 s and the slow test fails inside their explicit cap.

### Why this is the actual behaviour, with citations

`add_marker(marker, append: bool = True) -> None` ([pytest source][1]) — the
default is `append=True`, so the conftest's marker lands at the **end** of
the item's `own_markers` list.

`pytest-timeout`'s `_get_item_settings` calls
`item.get_closest_marker("timeout")` ([pytest-timeout source][2]). pytest's
`get_closest_marker` returns `next(self.iter_markers(name=name), default)`
([pytest source][3]). For markers on the same node, `iter_markers` yields them
in the order they were added to `own_markers`, so the explicit decorator —
which was applied at collection time, before this hook runs — comes first
and wins.

[1]: https://github.com/pytest-dev/pytest/blob/main/src/_pytest/nodes.py
[2]: https://github.com/pytest-dev/pytest-timeout/blob/master/pytest_timeout.py
[3]: https://github.com/pytest-dev/pytest/blob/main/src/_pytest/nodes.py

### Suggested fix

Make the intent explicit by guarding on existing timeout markers:

```python
def pytest_collection_modifyitems(items):
    """Increase timeouts for tests marked as slow, unless the test has its
    own explicit timeout marker (which we leave alone)."""
    for item in items:
        if item.get_closest_marker("slow") and not item.get_closest_marker("timeout"):
            item.add_marker(pytest.mark.timeout(SLOW_TEST_TIMEOUT))
```

This is mechanically equivalent to today's behaviour (because the existing
decorator would win anyway) but makes the precedence visible at the call site,
removes any reader confusion about which marker takes effect, and avoids any
dependency on a future pytest-timeout change to multi-marker resolution.

## Coupling worth a comment

The diff increases timeouts only for `slow` tests. The 30 s baseline for
non-slow tests comes from `[tool.pytest.ini_options] timeout = 30` in
`pyproject.toml`, which lives outside this diff. If anyone ever removes that
line, fast tests silently lose all timeouts. A two-line comment in
`conftest.py` pointing at the pyproject setting would make the coupling
discoverable for future maintainers — not a blocker, just a courtesy to the
next person debugging a runaway test.

---

## What was cut from the raw v2 output, and why

| Cut | Reason |
|---|---|
| "Marker ordering / first-vs-last" hedge | Resolved with the citations above. The behaviour is deterministic. |
| "Make `append=True` explicit" | Style nit; default is documented. |
| "`config` parameter omission" | The raw output already noted this is not a bug. Removed to reduce noise. |
| "`SLOW_TEST_TIMEOUT = 300` lacks rationale comment" | True but inconsequential. A heuristic doesn't need defence. |
| "Missing meta-test" | The raw v2 already softened this from v1's "valid nit" to "testing pytest hooks in isolation is unusual" — fully cut here for the same reason. |

What's left is **two findings**: one concrete actionable suggestion (the guard)
and one documentation nudge (the comment about the pyproject baseline). That's
the maintainer-facing version.
