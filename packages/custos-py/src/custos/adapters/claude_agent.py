"""Claude Agent SDK adapter for Custos.

Wraps tools produced by the `@tool` decorator (or the equivalent SdkMcpTool
shape) from `claude_agent_sdk` so every invocation is policy-checked and
recorded in the ledger. Denies are returned as MCP-shaped error results the
model can react to on its next turn — no exception surfaces to the runtime.

Duck-typed on `.name` and `.handler(args) -> dict`. No `claude_agent_sdk`
import at module load; safe to import in any environment.

Example
-------

    from claude_agent_sdk import tool, create_sdk_mcp_server
    from custos.adapters.claude_agent import gate_tool

    @tool("read_file", "Read a file", {"path": str})
    async def read_file(args):
        return {"content": [{"type": "text", "text": open(args["path"]).read()}]}

    gate_tool(read_file, gate)  # in-place; safe to hand to create_sdk_mcp_server
    server = create_sdk_mcp_server("fs", "0.1", tools=[read_file])
"""
from __future__ import annotations

import inspect
from typing import Any, Iterable, Optional

from custos.sdk import Gate


def _denied_result(rule: str, reason: str, trace_id: str) -> dict:
    """MCP-shaped error result the model surfaces on its next turn."""
    return {
        "content": [
            {
                "type": "text",
                "text": f"custos denied [{rule}]: {reason} (trace {trace_id})",
            }
        ],
        "isError": True,
    }


def gate_tool(tool: Any, gate: Gate, tool_name: Optional[str] = None) -> Any:
    """Wrap a Claude Agent SDK tool so its handler is Custos-gated.

    Mutates and returns the tool. The wrapper preserves `.name`,
    `.description`, and `.input_schema` untouched so the SDK's registration
    logic sees an identical object.
    """
    name = tool_name or getattr(tool, "name", None)
    if not name:
        raise ValueError("tool has no .name; pass tool_name= explicitly")
    original_handler = getattr(tool, "handler", None)
    if original_handler is None:
        raise ValueError(
            "tool has no .handler — is this a claude_agent_sdk @tool result?"
        )

    if inspect.iscoroutinefunction(original_handler):
        async def handler(args: dict) -> Any:
            result = await gate.acall(name, args, fn=lambda **kw: original_handler(kw))
            if not result.allowed:
                return _denied_result(result.rule, result.reason, result.record.trace_id)
            return result.result
    else:
        def handler(args: dict) -> Any:  # type: ignore[misc]
            result = gate.call(name, args, fn=lambda **kw: original_handler(kw))
            if not result.allowed:
                return _denied_result(result.rule, result.reason, result.record.trace_id)
            return result.result

    tool.handler = handler  # type: ignore[attr-defined]
    return tool


def gate_tools(tools: Iterable[Any], gate: Gate) -> list:
    """Gate an iterable of tools in place and return them as a list."""
    return [gate_tool(t, gate) for t in tools]
