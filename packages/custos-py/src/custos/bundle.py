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


def _compute_policies_hash(policy_files: list[tuple[str, bytes]]) -> str:
    """Compute the ``policies_hash`` value for a set of (basename, bytes) pairs.

    Algorithm (see spec/WIRE.md §5):
      1. Sort by basename lexicographically.
      2. For each file, sha256(bytes).hexdigest().
      3. Canonical JSON of [{"name": <basename>, "sha256": <hex>}, ...].
      4. sha256 of that canonical bytes, hex-encoded, prefixed with "sha256:".
    """
    entries = sorted(
        (
            {"name": name, "sha256": hashlib.sha256(data).hexdigest()}
            for name, data in policy_files
        ),
        key=lambda e: e["name"],
    )
    canonical = canonical_dumps(entries)
    return "sha256:" + hashlib.sha256(canonical).hexdigest()


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

    # Gather policy files (if any) so we can both embed them AND commit to
    # their contents via the manifest's optional ``policies_hash`` field.
    #
    # v0.4.0: if no explicit policies_dir is passed, look for
    # ``<ledger.parent>/policies/`` — the default directory the Gate SDK
    # snapshots content-addressed policy files into. This preserves every
    # policy version referenced by any record in the ledger, not just the
    # latest. See spec/WIRE.md §5.1.
    policy_entries: list[tuple[str, str, bytes]] = []  # (tar_name, basename, data)
    if policies_dir is None:
        default = ledger_path.parent / "policies"
        if default.is_dir():
            policies_dir = default
    if policies_dir:
        pd = Path(policies_dir)
        if pd.is_dir():
            for p in sorted(pd.rglob("*")):
                if p.is_file():
                    rel = p.relative_to(pd)
                    policy_entries.append(
                        (f"bundle/policies/{rel.as_posix()}", rel.as_posix(), p.read_bytes())
                    )

    manifest = {
        "v": 1,
        "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "records": records,
        "pubkey": Path(pubkey_path).read_bytes().decode("ascii").strip(),
    }
    # Added in v0.3.0 — optional; verifiers that see it MUST enforce it, but
    # bundles produced before this field existed remain valid.
    if policy_entries:
        manifest["policies_hash"] = _compute_policies_hash(
            [(name, data) for (_tn, name, data) in policy_entries]
        )
    manifest_bytes = canonical_dumps(manifest)
    digest = hashlib.sha256(manifest_bytes).digest()
    sig = keypair.sign(digest)
    sig_line = "ed25519:" + base64.b64encode(sig).decode("ascii")

    with tarfile.open(output_path, "w:gz") as tar:
        _add_file(tar, "bundle/manifest.json", manifest_bytes)
        _add_file(tar, "bundle/manifest.sig", sig_line.encode("ascii"))
        _add_file(tar, "bundle/ledger.jsonl", ledger_path.read_bytes())
        _add_file(tar, "bundle/ledger.pub", pubkey_path.read_bytes())
        for tar_name, _basename, data in policy_entries:
            _add_file(tar, tar_name, data)
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
    policy_members: list[tuple[str, bytes]] = []  # (basename, data)
    with tarfile.open(path, "r:gz") as tar:
        manifest_b = _read_member(tar, "bundle/manifest.json")
        sig_b = _read_member(tar, "bundle/manifest.sig").decode("ascii").strip()
        ledger_b = _read_member(tar, "bundle/ledger.jsonl")
        pub_b = _read_member(tar, "bundle/ledger.pub").decode("ascii").strip()
        # Collect any embedded policies for optional policies_hash check.
        for m in tar.getmembers():
            if m.isfile() and m.name.startswith("bundle/policies/"):
                f = tar.extractfile(m)
                if f is not None:
                    policy_members.append((m.name[len("bundle/policies/"):], f.read()))

    manifest = json.loads(manifest_b)
    pub = public_key_from_b64(pub_b)
    digest = hashlib.sha256(canonical_dumps(manifest)).digest()
    if not sig_b.startswith("ed25519:"):
        return {"ok": False, "records": 0, "errors": ["manifest sig format invalid"]}
    try:
        pub.verify(base64.b64decode(sig_b.split(":", 1)[1]), digest)
    except InvalidSignature:
        return {"ok": False, "records": 0, "errors": ["manifest signature invalid"]}

    # Optional policies_hash enforcement (added in v0.3.0). Absent → skip
    # (backwards compat with older bundles).
    if "policies_hash" in manifest:
        recomputed = _compute_policies_hash(policy_members)
        if recomputed != manifest["policies_hash"]:
            return {
                "ok": False,
                "records": 0,
                "errors": [
                    f"policies_hash mismatch: manifest={manifest['policies_hash']} "
                    f"recomputed={recomputed}"
                ],
                "manifest": manifest,
            }

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
