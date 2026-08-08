"""Transparent MCP stdio proxy.

Reads JSON-RPC messages from stdin, forwards to an upstream MCP server process
over stdio, gates `tools/call` methods through the policy engine, and appends
signed decision records to the ledger.
"""
from __future__ import annotations

import asyncio
import json
import sys
import time
from dataclasses import dataclass
from typing import Optional

from custos.ids import iso_now_ms, new_span_id, new_trace_id
from custos.ledger import Ledger, hash_of_value
from custos.policy import Policy
from custos.record import Actor, Decision, DecisionRecord, PolicyResult, Server


DENY_CODE = -32001


@dataclass
class ProxyConfig:
    upstream_cmd: list[str]
    policy: Policy
    ledger: Ledger
    actor: Actor
    server: Server


async def _read_line(stream: asyncio.StreamReader) -> Optional[bytes]:
    try:
        line = await stream.readline()
    except Exception:
        return None
    if not line:
        return None
    return line


async def run_stdio_proxy(config: ProxyConfig) -> int:
    """Run the proxy until the upstream process or stdin closes."""
    proc = await asyncio.create_subprocess_exec(
        *config.upstream_cmd,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=sys.stderr,
    )
    assert proc.stdin and proc.stdout

    # Bridge stdin (from client) → policy → upstream stdin
    loop = asyncio.get_event_loop()
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin)

    # Track pending tool calls by JSON-RPC id, so we can hash results
    pending: dict = {}  # id -> {"tool", "args", "trace_id", "span_id", "t0"}

    async def client_to_upstream():
        while True:
            line = await _read_line(reader)
            if line is None:
                break
            try:
                msg = json.loads(line)
            except Exception:
                # Non-JSON: pass through
                proc.stdin.write(line)
                await proc.stdin.drain()
                continue
            if isinstance(msg, dict) and msg.get("method") == "tools/call":
                params = msg.get("params") or {}
                tool = params.get("name", "")
                args = params.get("arguments", {}) or {}
                meta = params.get("_meta") or {}
                trace_id = meta.get("trace_id") or new_trace_id()
                span_id = new_span_id()
                params["_meta"] = {**meta, "trace_id": trace_id, "span_id": span_id}
                ctx = {
                    "tool": tool,
                    "actor": {
                        "id": config.actor.id,
                        "kind": config.actor.kind,
                        "meta": config.actor.meta,
                    },
                    "server": config.server.to_dict(),
                    "args": args,
                    "trace_id": trace_id,
                }
                pd = config.policy.evaluate(ctx)
                if pd.decision != Decision.ALLOW:
                    # Deny: reply to client, do not forward
                    rec = _record(
                        config, tool, args, None, pd.decision, pd.rule_id, pd.reason,
                        latency_ms=0, trace_id=trace_id, span_id=span_id,
                    )
                    config.ledger.append(rec)
                    err_resp = {
                        "jsonrpc": "2.0",
                        "id": msg.get("id"),
                        "error": {
                            "code": DENY_CODE,
                            "message": f"denied by policy: {pd.rule_id or 'default'}",
                            "data": {"reason": pd.reason, "trace_id": trace_id},
                        },
                    }
                    sys.stdout.write(json.dumps(err_resp) + "\n")
                    sys.stdout.flush()
                    continue
                pending[msg.get("id")] = {
                    "tool": tool,
                    "args": args,
                    "trace_id": trace_id,
                    "span_id": span_id,
                    "t0": time.perf_counter(),
                    "rule": pd.rule_id,
                    "reason": pd.reason,
                }
                proc.stdin.write((json.dumps(msg) + "\n").encode("utf-8"))
                await proc.stdin.drain()
            else:
                proc.stdin.write(line)
                await proc.stdin.drain()

    async def upstream_to_client():
        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            try:
                msg = json.loads(line)
            except Exception:
                sys.stdout.buffer.write(line)
                sys.stdout.flush()
                continue
            if isinstance(msg, dict) and msg.get("id") in pending:
                info = pending.pop(msg["id"])
                latency_ms = int((time.perf_counter() - info["t0"]) * 1000)
                result = msg.get("result")
                error = msg.get("error")
                decision = Decision.ALLOW if error is None else Decision.ERROR
                reason = info["reason"] if decision == Decision.ALLOW else f"upstream error: {error}"
                rec = _record(
                    config, info["tool"], info["args"], result,
                    decision, info["rule"], reason,
                    latency_ms=latency_ms, trace_id=info["trace_id"], span_id=info["span_id"],
                )
                config.ledger.append(rec)
            sys.stdout.buffer.write(line)
            sys.stdout.flush()

    await asyncio.gather(client_to_upstream(), upstream_to_client(), return_exceptions=True)
    return await proc.wait()


def _record(
    config: ProxyConfig,
    tool: str,
    args,
    result,
    decision: Decision,
    rule: str,
    reason: str,
    latency_ms: int,
    trace_id: str,
    span_id: str,
) -> DecisionRecord:
    return DecisionRecord(
        v=1,
        seq=0,
        ts=iso_now_ms(),
        trace_id=trace_id,
        span_id=span_id,
        actor=config.actor,
        server=config.server,
        tool=tool,
        args_hash=hash_of_value(args),
        result_hash=hash_of_value(result) if (decision == Decision.ALLOW and result is not None) else "",
        decision=decision,
        policy=PolicyResult(
            engine=config.policy.engine, id=config.policy.id, rule=rule, reason=reason
        ),
        latency_ms=latency_ms,
        prev_hash="",
    )
