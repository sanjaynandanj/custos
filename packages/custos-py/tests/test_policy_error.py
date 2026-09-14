"""WIRE §7: policy engine errors deny by default and record a reason.

A throwing policy must NOT bubble out of the enforcement path with no
record — that reproduces the exact silent-down failure mode Custos exists
to detect.
"""
from __future__ import annotations

import pytest

from custos.keys import generate_keypair
from custos.ledger import Ledger
from custos.policy import Policy
from custos.record import Actor, Decision, Server
from custos.sdk import Gate
from custos.verify import verify_ledger


class ThrowingPolicy(Policy):
    def __init__(self):
        super().__init__(version=1, id="throwing", default=Decision.DENY, rules=[])

    def evaluate(self, ctx):  # noqa: ARG002
        raise RuntimeError("simulated engine failure")


@pytest.fixture()
def gate(tmp_path):
    kp = generate_keypair()
    kp.save(tmp_path)
    ledger = Ledger(tmp_path / "ledger.jsonl", kp)
    return tmp_path, Gate(
        policy=ThrowingPolicy(),
        ledger=ledger,
        actor=Actor("agent-1"),
        server=Server("srv"),
        attest=False,
    )


def test_call_records_error_and_skips_fn(gate):
    tmp_path, g = gate
    ran = []
    r = g.call("read", {"path": "/x"}, fn=lambda path: (ran.append(1) or "nope"))
    assert not ran
    assert r.decision == Decision.ERROR
    assert not r.allowed
    assert "policy engine error" in r.reason
    assert r.record.decision == Decision.ERROR
    assert r.record.enforcement.effect == "blocked"
    v = verify_ledger(tmp_path / "ledger.jsonl", tmp_path / "ledger.pub")
    assert v.ok
    assert v.records >= 1


def test_advisory_does_not_downgrade_engine_error_to_allow(tmp_path):
    kp = generate_keypair()
    kp.save(tmp_path)
    ledger = Ledger(tmp_path / "ledger.jsonl", kp)
    g = Gate(
        policy=ThrowingPolicy(),
        ledger=ledger,
        actor=Actor("a"),
        server=Server("s"),
        advisory=True,
        attest=False,
    )
    ran = []
    r = g.call("t", {}, fn=lambda: ran.append(1))
    assert not ran
    assert r.decision == Decision.ERROR
    assert not r.allowed


def test_check_surfaces_error_without_ledger_write(gate):
    tmp_path, g = gate
    before = verify_ledger(tmp_path / "ledger.jsonl", tmp_path / "ledger.pub").records
    r = g.check("read", {"path": "/x"})
    assert r.decision == Decision.ERROR
    assert "policy engine error" in r.reason
    after = verify_ledger(tmp_path / "ledger.jsonl", tmp_path / "ledger.pub").records
    assert after == before


@pytest.mark.asyncio
async def test_acall_records_error_and_skips_fn(gate):
    tmp_path, g = gate
    ran = []

    async def fn(**_):
        ran.append(1)
        return "nope"

    r = await g.acall("read", {"path": "/x"}, fn=fn)
    assert not ran
    assert r.decision == Decision.ERROR
    assert not r.allowed
    assert "policy engine error" in r.reason
