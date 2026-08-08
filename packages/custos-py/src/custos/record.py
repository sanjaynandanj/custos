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

    def to_dict(self) -> dict:
        return asdict(self)


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
    record_hash: Optional[str] = None
    sig: Optional[str] = None

    def to_body(self) -> dict:
        """Serialize without record_hash + sig for hashing."""
        return {
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
        policy = PolicyResult(**d["policy"])
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
            record_hash=d.get("record_hash"),
            sig=d.get("sig"),
        )


GENESIS_PREV_HASH = "sha256:" + "0" * 64
