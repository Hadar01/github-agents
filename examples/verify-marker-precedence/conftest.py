# Mirror of tests/conftest.py from tqec/tqec PR #894 — kept here verbatim
# (modulo formatting) so the empirical test in this directory exercises the
# exact behavior under review.
#
# Source: https://github.com/tqec/tqec/pull/894/files
import pytest

SLOW_TEST_TIMEOUT = 300


def pytest_collection_modifyitems(items):
    """Increase timeouts for tests marked as slow."""
    for item in items:
        if item.get_closest_marker("slow"):
            item.add_marker(pytest.mark.timeout(SLOW_TEST_TIMEOUT))
