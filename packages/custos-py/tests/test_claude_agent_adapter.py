"""Tests the Claude Agent SDK adapter with a duck-typed fake tool (no SDK install)."""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from custos.adapters.claude_agent import gate_tool, gate_tools
from custos.keys import generate_keypair
from custos.ledger import Ledger
from custos.policy import load_policy
from custos.record import Actor, Server
from custos.sdk import Gate


class FakeAsyncTool:
    def __init__(self, name: str):
        self.name = name
        self.description = f"fake {name}"
        self.input_schema = {"type": "object", "properties": {}}
        self.calls: list[dict] = []

    async def handler(self, args: dict):
        self.calls.append(args)
        return {"content": [{"type": "text", "text": str(args)}]}


def _gate(tmp: Path) -> Gate:
    kp = generate_keypair()
    kp.save(tmp)
    ledger = Ledger(tmp / "ledger.jsonl", kp)
    policy = load_policy({
        "version": 1,
        "id": "test",
        "default": "deny",
        "rules": [
            {"id": "allow-read", "when": {"tool": "read_file"}, "decision": "allow", "reason": "reads ok"},
            {"id": "deny-shell", "when": {"tool": {"regex": r"^shell\."}}, "decision": "deny", "reason": "no shell"},
        ],
    })
    return Gate(policy, ledger, Actor("agent"), Server("srv"))


def _bind(tool):
    """Return a callable that invokes tool.handler, whether it's a bound
    method (original) or a plain function (wrapped by gate_tool)."""
    async def call(args):
        return await tool.handler(args)
    return call


def test_allow_passes_through(tmp_path: Path):
    t = FakeAsyncTool("read_file")
    gate_tool(t, _gate(tmp_path))
    out = asyncio.run(_bind(t)({"path": "/etc/hostname"}))
    assert "/etc/hostname" in out["content"][0]["text"]
    assert not out.get("isError")


def test_explicit_deny_returns_error_result(tmp_path: Path):
    t = FakeAsyncTool("shell.exec")
    gate_tool(t, _gate(tmp_path))
    out = asyncio.run(_bind(t)({"cmd": "rm -rf /"}))
    assert out["isError"] is True
    assert "custos denied [deny-shell]" in out["content"][0]["text"]
    assert "no shell" in out["content"][0]["text"]


def test_default_deny_returns_error(tmp_path: Path):
    t = FakeAsyncTool("write_file")
    gate_tool(t, _gate(tmp_path))
    out = asyncio.run(_bind(t)({"path": "/x"}))
    assert out["isError"] is True


def test_ledger_records_allow_and_deny(tmp_path: Path):
    gate = _gate(tmp_path)
    allow_tool = FakeAsyncTool("read_file")
    deny_tool = FakeAsyncTool("shell.exec")
    gate_tool(allow_tool, gate)
    gate_tool(deny_tool, gate)

    asyncio.run(_bind(allow_tool)({"path": "/a"}))
    asyncio.run(_bind(deny_tool)({"cmd": "id"}))

    from custos.verify import verify_ledger
    r = verify_ledger(str(tmp_path / "ledger.jsonl"), str(tmp_path / "ledger.pub"))
    assert r.ok
    assert r.records == 2


def test_preserves_metadata(tmp_path: Path):
    t = FakeAsyncTool("read_file")
    gated = gate_tool(t, _gate(tmp_path))
    assert gated.name == "read_file"
    assert gated.description == "fake read_file"
    assert gated.input_schema == {"type": "object", "properties": {}}


def test_gate_tools_wraps_all(tmp_path: Path):
    gate = _gate(tmp_path)
    tools = gate_tools(
        [FakeAsyncTool("read_file"), FakeAsyncTool("shell.exec")],
        gate,
    )
    assert len(tools) == 2
    out_allow = asyncio.run(_bind(tools[0])({"path": "/x"}))
    assert not out_allow.get("isError")
    out_deny = asyncio.run(_bind(tools[1])({"cmd": "id"}))
    assert out_deny["isError"] is True


def test_missing_handler_raises(tmp_path: Path):
    class Naked:
        name = "x"
    with pytest.raises(ValueError, match="no .handler"):
        gate_tool(Naked(), _gate(tmp_path))


def test_missing_name_raises(tmp_path: Path):
    class Nameless:
        async def handler(self, args):
            return args
    with pytest.raises(ValueError):
        gate_tool(Nameless(), _gate(tmp_path))


def test_sync_handler_supported(tmp_path: Path):
    """Some tool shapes have a sync handler — should still gate correctly."""
    class SyncTool:
        name = "read_file"
        def handler(self, args):
            return {"content": [{"type": "text", "text": str(args)}]}

    t = SyncTool()
    gate_tool(t, _gate(tmp_path))
    out = t.handler({"path": "/y"})
    assert not out.get("isError")
    assert "/y" in out["content"][0]["text"]
