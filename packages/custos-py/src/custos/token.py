"""Per-call attestation tokens (WIRE §8, added in v0.4.0).

A **call attestation token** is a tiny, self-contained proof that a
specific tool call passed the Custos gate. The proxy (or SDK) generates
one on every ``allow`` decision and injects it into the forwarded call's
``_meta.custos_token``. A cooperating tool server verifies the token
before executing and logs verified / rejected / unattested calls.

The point is exactly what the GRC reviewer named: without downstream
cooperation, the Custos ledger proves properties about the calls that
reached it — not that those were all the calls. Attestation tokens
close that gap: cross-checking the tool server's "verified /
unattested" log against the Custos ledger proves coverage
cryptographically.

Token format (URL-safe, no padding):

    custos:v1:<b64url(canonical_json(payload))>.<b64url(ed25519_sig)>

Payload fields:

    trace_id   ULID / hex trace identifier (matches DecisionRecord)
    span_id    per-call hex identifier
    tool       tool name
    args_hash  sha256:<hex> of canonical JSON of args (matches record)
    ts         RFC3339 UTC millisecond timestamp
    kid        base64 public-key fingerprint (first 8 bytes of sha256)

``kid`` lets a verifier accept tokens from multiple issuers — the tool
side keeps a mapping of ``kid → pubkey`` and picks the right key
without trial-and-error. It is not required for security; the sig
alone binds the payload.
"""
from __future__ import annotations

import base64
import hashlib
import json
from dataclasses import dataclass
from typing import TYPE_CHECKING

from cryptography.exceptions import InvalidSignature

from custos.canonical import dumps as canonical_dumps
from custos.keys import KeyPair

if TYPE_CHECKING:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey


TOKEN_PREFIX = "custos:v1:"


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def _kid(pubkey_bytes: bytes) -> str:
    """8-byte fingerprint of the public key, base64url-encoded (no pad)."""
    return _b64url_encode(hashlib.sha256(pubkey_bytes).digest()[:8])


@dataclass
class TokenPayload:
    trace_id: str
    span_id: str
    tool: str
    args_hash: str
    ts: str
    kid: str

    def to_dict(self) -> dict:
        return {
            "trace_id": self.trace_id,
            "span_id": self.span_id,
            "tool": self.tool,
            "args_hash": self.args_hash,
            "ts": self.ts,
            "kid": self.kid,
        }


def generate_token(
    keypair: KeyPair,
    trace_id: str,
    span_id: str,
    tool: str,
    args_hash: str,
    ts: str,
) -> str:
    """Sign a per-call attestation token. Returns the full token string."""
    payload = TokenPayload(
        trace_id=trace_id,
        span_id=span_id,
        tool=tool,
        args_hash=args_hash,
        ts=ts,
        kid=_kid(keypair.public_bytes()),
    )
    body = canonical_dumps(payload.to_dict())
    sig = keypair.sign(body)
    return TOKEN_PREFIX + _b64url_encode(body) + "." + _b64url_encode(sig)


class TokenError(Exception):
    """Raised by ``verify_token`` when a token is malformed or invalid."""


@dataclass
class VerifiedToken:
    payload: TokenPayload
    """The signed payload, safe to trust after verification."""


def verify_token(
    pubkey: Ed25519PublicKey,
    token: str,
) -> VerifiedToken:
    """Verify a token against a public key. Raises ``TokenError`` on any
    format or signature failure. The token is intentionally checked ONLY
    for signature integrity — the caller is responsible for freshness
    (age-of-``ts`` policy), which is application-specific.

    A common integration pattern for tool servers:

        try:
            v = verify_token(pubkey, headers["x-custos-token"])
            # Optionally: check v.payload.tool matches the endpoint,
            # v.payload.args_hash matches the request body, etc.
            log_verified(v.payload)
        except TokenError:
            log_rejected(headers.get("x-custos-token"))
            # Policy choice: refuse, alert, or continue-and-flag.

    An "unattested" call — one with no header — is not this function's
    responsibility. The tool server sees the missing header directly.
    """
    if not token.startswith(TOKEN_PREFIX):
        raise TokenError(f"invalid token prefix; expected {TOKEN_PREFIX!r}")
    rest = token[len(TOKEN_PREFIX):]
    try:
        payload_b64, sig_b64 = rest.split(".", 1)
    except ValueError as e:
        raise TokenError("token missing '.' separator") from e
    try:
        body = _b64url_decode(payload_b64)
        sig = _b64url_decode(sig_b64)
    except Exception as e:
        raise TokenError(f"token b64url decode failed: {e}") from e
    try:
        pubkey.verify(sig, body)
    except InvalidSignature as e:
        raise TokenError("token signature invalid") from e
    try:
        d = json.loads(body)
    except Exception as e:
        raise TokenError(f"token payload not JSON: {e}") from e
    required = ("trace_id", "span_id", "tool", "args_hash", "ts", "kid")
    missing = [k for k in required if k not in d]
    if missing:
        raise TokenError(f"token payload missing fields: {missing}")
    return VerifiedToken(
        payload=TokenPayload(
            trace_id=d["trace_id"],
            span_id=d["span_id"],
            tool=d["tool"],
            args_hash=d["args_hash"],
            ts=d["ts"],
            kid=d["kid"],
        )
    )
