"""Append-only signed hash-chained ledger."""
from __future__ import annotations

import base64
import hashlib
import os
import threading
from pathlib import Path
from typing import Iterator, List, Optional

from custos.canonical import dumps as canonical_dumps
from custos.ids import iso_now_ms, new_span_id, new_trace_id
from custos.keys import KeyPair
from custos.record import AttestationRecord, DecisionRecord, GENESIS_PREV_HASH


class LedgerError(Exception):
    pass


def _sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def hash_of_value(value) -> str:
    """sha256:<hex> of Canonical JSON of a Python value."""
    return "sha256:" + _sha256_hex(canonical_dumps(value))


def _seal(record: DecisionRecord, keypair: KeyPair) -> None:
    body = canonical_dumps(record.to_body())
    record_hash = "sha256:" + _sha256_hex(body)
    record.record_hash = record_hash
    digest_bytes = bytes.fromhex(record_hash.split(":", 1)[1])
    sig = keypair.sign(digest_bytes)
    record.sig = "ed25519:" + base64.b64encode(sig).decode("ascii")


class Ledger:
    """Append-only JSONL ledger, one file per instance.

    Thread-safe within a process. Cross-process concurrency: open a single
    Ledger per process, or serialize through an external queue.
    """

    def __init__(self, path: str | Path, keypair: KeyPair):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.keypair = keypair
        self._lock = threading.Lock()
        self._seq, self._prev_hash = self._recover_tail()
        # write pubkey sidecar
        pub_path = self.path.parent / (self.path.stem + ".pub")
        pub_path.write_bytes(self.keypair.public_b64().encode("ascii"))

    def _recover_tail(self) -> tuple[int, str]:
        if not self.path.exists() or self.path.stat().st_size == 0:
            return 0, GENESIS_PREV_HASH
        with self.path.open("rb") as f:
            try:
                f.seek(-4096, os.SEEK_END)
            except OSError:
                f.seek(0)
            tail = f.read().splitlines()
        for line in reversed(tail):
            if not line.strip():
                continue
            import json
            rec = json.loads(line)
            return rec["seq"] + 1, rec["record_hash"]
        return 0, GENESIS_PREV_HASH

    def append(self, record: DecisionRecord) -> DecisionRecord:
        with self._lock:
            record.seq = self._seq
            record.prev_hash = self._prev_hash
            _seal(record, self.keypair)
            line = canonical_dumps(record.to_full()) + b"\n"
            with self.path.open("ab") as f:
                f.write(line)
                f.flush()
                try:
                    os.fsync(f.fileno())
                except OSError:
                    pass
            self._seq += 1
            self._prev_hash = record.record_hash  # type: ignore[assignment]
            return record

    def append_attestation(
        self,
        reason: str,
        custos_version: str,
        policy_hash: str = "",
        active_actors: Optional[list] = None,
        uptime_ms: int = 0,
        trace_id: Optional[str] = None,
    ) -> AttestationRecord:
        """Append a signed attestation record to the chain (WIRE §2.3).

        Attestations share the ledger's hash chain and signing key with
        decisions, so a verifier reading the same file gets a single
        timeline of "what the control was doing and whether it was
        alive." No separate transport, no separate key, no separate
        integrity story.
        """
        record = AttestationRecord(
            v=1,
            seq=0,  # filled in below
            ts=iso_now_ms(),
            trace_id=trace_id or new_trace_id(),
            span_id=new_span_id(),
            prev_hash="",  # filled in below
            reason=reason,
            custos_version=custos_version,
            policy_hash=policy_hash,
            active_actors=list(active_actors or []),
            uptime_ms=uptime_ms,
        )
        with self._lock:
            record.seq = self._seq
            record.prev_hash = self._prev_hash
            body = canonical_dumps(record.to_body())
            record_hash = "sha256:" + _sha256_hex(body)
            record.record_hash = record_hash
            digest = bytes.fromhex(record_hash.split(":", 1)[1])
            sig = self.keypair.sign(digest)
            record.sig = "ed25519:" + base64.b64encode(sig).decode("ascii")
            line = canonical_dumps(record.to_full()) + b"\n"
            with self.path.open("ab") as f:
                f.write(line)
                f.flush()
                try:
                    os.fsync(f.fileno())
                except OSError:
                    pass
            self._seq += 1
            self._prev_hash = record_hash
            return record

    def iter_records(self) -> Iterator[DecisionRecord]:
        if not self.path.exists():
            return
        import json
        with self.path.open("rb") as f:
            for line in f:
                if not line.strip():
                    continue
                yield DecisionRecord.from_dict(json.loads(line))

    @property
    def seq(self) -> int:
        return self._seq

    @property
    def head(self) -> str:
        return self._prev_hash
