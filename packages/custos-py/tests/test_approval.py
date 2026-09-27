"""Tests for the ``approval`` core decision outcome (WIRE §2.4)."""
from __future__ import annotations

import json

import pytest

from custos.canonical import dumps as canonical_dumps
from custos.keys import generate_keypair
from custos.ledger import Ledger
from custos.policy import load_policy
from custos.record import Actor, Decision, DecisionRecord, Server
from custos.sdk import Gate
from custos.verify import verify_ledger


def _fresh_gate(tmp_path, policy_dict, actor_id="agent-1"):
    kp = generate_keypair()
    ledger = Ledger(tmp_path / "ledger.jsonl", kp)
    policy = load_policy(policy_dict)
    gate = Gate(
        policy,
        ledger,
        actor=Actor(id=actor_id),
        server=Server(id="test-server"),
        attest=False,  # keep ledger surface small so tests read tightly
    )
    return gate, ledger


def test_approval_records_and_does_not_execute(tmp_path):
    policy_dict = {
        "version": 1,
        "id": "test",
        "default": "deny",
        "rules": [
            {"id": "needs-approval", "when": {"tool": "restart_prod"},
             "decision": "approval", "reason": "prod restart needs a human"},
        ],
    }
    gate, ledger = _fresh_gate(tmp_path, policy_dict)

    ran = []

    def restart_prod():
        ran.append(True)
        return "restarted"

    result = gate.call("restart_prod", {}, fn=restart_prod)

    assert result.decision == Decision.APPROVAL
    assert result.rule == "needs-approval"
    assert ran == [], "approval MUST NOT execute the tool"
    assert result.result is None
    # Record is appended and carries the pending decision
    entries = list(ledger.iter_records())
    assert len(entries) == 1
    rec = entries[0]
    assert rec.decision == Decision.APPROVAL
    assert rec.result_hash == ""
    assert rec.latency_ms == 0
    assert rec.decides_ref == ""  # approval record does not resolve anything
    # Chain + signature verify
    v = verify_ledger(str(ledger.path))
    assert v.ok, v.errors
    assert v.records == 1


def test_advisory_mode_does_not_downgrade_approval(tmp_path):
    """Advisory mode is for DENY only. APPROVAL must still block execution."""
    policy_dict = {
        "version": 1,
        "id": "test",
        "default": "deny",
        "rules": [
            {"id": "needs-approval", "when": {"tool": "restart_prod"},
             "decision": "approval", "reason": "prod restart needs a human"},
        ],
    }
    kp = generate_keypair()
    ledger = Ledger(tmp_path / "ledger.jsonl", kp)
    policy = load_policy(policy_dict)
    gate = Gate(
        policy, ledger,
        actor=Actor(id="agent-1"), server=Server(id="s"),
        advisory=True, attest=False,
    )
    ran = []

    def restart_prod():
        ran.append(True)
        return "restarted"

    result = gate.call("restart_prod", {}, fn=restart_prod)
    assert result.decision == Decision.APPROVAL
    assert ran == [], "advisory mode MUST NOT downgrade APPROVAL to execute"


def test_resolve_approval_writes_follow_up_record(tmp_path):
    policy_dict = {
        "version": 1,
        "id": "test",
        "default": "deny",
        "rules": [
            {"id": "needs-approval", "when": {"tool": "restart_prod"},
             "decision": "approval", "reason": "prod restart needs a human"},
        ],
    }
    gate, ledger = _fresh_gate(tmp_path, policy_dict)

    pending = gate.call("restart_prod", {"host": "web-01"}, fn=lambda **_: "should not run")
    assert pending.decision == Decision.APPROVAL
    approval_hash = pending.record.record_hash
    assert approval_hash and approval_hash.startswith("sha256:")

    resolution = gate.resolve_approval(
        approval_record_hash=approval_hash,
        resolution=Decision.ALLOW,
        reason="approved by oncall via pagerduty",
        tool="restart_prod",
        args={"host": "web-01"},
        trace_id=pending.record.trace_id,
    )

    assert resolution.decision == Decision.ALLOW
    assert resolution.decides_ref == approval_hash
    assert resolution.policy.rule == "human-approval"
    assert resolution.trace_id == pending.record.trace_id

    # Two records, chain verifies, decides_ref survives round-trip
    entries = list(ledger.iter_records())
    assert len(entries) == 2
    v = verify_ledger(str(ledger.path))
    assert v.ok, v.errors
    assert v.records == 2

    # Read the second record's raw wire bytes and confirm decides_ref
    # is present under the canonical body (not just the runtime dataclass)
    line = ledger.path.read_bytes().splitlines()[1]
    parsed = json.loads(line)
    assert parsed["decides_ref"] == approval_hash
    assert parsed["decision"] == "allow"


def test_resolve_approval_rejects_invalid_resolution(tmp_path):
    policy_dict = {
        "version": 1, "id": "test", "default": "deny",
        "rules": [{"id": "r", "when": {"tool": "x"}, "decision": "approval"}],
    }
    gate, _ = _fresh_gate(tmp_path, policy_dict)
    pending = gate.call("x", {}, fn=lambda: None)
    with pytest.raises(ValueError, match="ALLOW or DENY"):
        gate.resolve_approval(
            approval_record_hash=pending.record.record_hash,
            resolution=Decision.APPROVAL,  # nonsense: can't resolve to pending
            reason="bad",
            tool="x", args={}, trace_id=pending.record.trace_id,
        )
    with pytest.raises(ValueError, match="approval_record_hash"):
        gate.resolve_approval(
            approval_record_hash="",
            resolution=Decision.ALLOW,
            reason="missing ref",
            tool="x", args={}, trace_id=pending.record.trace_id,
        )


def test_decides_ref_omitted_on_wire_when_empty(tmp_path):
    """decides_ref is an optional wire field — records without it must
    not emit the key, or old readers break and the hash rules change."""
    policy_dict = {
        "version": 1, "id": "test", "default": "allow", "rules": [],
    }
    gate, ledger = _fresh_gate(tmp_path, policy_dict)
    gate.call("read_file", {"path": "/a"}, fn=lambda path: "ok")
    line = ledger.path.read_bytes().splitlines()[0]
    parsed = json.loads(line)
    assert "decides_ref" not in parsed, (
        "empty decides_ref must not appear on the wire — additive field rule"
    )


def test_approval_record_roundtrips_through_from_dict(tmp_path):
    policy_dict = {
        "version": 1, "id": "test", "default": "deny",
        "rules": [{"id": "r", "when": {"tool": "x"}, "decision": "approval"}],
    }
    gate, ledger = _fresh_gate(tmp_path, policy_dict)
    pending = gate.call("x", {"a": 1}, fn=lambda a: a)
    gate.resolve_approval(
        approval_record_hash=pending.record.record_hash,
        resolution=Decision.DENY,
        reason="rejected by oncall",
        tool="x", args={"a": 1},
        trace_id=pending.record.trace_id,
    )
    # Round-trip both records through from_dict and confirm decides_ref
    # + decision values survive.
    for line in ledger.path.read_bytes().splitlines():
        parsed = json.loads(line)
        rec = DecisionRecord.from_dict(parsed)
        if rec.decides_ref:
            assert rec.decision == Decision.DENY
            assert rec.decides_ref == pending.record.record_hash
        else:
            assert rec.decision == Decision.APPROVAL


def test_proxy_uses_distinct_error_code_for_approval():
    """The proxy exports APPROVAL_CODE = -32002, distinct from DENY_CODE."""
    from custos.proxy import APPROVAL_CODE, DENY_CODE
    assert APPROVAL_CODE == -32002
    assert DENY_CODE == -32001
    assert APPROVAL_CODE != DENY_CODE
