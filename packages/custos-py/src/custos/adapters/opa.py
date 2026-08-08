"""OPA adapter: evaluate policies via a locally running OPA HTTP sidecar.

Presents the same interface as `custos.policy.Policy` — the ledger records
`engine="opa"` and captures the OPA rule/reason.
"""
from __future__ import annotations

import json
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Dict, List

from custos.policy import PolicyDecision
from custos.record import Decision


@dataclass
class OpaPolicy:
    id: str
    url: str  # e.g. http://localhost:8181/v1/data/custos/authz
    default: Decision = Decision.DENY
    version: int = 1
    engine: str = "opa"
    rules: List = field(default_factory=list)

    def evaluate(self, ctx: dict) -> PolicyDecision:
        req = urllib.request.Request(
            self.url,
            data=json.dumps({"input": ctx}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=2.0) as resp:
                body = json.loads(resp.read())
        except Exception as e:
            return PolicyDecision(
                decision=Decision.ERROR,
                rule_id="",
                reason=f"opa unreachable: {e}",
            )
        result = body.get("result") or {}
        if isinstance(result, dict):
            allow = result.get("allow", False)
            rule = result.get("rule", "")
            reason = result.get("reason", "")
        else:
            allow = bool(result)
            rule = ""
            reason = ""
        return PolicyDecision(
            decision=Decision.ALLOW if allow else self.default,
            rule_id=rule,
            reason=reason or ("opa allow" if allow else "opa deny"),
        )
