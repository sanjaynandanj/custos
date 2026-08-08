"""Canonical JSON serialization compatible with the Custos wire spec.

Rules (see spec/WIRE.md §1):
  - UTF-8, no BOM
  - Keys sorted lexicographically at every depth
  - No insignificant whitespace
  - ensure_ascii=False (raw UTF-8)
  - allow_nan=False (strict JSON)
"""
from __future__ import annotations

import json
from typing import Any


def dumps(value: Any) -> bytes:
    """Serialize to Canonical JSON bytes."""
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")


def loads(data: bytes | str) -> Any:
    """Parse JSON (canonical or not) into Python."""
    if isinstance(data, bytes):
        data = data.decode("utf-8")
    return json.loads(data)
