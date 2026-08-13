"""Tests the LangGraph adapter with a duck-typed fake tool (no langgraph install)."""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from custos.adapters.langgraph import CustosDenied, gate_tool
from custos.keys import generate_keypair
from custos.ledger import Ledger
from custos.policy import load_policy
from custos.record import Actor, Server
from custos.sdk import Gate


class FakeTool:
    def __init__(self, name: str):
        self.name = name
        self.description = f"fake {name}"
        self.args_schema = None
        self.calls: list[dict] = []

    def invoke(self, args: dict, config=None):
        self.calls.append(args)
        return {"echo": args}

    async def ainvoke(self, args: dict, config=None):
        self.calls.append(args)
        return {"echo": args}


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


def test_allow_passes_through(tmp_path: Path):
    tool = gate_tool(FakeTool("read_file"), _gate(tmp_path))
    out = tool.invoke({"path": "/etc/hostname"})
    assert out == {"echo": {"path": "/etc/hostname"}}


def test_deny_raises_custos_denied(tmp_path: Path):
    tool = gate_tool(FakeTool("shell.exec"), _gate(tmp_path))
    with pytest.raises(CustosDenied) as exc:
        tool.invoke({"cmd": "rm -rf /"})
    assert exc.value.rule == "deny-shell"
    assert "no shell" in exc.value.reason


def test_default_deny_raises(tmp_path: Path):
    tool = gate_tool(FakeTool("write_file"), _gate(tmp_path))
    with pytest.raises(CustosDenied) as exc:
        tool.invoke({"path": "/x"})
    # No matching rule -> policy default = deny.
    assert "default:deny" in exc.value.reason


def test_async_allow(tmp_path: Path):
    tool = gate_tool(FakeTool("read_file"), _gate(tmp_path))
    out = asyncio.run(tool.ainvoke({"path": "/y"}))
    assert out == {"echo": {"path": "/y"}}


def test_async_deny(tmp_path: Path):
    tool = gate_tool(FakeTool("shell.exec"), _gate(tmp_path))
    with pytest.raises(CustosDenied):
        asyncio.run(tool.ainvoke({"cmd": "id"}))


def test_ledger_records_allow_and_deny(tmp_path: Path):
    gate = _gate(tmp_path)
    allow_tool = gate_tool(FakeTool("read_file"), gate)
    deny_tool = gate_tool(FakeTool("shell.exec"), gate)

    allow_tool.invoke({"path": "/a"})
    with pytest.raises(CustosDenied):
        deny_tool.invoke({"cmd": "id"})

    from custos.verify import verify_ledger
    r = verify_ledger(str(tmp_path / "ledger.jsonl"), str(tmp_path / "ledger.pub"))
    assert r.ok
    assert r.records == 2


def test_missing_name_raises(tmp_path: Path):
    class Nameless:
        def invoke(self, args, config=None):
            return args

    with pytest.raises(ValueError):
        gate_tool(Nameless(), _gate(tmp_path))
