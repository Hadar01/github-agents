"""
Inspect — without executing — which @pytest.mark.timeout marker each test
resolves to under the conftest.py from tqec/tqec PR #894.

This sidesteps the platform-dependent run-time behavior of pytest-timeout
(thread-method on Windows hard-terminates the process, masking the summary).
By using --collect-only and inspecting the marker structure directly, we get
a deterministic transcript that any reviewer can reproduce.

Run it with:

    python verify_precedence.py

Expected output (verified on pytest 8.3.5 + pytest-timeout 2.4.0):

    test_marker_precedence.py::test_explicit_short_timeout_should_win
      all timeout markers found: [(1,), (300,)]
      effective (get_closest_marker): (1,)
    test_marker_precedence.py::test_only_slow_marker_uses_conftest_timeout
      all timeout markers found: [(300,)]
      effective (get_closest_marker): (300,)
    test_marker_precedence.py::test_no_markers_unaffected
      all timeout markers found: []
      effective (get_closest_marker): None

Reading: when both an explicit @pytest.mark.timeout(1) decorator AND the
conftest's appended @pytest.mark.timeout(300) are present, get_closest_marker
returns the (1,) marker — the explicit decorator wins, the appended marker
is silently shadowed. This empirically confirms the citation chain in
sample-review-tqec-pr894-v3-curated.md.
"""

import sys

import pytest


class MarkerInspector:
    """Pytest plugin that prints the resolved timeout marker for each item
    after collection, then lets the run end (via --collect-only)."""

    def pytest_collection_finish(self, session):  # noqa: D401
        print()
        print("=" * 64)
        print("Marker precedence inspection (no tests executed)")
        print("=" * 64)
        for item in session.items:
            timeout_markers = [m.args for m in item.iter_markers(name="timeout")]
            closest = item.get_closest_marker("timeout")
            effective = closest.args if closest else None
            print(f"\n{item.nodeid}")
            print(f"  all timeout markers found: {timeout_markers}")
            print(f"  effective (get_closest_marker): {effective}")
        print()


if __name__ == "__main__":
    sys.exit(
        pytest.main(
            [
                "--collect-only",
                "-q",
                "test_marker_precedence.py",
            ],
            plugins=[MarkerInspector()],
        )
    )
