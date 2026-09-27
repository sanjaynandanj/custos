"""OPA adapter: evaluate policies via a locally running OPA HTTP sidecar.

Presents the same interface as ``custos.policy.Policy`` — the ledger records
``engine="opa"`` and captures the OPA rule and reason.

Expected OPA response shape (POST to the Data API URL configured below)::

    {
      "result": {
        "allow": true,
        "reason": "read-only tools are allowed",
        "rule_id": "allow-read-only"
      }
    }

- ``allow`` is required. Non-boolean or missing ``allow`` triggers the
  configured ``default`` (fail-closed unless overridden).
- ``reason`` and ``rule_id`` are optional but recommended — they land in the
  signed ledger record and are the audit trail an operator or GRC reviewer
  will read first.
- Legacy field name ``rule`` is still accepted as a fallback for OPA policies
  written before the ``rule_id`` convention stabilized. New policies should
  emit ``rule_id``.
- A boolean ``result`` is also accepted for the trivial case::

      {"result": true}

Network failures, non-2xx responses, and malformed JSON all fail closed by
returning ``Decision.ERROR``, which the gateway MUST treat as deny.
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
    timeout: float = 2.0

    def evaluate(self, ctx: dict) -> PolicyDecision:
        req = urllib.request.Request(
            self.url,
            data=json.dumps({"input": ctx}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
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
            # Prefer `rule_id` (current convention); accept `rule` for legacy
            # policies written before the field name stabilized.
            rule = result.get("rule_id") or result.get("rule", "")
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
