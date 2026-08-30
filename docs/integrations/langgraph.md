# Integrating Custos with LangGraph

The Custos LangGraph adapter wraps any LangChain-shaped tool so every `.invoke` / `.ainvoke` is policy-checked and recorded in the ledger. Denies raise `CustosDenied`, which LangGraph's `ToolNode` converts into a `ToolMessage` the LLM sees on its next turn — no special graph wiring required.

Adapter source: `packages/custos-py/src/custos/adapters/langgraph.py`.

## Install

```bash
pip install 'custos-mcp[langgraph]' langchain-core
```

Two entry points:

- `gate_tool(tool, gate)` — wraps a single tool. Duck-typed on `.name` + `.invoke` / `.ainvoke`; no `langgraph` import required at module load.
- `make_tool_node(tools, gate)` — convenience wrapper. Lazily imports `langgraph.prebuilt.ToolNode` and returns a fully gated node.

## Runnable example

```python
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

# 1. Custos setup — keypair, ledger, policy, gate.
kp = generate_keypair()
kp.save(".custos")
ledger = Ledger(".custos/ledger.jsonl", kp)
policy = load_policy({
    "version": 1, "id": "langgraph-demo", "default": "deny",
    "rules": [
        {"id": "no-traversal", "when": {"args.path": {"contains": ".."}},
         "decision": "deny", "reason": "path traversal"},
        {"id": "allow-workspace", "when": {"tool": "read_file",
         "args.path": {"prefix": "/workspace/"}}, "decision": "allow"},
        {"id": "deny-shell", "when": {"tool": {"regex": "^shell.*"}},
         "decision": "deny", "reason": "shell disabled"},
    ],
})
gate = Gate(policy, ledger, Actor("agent-1"), Server("langgraph-app"))

# 2. Wrap tools in place. Returned tool preserves .name / .description / .args_schema.
safe_read = gate_tool(read_file, gate)
safe_shell = gate_tool(shell_exec, gate)

# 3. Allow path — succeeds, ledger gets ALLOW record.
print(safe_read.invoke({"path": "/workspace/README.md"}))

# 4. Deny path — CustosDenied raised. Inside a LangGraph ToolNode this becomes a
#    ToolMessage the LLM reacts to on the next turn.
try:
    safe_shell.invoke({"cmd": "id"})
except CustosDenied as e:
    print(f"denied: {e.reason} (rule={e.rule}, trace={e.trace_id})")
```

Run it:

```bash
python examples/langgraph_example.py
custos verify --ledger .custos/ledger.jsonl
```

## Using inside a graph

Once tools are wrapped you use them exactly like any LangChain tool:

```python
from langgraph.graph import StateGraph, END
from custos.adapters.langgraph import make_tool_node

tools = [gate_tool(t, gate) for t in [read_file, shell_exec]]
# or:
tool_node = make_tool_node([read_file, shell_exec], gate)

graph = StateGraph(dict)
graph.add_node("tools", tool_node)
# ... rest of your graph
```

Denies flow through as `ToolMessage` content — the LLM sees `"custos denied [deny-shell]: shell disabled"` and can plan a different next step (ask the user, try a different tool, stop).

## Node / TypeScript

The Node adapter is symmetric: `import { gateTool, makeToolNode } from 'custos-mcp/adapters/langgraph'`. Same `.name` + `.invoke` shape; same deny throwing pattern.
