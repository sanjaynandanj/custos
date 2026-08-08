"""Offline ledger verification."""
from __future__ import annotations

import base64
import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from custos.canonical import dumps as canonical_dumps
from custos.keys import public_key_from_b64
from custos.record import GENESIS_PREV_HASH


@dataclass
class VerifyResult:
    ok: bool
    records: int
    errors: List[str] = field(default_factory=list)


def verify_ledger(ledger_path: str | Path, pubkey_path: Optional[str | Path] = None) -> VerifyResult:
    ledger_path = Path(ledger_path)
    if pubkey_path is None:
        pubkey_path = ledger_path.parent / (ledger_path.stem + ".pub")
    pubkey_b64 = Path(pubkey_path).read_bytes().decode("ascii").strip()
    pub = public_key_from_b64(pubkey_b64)

    errors: List[str] = []
    expected_seq = 0
    expected_prev = GENESIS_PREV_HASH
    count = 0

    if not ledger_path.exists():
        return VerifyResult(ok=False, records=0, errors=["ledger file not found"])

    with ledger_path.open("rb") as f:
        for line_no, raw in enumerate(f, start=1):
            if not raw.strip():
                continue
            try:
                rec = json.loads(raw)
            except Exception as e:
                errors.append(f"line {line_no}: invalid JSON: {e}")
                return VerifyResult(ok=False, records=count, errors=errors)
            # sequence check
            if rec.get("seq") != expected_seq:
                errors.append(f"line {line_no}: seq mismatch (got {rec.get('seq')}, expected {expected_seq})")
                return VerifyResult(ok=False, records=count, errors=errors)
            # prev_hash check
            if rec.get("prev_hash") != expected_prev:
                errors.append(
                    f"line {line_no}: prev_hash mismatch (got {rec.get('prev_hash')}, expected {expected_prev})"
                )
                return VerifyResult(ok=False, records=count, errors=errors)
            # recompute record_hash
            body = {k: v for k, v in rec.items() if k not in ("record_hash", "sig")}
            body_bytes = canonical_dumps(body)
            computed = "sha256:" + hashlib.sha256(body_bytes).hexdigest()
            if computed != rec.get("record_hash"):
                errors.append(
                    f"line {line_no}: record_hash mismatch (computed {computed}, stored {rec.get('record_hash')})"
                )
                return VerifyResult(ok=False, records=count, errors=errors)
            # verify signature
            sig_val = rec.get("sig", "")
            if not sig_val.startswith("ed25519:"):
                errors.append(f"line {line_no}: sig format invalid")
                return VerifyResult(ok=False, records=count, errors=errors)
            try:
                sig_bytes = base64.b64decode(sig_val.split(":", 1)[1])
                digest = bytes.fromhex(computed.split(":", 1)[1])
                pub.verify(sig_bytes, digest)
            except InvalidSignature:
                errors.append(f"line {line_no}: invalid signature")
                return VerifyResult(ok=False, records=count, errors=errors)
            except Exception as e:
                errors.append(f"line {line_no}: sig verify error: {e}")
                return VerifyResult(ok=False, records=count, errors=errors)
            expected_seq += 1
            expected_prev = computed
            count += 1

    return VerifyResult(ok=True, records=count, errors=[])
