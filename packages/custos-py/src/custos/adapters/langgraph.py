"""LangGraph adapter for Custos.

Two entry points:

  gate_tool(tool, gate)      -> wraps a single LangChain BaseTool; every
                                invocation goes through Custos.Gate first.
  make_tool_node(tools, gate) -> convenience wrapper: returns a langgraph
                                 ToolNode with all tools gated. Requires
                                 `pip install custos-mcp[langgraph]` at runtime.

Denied calls raise CustosDenied. LangGraph's ToolNode catches tool exceptions
and surfaces them as ToolMessage content, so denies flow through the graph as
normal messages — no special node wiring required.

The adapter never imports langgraph/langchain at module load; all framework
imports are lazy so this file is safe to import in any environment.
"""
from __future__ import annotations

from typing import Any, Iterable, Optional

from custos.sdk import Gate


class CustosDenied(Exception):
    """Raised when the policy denies a tool call.

    Carries the rule id + human reason. LangGraph's ToolNode will convert this
    into a ToolMessage the LLM can react to on the next turn.
    """

    def __init__(self, rule: str, reason: str, trace_id: str):
        self.rule = rule
        self.reason = reason
        self.trace_id = trace_id
        super().__init__(f"custos denied [{rule}]: {reason}")


def gate_tool(tool: Any, gate: Gate, tool_name: Optional[str] = None) -> Any:
    """Wrap a LangChain-shaped tool with a Custos gate.

    Duck-typed on `.name`, `.invoke(input, config=None)`, and optionally
    `.ainvoke`. Any object matching that shape works — no langchain import
    required.

    The returned object shares identity of `.name`, `.description`, and
    `.args_schema` with the original so LangGraph binds it identically.
    """
    name = tool_name or getattr(tool, "name", None)
    if not name:
        raise ValueError("tool has no .name; pass tool_name= explicitly")

    original_invoke = getattr(tool, "invoke", None)
    original_ainvoke = getattr(tool, "ainvoke", None)
    if original_invoke is None and original_ainvoke is None:
        raise ValueError("tool has neither .invoke nor .ainvoke")

    def _sync(args: dict, config: Any = None) -> Any:
        args_dict = _coerce_args(args)
        result = gate.call(name, args_dict, fn=lambda **kw: original_invoke(kw, config) if config is not None else original_invoke(kw))
        if not result.allowed:
            raise CustosDenied(result.rule, result.reason, result.record.trace_id)
        return result.result

    async def _async(args: dict, config: Any = None) -> Any:
        args_dict = _coerce_args(args)
        if original_ainvoke is not None:
            result = await gate.acall(name, args_dict, fn=lambda **kw: original_ainvoke(kw, config) if config is not None else original_ainvoke(kw))
        else:
            result = gate.call(name, args_dict, fn=lambda **kw: original_invoke(kw, config) if config is not None else original_invoke(kw))
        if not result.allowed:
            raise CustosDenied(result.rule, result.reason, result.record.trace_id)
        return result.result

    if original_invoke is not None:
        tool.invoke = _sync  # type: ignore[attr-defined]
    if original_ainvoke is not None:
        tool.ainvoke = _async  # type: ignore[attr-defined]
    return tool


def _coerce_args(args: Any) -> dict:
    if isinstance(args, dict):
        return args
    # LangChain tools accept scalar inputs too; wrap so Gate.call sees a dict.
    return {"input": args}


def make_tool_node(tools: Iterable[Any], gate: Gate) -> Any:
    """Return a langgraph ToolNode where every tool is Custos-gated.

    Lazy import: only fails if you actually call this without langgraph.
    """
    try:
        from langgraph.prebuilt import ToolNode  # type: ignore
    except ImportError as e:
        raise ImportError(
            "make_tool_node requires langgraph. Install with: pip install 'custos-mcp[langgraph]'",
        ) from e
    gated = [gate_tool(t, gate) for t in tools]
    return ToolNode(gated)
