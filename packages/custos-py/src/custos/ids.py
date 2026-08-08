"""Trace/span id generation. ULID for trace ids, 16-hex for span ids."""
from __future__ import annotations

import os
import secrets
import time


_ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def new_trace_id() -> str:
    """Crockford-base32 ULID (26 chars). Sortable, unique."""
    ts_ms = int(time.time() * 1000)
    ts_bytes = ts_ms.to_bytes(6, "big")
    rand = os.urandom(10)
    raw = ts_bytes + rand  # 16 bytes
    # Encode 16 bytes into 26 base32 chars (Crockford)
    bits = int.from_bytes(raw, "big")
    out = [""] * 26
    for i in range(25, -1, -1):
        out[i] = _ULID_ALPHABET[bits & 0x1F]
        bits >>= 5
    return "".join(out)


def new_span_id() -> str:
    return secrets.token_hex(8)


def iso_now_ms() -> str:
    import datetime as _dt
    now = _dt.datetime.now(_dt.timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"
