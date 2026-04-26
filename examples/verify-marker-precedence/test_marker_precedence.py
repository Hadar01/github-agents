"""
Empirical verification of the marker-precedence claim made in
`examples/sample-review-tqec-pr894-v3-curated.md`.

The curated review claims:

    When a slow test also carries an explicit @pytest.mark.timeout(N)
    decorator, the conftest's appended marker is silently ignored — the
    original decorator wins.

This file proves that runtime, not just from source-reading.

Three tests:

1. test_explicit_short_timeout_should_win
   Has @pytest.mark.slow AND @pytest.mark.timeout(1). Sleeps 2 seconds.
   - If the explicit 1s decorator wins → this test FAILS with a Timeout.
   - If the conftest's appended 300s wins → this test PASSES.

2. test_only_slow_marker_uses_conftest_timeout
   Has only @pytest.mark.slow, sleeps 2 seconds. Should always pass:
   conftest's 300s applies, 2 < 300.

3. test_no_markers_unaffected
   Bare test. No timeout marker. No conftest hook applies. Passes trivially.

Expected outcome on POSIX (Linux/macOS): 1 failed (timeouted), 2 passed.
The failed test is the proof that the explicit decorator survives the hook.

Expected outcome on Windows: pytest-timeout's default `--timeout-method=thread`
hard-terminates the process via os._exit(1) on the first timeout, so tests 2
and 3 may never report. For a deterministic transcript on every platform, run
`python verify_precedence.py` instead — it inspects the resolved markers via
--collect-only and never executes the test bodies.
"""
import time

import pytest


@pytest.mark.slow
@pytest.mark.timeout(1)
def test_explicit_short_timeout_should_win() -> None:
    """Sleep 2s. Times out at 1s if the explicit decorator wins."""
    time.sleep(2)


@pytest.mark.slow
def test_only_slow_marker_uses_conftest_timeout() -> None:
    """No explicit timeout — conftest's 300s applies, 2s sleep passes."""
    time.sleep(2)


def test_no_markers_unaffected() -> None:
    """Bare test, conftest hook does nothing for it."""
    assert True
