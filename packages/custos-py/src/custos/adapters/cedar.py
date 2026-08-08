"""Cedar adapter (optional): requires `pip install custos-mcp[cedar]`."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import List

from custos.policy import PolicyDecision
from custos.record import Decision


@dataclass
class CedarPolicy:
    id: str
    policy_text: str
    default: Decision = Decision.DENY
    version: int = 1
    engine: str = "cedar"
    rules: List = field(default_factory=list)

    def __post_init__(self):
        try:
            import cedarpy  # noqa: F401
        except ImportError as e:
            raise ImportError(
                "Cedar support requires `pip install custos-mcp[cedar]`"
            ) from e

    def evaluate(self, ctx: dict) -> PolicyDecision:
        import cedarpy
        # Build principal/action/resource from context
        principal = f'Actor::"{ctx.get("actor", {}).get("id", "unknown")}"'
        action = f'Action::"{ctx.get("tool", "unknown")}"'
        resource = f'Server::"{ctx.get("server", {}).get("id", "unknown")}"'
        try:
            result = cedarpy.is_authorized(
                self.policy_text,
                {"schema": {}},
                {
                    "principal": principal,
                    "action": action,
                    "resource": resource,
                    "context": ctx,
                },
                [],
            )
            allowed = bool(result.get("allowed", False))
            reasons = result.get("reasons", [])
            reason = ", ".join(reasons) if reasons else ("cedar allow" if allowed else "cedar deny")
        except Exception as e:
            return PolicyDecision(decision=Decision.ERROR, rule_id="", reason=f"cedar error: {e}")
        return PolicyDecision(
            decision=Decision.ALLOW if allowed else self.default,
            rule_id="cedar",
            reason=reason,
        )
