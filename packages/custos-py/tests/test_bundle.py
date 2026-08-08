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
    assert r["records"] == 3
