"""Portable evidence bundle: tar.gz containing ledger + pubkey + policy snapshot + signed manifest."""
from __future__ import annotations

import base64
import hashlib
import io
import json
import tarfile
import time
from pathlib import Path
from typing import Optional

from cryptography.exceptions import InvalidSignature

from custos.canonical import dumps as canonical_dumps
from custos.keys import KeyPair, public_key_from_b64


def create_bundle(
    ledger_path: str | Path,
    pubkey_path: str | Path,
    output_path: str | Path,
    keypair: KeyPair,
    policies_dir: Optional[str | Path] = None,
) -> Path:
    ledger_path = Path(ledger_path)
    pubkey_path = Path(pubkey_path)
    output_path = Path(output_path)

    records = 0
    with ledger_path.open("rb") as f:
        for line in f:
            if line.strip():
                records += 1

    manifest = {
        "v": 1,
        "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "records": records,
        "pubkey": Path(pubkey_path).read_bytes().decode("ascii").strip(),
    }
    manifest_bytes = canonical_dumps(manifest)
    digest = hashlib.sha256(manifest_bytes).digest()
    sig = keypair.sign(digest)
    sig_line = "ed25519:" + base64.b64encode(sig).decode("ascii")

    with tarfile.open(output_path, "w:gz") as tar:
        _add_file(tar, "bundle/manifest.json", manifest_bytes)
        _add_file(tar, "bundle/manifest.sig", sig_line.encode("ascii"))
        _add_file(tar, "bundle/ledger.jsonl", ledger_path.read_bytes())
        _add_file(tar, "bundle/ledger.pub", pubkey_path.read_bytes())
        if policies_dir:
            pd = Path(policies_dir)
            for p in pd.rglob("*"):
                if p.is_file():
                    rel = p.relative_to(pd)
                    _add_file(tar, f"bundle/policies/{rel.as_posix()}", p.read_bytes())
    return output_path


def _add_file(tar: tarfile.TarFile, name: str, data: bytes) -> None:
    info = tarfile.TarInfo(name=name)
    info.size = len(data)
    info.mtime = int(time.time())
    tar.addfile(info, io.BytesIO(data))


def verify_bundle(path: str | Path) -> dict:
    """Return {ok, records, errors} after verifying manifest signature and ledger chain."""
    from custos.verify import verify_ledger

    path = Path(path)
    with tarfile.open(path, "r:gz") as tar:
        manifest_b = _read_member(tar, "bundle/manifest.json")
        sig_b = _read_member(tar, "bundle/manifest.sig").decode("ascii").strip()
        ledger_b = _read_member(tar, "bundle/ledger.jsonl")
        pub_b = _read_member(tar, "bundle/ledger.pub").decode("ascii").strip()

    manifest = json.loads(manifest_b)
    pub = public_key_from_b64(pub_b)
    digest = hashlib.sha256(canonical_dumps(manifest)).digest()
    if not sig_b.startswith("ed25519:"):
        return {"ok": False, "records": 0, "errors": ["manifest sig format invalid"]}
    try:
        pub.verify(base64.b64decode(sig_b.split(":", 1)[1]), digest)
    except InvalidSignature:
        return {"ok": False, "records": 0, "errors": ["manifest signature invalid"]}

    # Extract to temp files and reuse verifier
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        (tdp / "ledger.jsonl").write_bytes(ledger_b)
        (tdp / "ledger.pub").write_bytes(pub_b.encode("ascii"))
        r = verify_ledger(tdp / "ledger.jsonl", tdp / "ledger.pub")
    return {"ok": r.ok, "records": r.records, "errors": r.errors, "manifest": manifest}


def _read_member(tar: tarfile.TarFile, name: str) -> bytes:
    m = tar.getmember(name)
    f = tar.extractfile(m)
    assert f is not None
    return f.read()
