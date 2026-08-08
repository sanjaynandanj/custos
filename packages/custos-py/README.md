# custos-mcp

[![PyPI version](https://img.shields.io/pypi/v/custos-mcp.svg)](https://pypi.org/project/custos-mcp/)
[![Python versions](https://img.shields.io/pypi/pyversions/custos-mcp.svg)](https://pypi.org/project/custos-mcp/)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](https://github.com/sanjaynandanj/custos/blob/main/LICENSE)

Runtime governance, policy enforcement, and cryptographic audit for MCP tool calls.

Every `tools/call` from an AI agent is evaluated against a policy, allowed or denied, timed, and appended to an Ed25519-signed hash-chained ledger. The ledger format is wire-compatible with the [Node package](https://www.npmjs.com/package/custos-mcp) — audit anywhere.

```bash
pip install custos-mcp[web]
```

## Quickstart

```python
from custos import Gate, Ledger, Actor, Server, generate_keypair, load_policy

kp = generate_keypair()
kp.save(".custos")
ledger = Ledger(".custos/ledger.jsonl", kp)
policy = load_policy("policy.yaml")

gate = Gate(policy, ledger, Actor("agent-1"), Server("fs"))

result = gate.call("read_file", {"path": "/workspace/x"}, fn=open_file)
if result.allowed:
    print(result.result)
```

## CLI

```bash
custos keygen                            # write .custos/ledger.key + ledger.pub
custos proxy --policy policy.yaml -- python -m my_mcp_server
custos verify --ledger .custos/ledger.jsonl
custos bundle out.tar.gz                 # export portable evidence
custos verify-bundle out.tar.gz
custos serve                             # dashboard on :8787
```

## Policy DSL

```yaml
version: 1
id: default
default: deny
rules:
  - id: allow-read
    when:
      tool: read_file
      args.path: {prefix: "/workspace/"}
    decision: allow
    reason: workspace-only reads
```

See `spec/POLICY.md` for the full grammar.
