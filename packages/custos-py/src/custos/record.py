"""Decision record types."""
from __future__ import annotations

import enum
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, Optional


class Decision(str, enum.Enum):
    ALLOW = "allow"
    DENY = "deny"
    ERROR = "error"


@dataclass
class Actor:
    id: str
    kind: str = "mcp-client"
    meta: Dict[str, str] = field(default_factory=dict)


@dataclass
class Server:
    id: str
    pubkey: str = ""

    def to_dict(self) -> dict:
        d: Dict[str, Any] = {"id": self.id}
        if self.pubkey:
            d["pubkey"] = self.pubkey
        return d


@dataclass
class PolicyResult:
    engine: str
    id: str
    rule: str
    reason: str
    # sha256:<hex> of the exact policy source in effect at decision time.
    # Empty for records produced before v0.4.0 or by callers that constructed
    # a Policy programmatically without a hash. Emitted on the wire only when
    # non-empty so old readers still parse and old records still hash-verify.
    hash: str = ""

    def to_dict(self) -> dict:
        d: Dict[str, Any] = {
            "engine": self.engine,
            "id": self.id,
            "rule": self.rule,
            "reason": self.reason,
        }
        if self.hash:
            d["hash"] = self.hash
        return d


_VALID_ENFORCEMENT_POINTS = frozenset({"sdk", "proxy", "attest-only"})
_VALID_ENFORCEMENT_EFFECTS = frozenset({"blocked", "advisory"})


@dataclass
class Enforcement:
    """Labels the enforcement point and effect of a decision (see WIRE §2.2).

    ``point`` names WHERE the control ran:
      - ``sdk``        — in-process Gate.call wrapping the tool function.
      - ``proxy``      — stdio/HTTP MCP proxy in front of the server.
      - ``attest-only``— log-and-continue; no execution boundary crossed.

    ``effect`` names WHAT HAPPENED when the decision was ``deny``:
      - ``blocked``    — the forwarded call / wrapped function did not run.
      - ``advisory``   — the tool WAS executed regardless (staged rollout
                         mode); the record is opinion, not outcome.

    The distinction matters for audit: a ``deny`` in ``advisory`` mode
    proves the gate had an opinion, NOT that the action failed to occur.
    Confusing these is the failure mode a GRC reviewer will notice first.
    """
    point: str = "sdk"
    effect: str = "blocked"

    def to_dict(self) -> dict:
        return {"point": self.point, "effect": self.effect}

    def validate(self) -> None:
        """Raise ``ValueError`` if ``point`` or ``effect`` is outside the WIRE
        §2.2 enum.

        Called by author-time sites (Gate constructor, proxy setup) so typos
        surface immediately. NOT called by wire deserialization
        (``DecisionRecord.from_dict``) because records preserve whatever
        producer wrote — forward-compatibility with future enum extensions.
        """
        if self.point not in _VALID_ENFORCEMENT_POINTS:
            raise ValueError(
                f"Enforcement.point must be one of "
                f"{sorted(_VALID_ENFORCEMENT_POINTS)}, got {self.point!r}"
            )
        if self.effect not in _VALID_ENFORCEMENT_EFFECTS:
            raise ValueError(
                f"Enforcement.effect must be one of "
                f"{sorted(_VALID_ENFORCEMENT_EFFECTS)}, got {self.effect!r}"
            )


@dataclass
class DecisionRecord:
    v: int
    seq: int
    ts: str
    trace_id: str
    span_id: str
    actor: Actor
    server: Server
    tool: str
    args_hash: str
    result_hash: str
    decision: Decision
    policy: PolicyResult
    latency_ms: int
    prev_hash: str
    enforcement: Optional[Enforcement] = None
    record_hash: Optional[str] = None
    sig: Optional[str] = None

    def to_body(self) -> dict:
        """Serialize without record_hash + sig for hashing."""
        body: Dict[str, Any] = {
            "v": self.v,
            "seq": self.seq,
            "ts": self.ts,
            "trace_id": self.trace_id,
            "span_id": self.span_id,
            "actor": {
                "id": self.actor.id,
                "kind": self.actor.kind,
                "meta": self.actor.meta,
            },
            "server": self.server.to_dict(),
            "tool": self.tool,
            "args_hash": self.args_hash,
            "result_hash": self.result_hash,
            "decision": self.decision.value if isinstance(self.decision, Decision) else self.decision,
            "policy": self.policy.to_dict(),
            "latency_ms": self.latency_ms,
            "prev_hash": self.prev_hash,
        }
        # Emitted only when explicitly set — additive to wire so older
        # readers still verify records produced by v0.4.0+ writers when
        # the enforcement label wasn't populated (e.g. adapter code that
        # predates the field).
        if self.enforcement is not None:
            body["enforcement"] = self.enforcement.to_dict()
        return body

    def to_full(self) -> dict:
        body = self.to_body()
        body["record_hash"] = self.record_hash
        body["sig"] = self.sig
        return body

    @classmethod
    def from_dict(cls, d: dict) -> "DecisionRecord":
        actor = Actor(
            id=d["actor"]["id"],
            kind=d["actor"].get("kind", "mcp-client"),
            meta=d["actor"].get("meta", {}),
        )
        server = Server(
            id=d["server"]["id"],
            pubkey=d["server"].get("pubkey", ""),
        )
        p = d["policy"]
        policy = PolicyResult(
            engine=p["engine"],
            id=p["id"],
            rule=p["rule"],
            reason=p["reason"],
            hash=p.get("hash", ""),
        )
        enforcement = None
        if "enforcement" in d and isinstance(d["enforcement"], dict):
            e = d["enforcement"]
            enforcement = Enforcement(
                point=e.get("point", "sdk"),
                effect=e.get("effect", "blocked"),
            )
        return cls(
            v=d["v"],
            seq=d["seq"],
            ts=d["ts"],
            trace_id=d["trace_id"],
            span_id=d["span_id"],
            actor=actor,
            server=server,
            tool=d["tool"],
            args_hash=d["args_hash"],
            result_hash=d.get("result_hash", ""),
            decision=Decision(d["decision"]),
            policy=policy,
            latency_ms=d.get("latency_ms", 0),
            prev_hash=d["prev_hash"],
            enforcement=enforcement,
            record_hash=d.get("record_hash"),
            sig=d.get("sig"),
        )


GENESIS_PREV_HASH = "sha256:" + "0" * 64


# ---------------------------------------------------------------------------
# Attestation records (added in v0.4.0; see WIRE §2.3).
#
# Attestation records live in the same signed hash-chained JSONL as
# decision records, so a gap in the chain is detectable and control
# liveness becomes cryptographic instead of best-effort. The wire
# discriminator is a top-level ``type`` field: absent (or ``"decision"``)
# means the record is a DecisionRecord; ``"attestation"`` means the
# fields below apply and the decision-only fields (tool, args_hash,
# result_hash, decision, policy, latency_ms, actor, server) are absent.
# ---------------------------------------------------------------------------


@dataclass
class AttestationRecord:
    """Signed evidence that the control was operating at a point in time.

    ``reason`` names WHY the record was emitted:
      - ``startup``      — Custos process (or Gate) came up.
      - ``periodic``     — heartbeat on a fixed cadence (see WIRE §2.3).
      - ``policy-change``— active policy was reloaded / rotated.
      - ``actor-change`` — the set of active actor IDs changed.
      - ``shutdown``     — Custos process is exiting cleanly.

    Auditors correlate the cadence of ``periodic`` records against the
    configured interval; any gap larger than N * interval is evidence
    the control stopped observing (see ``custos verify --coverage``).
    """
    v: int
    seq: int
    ts: str
    trace_id: str
    span_id: str
    prev_hash: str
    reason: str
    custos_version: str
    policy_hash: str = ""
    active_actors: list = field(default_factory=list)
    uptime_ms: int = 0
    record_hash: Optional[str] = None
    sig: Optional[str] = None

    def to_body(self) -> dict:
        return {
            "v": self.v,
            "seq": self.seq,
            "ts": self.ts,
            "trace_id": self.trace_id,
            "span_id": self.span_id,
            "prev_hash": self.prev_hash,
            "type": "attestation",
            "attestation": {
                "reason": self.reason,
                "custos_version": self.custos_version,
                "policy_hash": self.policy_hash,
                "active_actors": self.active_actors,
                "uptime_ms": self.uptime_ms,
            },
        }

    def to_full(self) -> dict:
        body = self.to_body()
        body["record_hash"] = self.record_hash
        body["sig"] = self.sig
        return body
