"""In-process Gate SDK: enforce policy + record decisions without running as a proxy."""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, Optional, Union

from custos.ids import iso_now_ms, new_span_id, new_trace_id
from custos.ledger import Ledger, hash_of_value
from custos.policy import Policy
from custos.record import Actor, Decision, DecisionRecord, PolicyResult, Server


@dataclass
class GateResult:
    decision: Decision
    rule: str
    reason: str
    record: DecisionRecord
    result: Any = None
    error: Optional[str] = None

    @property
    def allowed(self) -> bool:
        return self.decision == Decision.ALLOW


class Gate:
    """Wraps a policy + ledger and provides a `check` and `call` API.

    Example:
        gate = Gate(policy, ledger, actor=Actor("agent-1"), server=Server("fs"))
        result = gate.call("read_file", {"path": "/workspace/x"}, fn=read_impl)
        if result.allowed:
            print(result.result)
    """

    def __init__(
        self,
        policy: Policy,
        ledger: Ledger,
        actor: Actor,
        server: Server,
    ):
        self.policy = policy
        self.ledger = ledger
        self.actor = actor
        self.server = server

    def _ctx(self, tool: str, args: dict, trace_id: str) -> dict:
        return {
            "tool": tool,
            "actor": {"id": self.actor.id, "kind": self.actor.kind, "meta": self.actor.meta},
            "server": self.server.to_dict(),
            "args": args,
            "trace_id": trace_id,
        }

    def check(
        self,
        tool: str,
        args: dict,
        trace_id: Optional[str] = None,
    ) -> GateResult:
        """Evaluate policy only; no execution, no ledger write."""
        tid = trace_id or new_trace_id()
        ctx = self._ctx(tool, args, tid)
        pd = self.policy.evaluate(ctx)
        # No record persisted for pure check
        rec = self._build_record(
            tool=tool,
            args=args,
            result=None,
            decision=pd.decision,
            rule=pd.rule_id,
            reason=pd.reason,
            latency_ms=0,
            trace_id=tid,
        )
        return GateResult(decision=pd.decision, rule=pd.rule_id, reason=pd.reason, record=rec)

    def call(
        self,
        tool: str,
        args: dict,
        fn: Callable[..., Any],
        trace_id: Optional[str] = None,
    ) -> GateResult:
        tid = trace_id or new_trace_id()
        ctx = self._ctx(tool, args, tid)
        pd = self.policy.evaluate(ctx)
        if pd.decision != Decision.ALLOW:
            rec = self._build_record(tool, args, None, pd.decision, pd.rule_id, pd.reason, 0, tid)
            self.ledger.append(rec)
            return GateResult(decision=pd.decision, rule=pd.rule_id, reason=pd.reason, record=rec)
        started = time.perf_counter()
        error: Optional[str] = None
        result = None
        try:
            result = fn(**args) if isinstance(args, dict) else fn(args)
        except Exception as e:
            error = str(e)
            decision = Decision.ERROR
            reason = f"tool error: {error}"
            latency_ms = int((time.perf_counter() - started) * 1000)
            rec = self._build_record(tool, args, None, decision, pd.rule_id, reason, latency_ms, tid)
            self.ledger.append(rec)
            return GateResult(decision=decision, rule=pd.rule_id, reason=reason, record=rec, error=error)
        latency_ms = int((time.perf_counter() - started) * 1000)
        rec = self._build_record(tool, args, result, Decision.ALLOW, pd.rule_id, pd.reason, latency_ms, tid)
        self.ledger.append(rec)
        return GateResult(decision=Decision.ALLOW, rule=pd.rule_id, reason=pd.reason, record=rec, result=result)

    async def acall(
        self,
        tool: str,
        args: dict,
        fn: Callable[..., Awaitable[Any]],
        trace_id: Optional[str] = None,
    ) -> GateResult:
        tid = trace_id or new_trace_id()
        ctx = self._ctx(tool, args, tid)
        pd = self.policy.evaluate(ctx)
        if pd.decision != Decision.ALLOW:
            rec = self._build_record(tool, args, None, pd.decision, pd.rule_id, pd.reason, 0, tid)
            self.ledger.append(rec)
            return GateResult(decision=pd.decision, rule=pd.rule_id, reason=pd.reason, record=rec)
        started = time.perf_counter()
        try:
            result = await fn(**args) if isinstance(args, dict) else await fn(args)
        except Exception as e:
            latency_ms = int((time.perf_counter() - started) * 1000)
            reason = f"tool error: {e}"
            rec = self._build_record(tool, args, None, Decision.ERROR, pd.rule_id, reason, latency_ms, tid)
            self.ledger.append(rec)
            return GateResult(decision=Decision.ERROR, rule=pd.rule_id, reason=reason, record=rec, error=str(e))
        latency_ms = int((time.perf_counter() - started) * 1000)
        rec = self._build_record(tool, args, result, Decision.ALLOW, pd.rule_id, pd.reason, latency_ms, tid)
        self.ledger.append(rec)
        return GateResult(decision=Decision.ALLOW, rule=pd.rule_id, reason=pd.reason, record=rec, result=result)

    def _build_record(
        self,
        tool: str,
        args: Any,
        result: Any,
        decision: Decision,
        rule: str,
        reason: str,
        latency_ms: int,
        trace_id: str,
    ) -> DecisionRecord:
        args_hash = hash_of_value(args)
        if decision == Decision.ALLOW and result is not None:
            result_hash = hash_of_value(result)
        else:
            result_hash = ""
        return DecisionRecord(
            v=1,
            seq=0,  # ledger fills in on append
            ts=iso_now_ms(),
            trace_id=trace_id,
            span_id=new_span_id(),
            actor=self.actor,
            server=self.server,
            tool=tool,
            args_hash=args_hash,
            result_hash=result_hash,
            decision=decision,
            policy=PolicyResult(
                engine=self.policy.engine,
                id=self.policy.id,
                rule=rule,
                reason=reason,
            ),
            latency_ms=latency_ms,
            prev_hash="",  # ledger fills in
        )
