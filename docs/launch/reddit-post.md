# Reddit — r/LocalLLaMA or r/mcp

## Title

Custos v0.3.0 — deny-by-default policy + signed audit ledger for AI agent tool calls (MCP / LangGraph / Claude Agent SDK)

## Body

I ship agents. Every one of them can, in principle, call any tool it has been given with any arguments. If something goes wrong — an injection, a bad plan, a misfiring loop — there is no policy checkpoint before the call runs, and no signed record after. That has been bothering me for a while, so I built Custos.

Custos is a Policy Enforcement Point plus a cryptographic audit ledger that sits in front of tool calls. Every call is evaluated against a policy before it runs, and every decision (allow, deny, error) gets appended to an Ed25519-signed, SHA-256 hash-chained JSONL file. Tamper with any record and the chain breaks — verifiable offline with just the file and the public key.

Integration surfaces today:

- **stdio MCP proxy** — wrap any MCP server, zero server changes
- **In-process Gate SDK** — `gate.call(tool, args, fn)` in Python or Node
- **LangGraph adapter** — `gate_tool(tool, gate)` wraps any LangChain tool
- **Claude Agent SDK adapter** — same shape, MCP-style deny result the model can react to

Policy is a small YAML DSL: `prefix`, `suffix`, `contains`, `regex`, `in`, `not_in`, `eq`, `ne`, `gt`, `lt`, `gte`, `lte`, `exists`. Deny by default. First-match-wins.

```yaml
version: 1
id: coding-agent
default: deny
rules:
  - id: no-traversal
    when: { args.path: { contains: ".." } }
    decision: deny
  - id: allow-workspace-read
    when:
      tool: read_file
      args.path: { prefix: "/workspace/" }
    decision: allow
  - id: deny-rm-rf
    when:
      tool: shell_exec
      args.cmd: { regex: "rm\\s+-rf" }
    decision: deny
```

Python and Node speak the same wire format — sign a ledger in Python, verify it in Node. Cedar and OPA adapters are shipped as experimental for teams already invested in those engines.

Apache-2.0. No SaaS lock-in, no telemetry by default (opt-in on first `custos init`).

Would love feedback on the DSL — especially from anyone who has written a lot of Rego or Cedar. Is `first-match-wins` the right default, or should we add a `combine: deny-overrides` mode? Are there operators I am missing that show up in your policies constantly?

https://github.com/sanjaynandanj/custos
