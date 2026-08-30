"""Guard against drift between ``custos.__version__`` and ``pyproject.toml``.

Kept dependency-free: parses the ``version = "..."`` line with a regex so it
works on any Python 3.10+ without requiring ``tomli`` and without depending on
``tomllib`` being present.
"""

from __future__ import annotations

import re
from pathlib import Path

import custos


def _pyproject_version() -> str:
    root = Path(__file__).resolve().parents[1]
    text = (root / "pyproject.toml").read_text(encoding="utf-8")
    match = re.search(r'^version\s*=\s*"([^"]+)"', text, re.M)
    assert match is not None, "could not find version in pyproject.toml"
    return match.group(1)


def test_version_matches_pyproject() -> None:
    assert custos.__version__ == _pyproject_version()
