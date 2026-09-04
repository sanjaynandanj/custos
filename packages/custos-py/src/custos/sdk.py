"""In-process Gate SDK: enforce policy + record decisions without running as a proxy."""
from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, Optional, Union

from custos.ids import iso_now_ms, new_span_id, new_trace_id
from custos.ledger import Ledger, hash_of_value
from custos.policy import Policy
from custos.record import Actor, Decision, DecisionRecord, Enforcement, PolicyResult, Server
from custos.token import generate_token


@dataclass
class GateResult:
    decision: Decision
    rule: str
    reason: str
    record: DecisionRecord
    result: Any = None
    error: Optional[str] = None
    # Signed per-call attestation token (WIRE §8). Populated on ``allow``
    # decisions when the Gate was constructed with a Ledger whose keypair
    # is exposed. Cooperating tool servers verify this before executing
    # to prove the call actually went through Custos — see custos.token.
    token: str = ""

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
        snapshot_policy: bool = True,
        enforcement: Optional[Enforcement] = None,
        advisory: bool = False,
        attest: bool = True,
    ):
        self.policy = policy
        self.ledger = ledger
        self.actor = actor
        self.server = server
        # Default: in-process Gate is an SDK enforcement point and a deny
        # actually blocks execution (the wrapped fn is never called). An
        # advisory Gate logs the decision but always executes the fn — useful
        # for staged rollouts where you want the ledger to show what the
        # policy WOULD deny before you're ready to enforce.
        if enforcement is not None:
            enforcement.validate()
        self.enforcement = enforcement or Enforcement(
            point="sdk",
            effect="advisory" if advisory else "blocked",
        )
        self.advisory = advisory
        # Content-address the policy alongside the ledger so an evidence
        # bundle can preserve every policy version referenced by any record
        # — not just the latest. See spec/WIRE.md §5.1. Opt-out via
        # snapshot_policy=False for callers that manage snapshots externally
        # (e.g. immutable-image deployments where the policy is baked in).
        if snapshot_policy and getattr(policy, "snapshot_to", None):
            try:
                policy.snapshot_to(Path(ledger.path).parent / "policies")
            except OSError:
                # Snapshot failure must not block gate operation; the ledger
                # still records the hash and a later `custos bundle` invocation
                # can point at an explicit directory.
                pass
        # Emit a startup attestation so the ledger records "this Gate was
        # constructed with this policy at this time." Combined with periodic
        # heartbeats and a shutdown attestation, gaps become detectable and
        # silence stops being ambiguous ("nothing happened" vs "you stopped
        # observing"). Best-effort — failure here must never block a Gate
        # from serving traffic. Opt out with attest=False for tests or
        # write-heavy paths that manage attestation externally.
        #
        # Failure here MUST NOT be silent — that reproduces the exact
        # "you stopped observing" failure mode Custos is trying to make
        # detectable. Emit a RuntimeWarning that surfaces once (Python's
        # warnings module dedupes by default) so operators wiring up a
        # third-party Ledger without append_attestation see the gap in
        # coverage they've silently opted into.
        if attest:
            try:
                from custos import __version__ as _cv
                ledger.append_attestation(
                    reason="startup",
                    custos_version=_cv,
                    policy_hash=getattr(policy, "hash", ""),
                    active_actors=[actor.id],
                )
            except Exception as _attest_err:
                import warnings as _warnings
                _warnings.warn(
                    "custos: startup attestation failed on "
                    f"{type(ledger).__module__}.{type(ledger).__name__}: "
                    f"{_attest_err}. This Gate will produce no liveness "
                    "records — `custos verify --coverage` will show a "
                    "silent-down window. Pass `attest=False` to suppress "
                    "this warning if intentional.",
                    RuntimeWarning,
                    stacklevel=2,
                )

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
        if pd.decision != Decision.ALLOW and not self.advisory:
            rec = self._build_record(tool, args, None, pd.decision, pd.rule_id, pd.reason, 0, tid)
            self.ledger.append(rec)
            return GateResult(decision=pd.decision, rule=pd.rule_id, reason=pd.reason, record=rec)
        # Advisory mode when denied: run the tool anyway but record the
        # decision the policy WOULD have enforced. Enforcement.effect is
        # already "advisory" on this Gate, so the record accurately says
        # "gate had an opinion, action was executed regardless."
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
        # In advisory mode, record the policy's decision, not ALLOW —
        # that's the whole point of advisory: the ledger reflects what
        # the policy said, so operators can see impact before flipping
        # to blocked.
        recorded_decision = (
            pd.decision if self.advisory and pd.decision != Decision.ALLOW else Decision.ALLOW
        )
        rec = self._build_record(tool, args, result, recorded_decision, pd.rule_id, pd.reason, latency_ms, tid)
        self.ledger.append(rec)
        token = self._maybe_token(rec, recorded_decision)
        return GateResult(
            decision=recorded_decision, rule=pd.rule_id, reason=pd.reason,
            record=rec, result=result, token=token,
        )

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
        if pd.decision != Decision.ALLOW and not self.advisory:
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
        recorded_decision = (
            pd.decision if self.advisory and pd.decision != Decision.ALLOW else Decision.ALLOW
        )
        rec = self._build_record(tool, args, result, recorded_decision, pd.rule_id, pd.reason, latency_ms, tid)
        self.ledger.append(rec)
        token = self._maybe_token(rec, recorded_decision)
        return GateResult(
            decision=recorded_decision, rule=pd.rule_id, reason=pd.reason,
            record=rec, result=result, token=token,
        )

    def _maybe_token(self, rec: DecisionRecord, decision: Decision) -> str:
        """Generate a per-call attestation token for ALLOW outcomes.

        Deliberately silent on failure (missing keypair, adapter that
        stores keys elsewhere) — coverage attestation is opt-in on the
        tool side and the ledger already records the decision. Never
        raise from the enforcement path over an optional evidence
        artifact.
        """
        if decision != Decision.ALLOW:
            return ""
        kp = getattr(self.ledger, "keypair", None)
        if kp is None:
            return ""
        try:
            return generate_token(
                keypair=kp,
                trace_id=rec.trace_id,
                span_id=rec.span_id,
                tool=rec.tool,
                args_hash=rec.args_hash,
                ts=rec.ts,
            )
        except Exception:
            return ""

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
                hash=getattr(self.policy, "hash", ""),
            ),
            latency_ms=latency_ms,
            prev_hash="",  # ledger fills in
            enforcement=self.enforcement,
        )
