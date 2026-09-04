"""Tests for per-call attestation tokens (WIRE §8)."""
import pytest

from custos.keys import generate_keypair, public_key_from_b64
from custos.token import (
    TOKEN_PREFIX, TokenError, generate_token, verify_token,
)


def test_generate_and_verify_roundtrip():
    """The most basic contract: a token signed by kp verifies against kp
    and returns the exact fields signed. This is what a cooperating tool
    server relies on to prove a call passed through Custos."""
    kp = generate_keypair()
    token = generate_token(
        keypair=kp,
        trace_id="01HXYZ",
        span_id="abc123def456",
        tool="read_file",
        args_hash="sha256:aaaa",
        ts="2026-08-08T12:34:56.789Z",
    )
    assert token.startswith(TOKEN_PREFIX)

    pub = public_key_from_b64(kp.public_b64())
    v = verify_token(pub, token)
    assert v.payload.trace_id == "01HXYZ"
    assert v.payload.span_id == "abc123def456"
    assert v.payload.tool == "read_file"
    assert v.payload.args_hash == "sha256:aaaa"
    assert v.payload.ts == "2026-08-08T12:34:56.789Z"
    assert v.payload.kid  # non-empty fingerprint


def test_verify_rejects_wrong_key():
    """A token signed by kp1 MUST NOT verify against kp2. This is what
    prevents an unattested caller from forging attestation."""
    kp1 = generate_keypair()
    kp2 = generate_keypair()
    token = generate_token(kp1, "t", "s", "read", "sha256:x", "2026-01-01T00:00:00.000Z")
    with pytest.raises(TokenError):
        verify_token(public_key_from_b64(kp2.public_b64()), token)


def test_verify_rejects_tampered_payload():
    """Flipping any byte in the payload MUST fail signature check —
    that's what makes the token evidence rather than opinion."""
    kp = generate_keypair()
    token = generate_token(kp, "t", "s", "read", "sha256:x", "2026-01-01T00:00:00.000Z")
    prefix, rest = token[: len(TOKEN_PREFIX)], token[len(TOKEN_PREFIX):]
    payload_b64, sig_b64 = rest.split(".", 1)
    # Corrupt one character deep in the payload — decodes to different
    # bytes, so sig no longer matches.
    tampered = prefix + payload_b64[:10] + ("A" if payload_b64[10] != "A" else "B") + payload_b64[11:] + "." + sig_b64
    with pytest.raises(TokenError):
        verify_token(public_key_from_b64(kp.public_b64()), tampered)


def test_verify_rejects_malformed_tokens():
    """Any structural corruption is rejected cleanly, not with a crash."""
    kp = generate_keypair()
    pub = public_key_from_b64(kp.public_b64())
    with pytest.raises(TokenError):
        verify_token(pub, "not-a-custos-token")
    with pytest.raises(TokenError):
        verify_token(pub, TOKEN_PREFIX + "no-dot-here")
    with pytest.raises(TokenError):
        verify_token(pub, TOKEN_PREFIX + "!!!.???")


def test_gate_allow_populates_token_on_result(tmp_path):
    """The primary integration: gate.call(...).token is a valid token
    whenever the decision was allow. Tool servers pull this string out
    and forward it in `_meta.custos_token` (proxy does that
    automatically; SDK users do it themselves for HTTP transports)."""
    from custos.ledger import Ledger
    from custos.policy import load_policy
    from custos.record import Actor, Server
    from custos.sdk import Gate

    kp = generate_keypair()
    kp.save(tmp_path)
    ledger = Ledger(tmp_path / "ledger.jsonl", kp)
    policy = load_policy({
        "version": 1, "default": "deny",
        "rules": [{"id": "allow-read", "when": {"tool": "read"}, "decision": "allow"}],
    })
    gate = Gate(policy, ledger, Actor("a"), Server("s"))

    allowed = gate.call("read", {"i": 0}, fn=lambda i: i)
    assert allowed.allowed and allowed.token, "allow must ship a token"
    v = verify_token(public_key_from_b64(kp.public_b64()), allowed.token)
    assert v.payload.tool == "read"
    assert v.payload.trace_id == allowed.record.trace_id
    assert v.payload.args_hash == allowed.record.args_hash

    denied = gate.call("write", {"i": 0}, fn=lambda i: i)
    assert not denied.allowed
    assert denied.token == "", "deny must NOT ship a token"
