from pathlib import Path

import pytest

from custos.keys import generate_keypair
from custos.ledger import Ledger
from custos.policy import load_policy
from custos.record import Actor, Server
from custos.sdk import Gate
from custos.verify import verify_ledger


@pytest.fixture()
def workdir(tmp_path):
    kp = generate_keypair()
    kp.save(tmp_path)
    ledger = Ledger(tmp_path / "ledger.jsonl", kp)
    policy = load_policy({
        "version": 1, "default": "deny",
        "rules": [
            {"id": "allow-read", "when": {"tool": "read"}, "decision": "allow"},
        ],
    })
    gate = Gate(policy=policy, ledger=ledger, actor=Actor("agent-1"), server=Server("srv"))
    return tmp_path, gate


def test_gate_allow_and_verify(workdir):
    tmp_path, gate = workdir
    r = gate.call("read", {"path": "/tmp/x"}, fn=lambda path: f"contents of {path}")
    assert r.allowed
    assert r.result == "contents of /tmp/x"

    r2 = gate.call("write", {"path": "/tmp/x"}, fn=lambda path: None)
    assert not r2.allowed

    for _ in range(5):
        gate.call("read", {"path": "/a"}, fn=lambda path: "ok")

    v = verify_ledger(tmp_path / "ledger.jsonl", tmp_path / "ledger.pub")
    assert v.ok, v.errors
    assert v.records == 7  # 1 allow + 1 deny + 5 allows


def test_tamper_detected(workdir):
    tmp_path, gate = workdir
    for i in range(3):
        gate.call("read", {"i": i}, fn=lambda i: i)

    # Tamper: flip a byte in the middle of the file
    p = tmp_path / "ledger.jsonl"
    data = bytearray(p.read_bytes())
    # find first "allow" occurrence and mutate to "deny "
    idx = data.find(b'"allow"')
    assert idx > 0
    data[idx : idx + 7] = b'"deny "'
    p.write_bytes(bytes(data))

    v = verify_ledger(p, tmp_path / "ledger.pub")
    assert not v.ok
    assert any("record_hash" in e or "sig" in e or "seq" in e for e in v.errors)
