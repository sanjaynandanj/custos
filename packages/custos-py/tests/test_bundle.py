import io
import tarfile

from custos.bundle import create_bundle, verify_bundle
from custos.keys import generate_keypair
from custos.ledger import Ledger
from custos.policy import load_policy
from custos.record import Actor, Server
from custos.sdk import Gate


def test_bundle_roundtrip(tmp_path):
    kp = generate_keypair()
    kp.save(tmp_path)
    ledger = Ledger(tmp_path / "ledger.jsonl", kp)
    policy = load_policy({"version": 1, "default": "allow", "rules": []})
    gate = Gate(policy, ledger, Actor("a1"), Server("s1"))
    for i in range(3):
        gate.call("t", {"i": i}, fn=lambda i: i)

    out = tmp_path / "bundle.tar.gz"
    create_bundle(tmp_path / "ledger.jsonl", tmp_path / "ledger.pub", out, kp)

    r = verify_bundle(out)
    assert r["ok"], r["errors"]
    # 1 startup attestation (Gate init) + 3 gate.call decisions.
    assert r["records"] == 4


def test_bundle_policy_tamper(tmp_path):
    """Swapping a policy file after signing must be caught via policies_hash."""
    kp = generate_keypair()
    kp.save(tmp_path)
    ledger = Ledger(tmp_path / "ledger.jsonl", kp)
    policy = load_policy({"version": 1, "default": "allow", "rules": []})
    gate = Gate(policy, ledger, Actor("a1"), Server("s1"))
    gate.call("t", {"i": 0}, fn=lambda i: i)

    policies_dir = tmp_path / "policies"
    # Auto-snapshot from Gate() may have already created this dir; that's
    # fine — this test's manual write is orthogonal to the snapshot file.
    policies_dir.mkdir(exist_ok=True)
    (policies_dir / "policy.yaml").write_text(
        "version: 1\ndefault: allow\nrules: []\n", encoding="utf-8"
    )

    bundle_path = tmp_path / "bundle.tar.gz"
    create_bundle(
        tmp_path / "ledger.jsonl",
        tmp_path / "ledger.pub",
        bundle_path,
        kp,
        policies_dir=policies_dir,
    )

    # Sanity: fresh bundle verifies cleanly and manifest has policies_hash.
    fresh = verify_bundle(bundle_path)
    assert fresh["ok"], fresh["errors"]
    assert "policies_hash" in fresh["manifest"]

    # Now rewrite the tarball with a mutated policy file (manifest+sig kept).
    with tarfile.open(bundle_path, "r:gz") as tar:
        members = tar.getmembers()
        data = {m.name: (tar.extractfile(m).read() if m.isfile() else b"") for m in members}
    data["bundle/policies/policy.yaml"] = b"version: 1\ndefault: deny\nrules: []\n"

    tampered = tmp_path / "tampered.tar.gz"
    with tarfile.open(tampered, "w:gz") as tar:
        for m in members:
            if not m.isfile():
                continue
            info = tarfile.TarInfo(name=m.name)
            info.size = len(data[m.name])
            info.mtime = m.mtime
            tar.addfile(info, io.BytesIO(data[m.name]))

    r = verify_bundle(tampered)
    assert not r["ok"]
    assert any("policies_hash" in e for e in r["errors"])


def test_gate_snapshots_policy_and_bundle_auto_picks_it_up(tmp_path):
    """Gate() should snapshot the active policy into <ledger>/../policies/
    on construction, so an evidence bundle produced with no explicit
    policies_dir still preserves the exact policy source that produced every
    record. Reviewer's ask: reconstruct decisions six months later."""
    kp = generate_keypair()
    kp.save(tmp_path)
    ledger = Ledger(tmp_path / "ledger.jsonl", kp)
    policy = load_policy({"version": 1, "id": "t", "default": "allow", "rules": []})
    gate = Gate(policy, ledger, Actor("a1"), Server("s1"))

    hex_hash = policy.hash.split(":", 1)[1]
    snapshot = tmp_path / "policies" / f"{hex_hash}.json"
    assert snapshot.exists(), f"expected snapshot at {snapshot}"
    assert snapshot.read_bytes() == policy.source_bytes

    # Need at least one record before bundling — Ledger creates the file
    # on first append, not on construction.
    gate.call("t", {"i": 0}, fn=lambda i: i)

    # Bundle auto-discovers <ledger>/../policies/ and pulls the snapshot in.
    out = tmp_path / "bundle.tar.gz"
    create_bundle(tmp_path / "ledger.jsonl", tmp_path / "ledger.pub", out, kp)
    r = verify_bundle(out)
    assert r["ok"], r["errors"]
    assert "policies_hash" in r["manifest"]

    with tarfile.open(out, "r:gz") as tar:
        names = [m.name for m in tar.getmembers()]
    assert f"bundle/policies/{hex_hash}.json" in names


def test_multiple_policy_versions_all_preserved_in_bundle(tmp_path):
    """When policy is rotated mid-ledger, the bundle must contain a
    snapshot for EACH distinct policy.hash referenced by the records.
    Otherwise the reviewer's core concern — reconstruct which policy was
    live for record N — remains unanswered for old records."""
    kp = generate_keypair()
    kp.save(tmp_path)
    ledger = Ledger(tmp_path / "ledger.jsonl", kp)

    # First policy: allow all.
    p1 = load_policy({"version": 1, "id": "t", "default": "allow", "rules": []})
    g1 = Gate(p1, ledger, Actor("a1"), Server("s1"))
    g1.call("t", {"i": 0}, fn=lambda i: i)

    # Rotate to a stricter policy — new Gate, same ledger.
    p2 = load_policy({"version": 1, "id": "t", "default": "deny", "rules": []})
    assert p1.hash != p2.hash
    g2 = Gate(p2, ledger, Actor("a1"), Server("s1"))
    g2.call("t", {"i": 1}, fn=lambda i: i)  # will be denied

    hex1 = p1.hash.split(":", 1)[1]
    hex2 = p2.hash.split(":", 1)[1]

    out = tmp_path / "bundle.tar.gz"
    create_bundle(tmp_path / "ledger.jsonl", tmp_path / "ledger.pub", out, kp)

    with tarfile.open(out, "r:gz") as tar:
        names = set(m.name for m in tar.getmembers())
    assert f"bundle/policies/{hex1}.json" in names
    assert f"bundle/policies/{hex2}.json" in names

    r = verify_bundle(out)
    assert r["ok"], r["errors"]
    # 2 Gates × 1 startup attestation + 2 gate.call decisions.
    assert r["records"] == 4
