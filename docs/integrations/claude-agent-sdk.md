# Integrating Custos with the Claude Agent SDK

The Custos Claude Agent SDK adapter wraps any tool defined with `@tool` (or the equivalent `SdkMcpTool` shape) so its handler is policy-checked and recorded. Denies return an MCP-shaped `isError: true` result the model surfaces on its next turn — no exception leaks into the agent loop.

Adapter source: `packages/custos-py/src/custos/adapters/claude_agent.py`.

## Install

```bash
pip install 'custos-mcp[claude-agent]' claude-agent-sdk
```

Duck-typed on `.name` + `.handler(args)`. The wrapper preserves `.name`, `.description`, and `.input_schema` untouched so the SDK's registration logic sees an identical object.

## Runnable example

```python
from claude_agent_sdk import tool, create_sdk_mcp_server
from custos import Actor, Gate, Ledger, Server, generate_keypair, load_policy
from custos.adapters.claude_agent import gate_tool

@tool("read_file", "Read a file", {"path": str})
async def read_file(args):
    with open(args["path"]) as f:
        return {"content": [{"type": "text", "text": f.read()}]}

@tool("shell_exec", "Run a shell command", {"cmd": str})
async def shell_exec(args):
    import subprocess
    out = subprocess.check_output(args["cmd"], shell=True, text=True)
    return {"content": [{"type": "text", "text": out}]}

# 1. Custos setup.
kp = generate_keypair()
kp.save(".custos")
ledger = Ledger(".custos/ledger.jsonl", kp)
policy = load_policy({
    "version": 1, "id": "cas-demo", "default": "deny",
    "rules": [
        {"id": "no-traversal", "when": {"args.path": {"contains": ".."}},
         "decision": "deny", "reason": "path traversal"},
        {"id": "allow-workspace", "when": {"tool": "read_file",
         "args.path": {"prefix": "/workspace/"}}, "decision": "allow"},
        {"id": "deny-shell", "when": {"tool": "shell_exec"},
         "decision": "deny", "reason": "shell disabled"},
    ],
})
gate = Gate(policy, ledger, Actor("agent-1"), Server("cas-fs"))

# 2. Wrap in place — safe to hand straight to create_sdk_mcp_server.
gate_tool(read_file, gate)
gate_tool(shell_exec, gate)

server = create_sdk_mcp_server("fs", "0.1", tools=[read_file, shell_exec])
```

## What the model sees on deny

The wrapper returns:

```json
{
  "content": [
    {"type": "text",
     "text": "custos denied [deny-shell]: shell disabled (trace 01HZ...)"}
  ],
  "isError": true
}
```

Standard MCP error shape. The Claude Agent SDK routes this back into the loop as tool output; the model reads the deny reason and typically replans. No `try/except` needed in your agent code.

## Batch wrapping

```python
from custos.adapters.claude_agent import gate_tools
gate_tools([read_file, shell_exec, write_file], gate)
```

## Async vs sync handlers

The wrapper inspects the original handler with `inspect.iscoroutinefunction` and generates the matching sync or async wrapper — you don't have to think about it.

## Node / TypeScript

The Node adapter (`custos-mcp/adapters/claude-agent`) mirrors the Python one — same duck-typing, same MCP-shaped deny result.
