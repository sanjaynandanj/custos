"""LangGraph + Custos: wrap any tool so every call is policy-gated and audited.

Run:
    pip install custos-mcp[langgraph] langchain-core
    python examples/langgraph_example.py
"""
from langchain_core.tools import tool

from custos import Actor, Gate, Ledger, Server, generate_keypair, load_policy
from custos.adapters.langgraph import CustosDenied, gate_tool


@tool
def read_file(path: str) -> str:
    """Read a file from disk."""
    with open(path) as f:
        return f.read()


@tool
def shell_exec(cmd: str) -> str:
    """Run a shell command."""
    import subprocess
    return subprocess.check_output(cmd, shell=True, text=True)


def main() -> None:
    kp = generate_keypair()
    kp.save(".custos")
    ledger = Ledger(".custos/ledger.jsonl", kp)
    policy = load_policy({
        "version": 1,
        "id": "example",
        "default": "deny",
        "rules": [
            {"id": "no-traversal", "when": {"args.path": {"contains": ".."}}, "decision": "deny", "reason": "path traversal"},
            {"id": "allow-workspace", "when": {"tool": "read_file", "args.path": {"prefix": "/workspace/"}}, "decision": "allow"},
            {"id": "deny-shell", "when": {"tool": {"regex": "^shell.*"}}, "decision": "deny", "reason": "shell disabled"},
        ],
    })
    gate = Gate(policy, ledger, Actor("agent-1"), Server("langgraph-app"))

    # Wrap once; use anywhere a LangChain tool goes (ToolNode, agent executor, etc.).
    safe_read = gate_tool(read_file, gate)
    safe_shell = gate_tool(shell_exec, gate)

    print(safe_read.invoke({"path": "/workspace/README.md"}))  # allowed

    try:
        safe_shell.invoke({"cmd": "id"})
    except CustosDenied as e:
        print(f"denied: {e.reason} (rule={e.rule}, trace={e.trace_id})")


if __name__ == "__main__":
    main()
