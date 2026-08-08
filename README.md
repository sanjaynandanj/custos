# custos

[![CI](https://github.com/sanjaynandanj/custos/actions/workflows/ci.yml/badge.svg)](https://github.com/sanjaynandanj/custos/actions/workflows/ci.yml)
[![PyPI](https://img.shields.io/pypi/v/custos-mcp?label=pip%20install%20custos-mcp)](https://pypi.org/project/custos-mcp/)
[![npm](https://img.shields.io/npm/v/custos-mcp?label=npm%20install%20custos-mcp)](https://www.npmjs.com/package/custos-mcp)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**Runtime governance, policy enforcement, and cryptographic audit for MCP tool calls.**

Custos sits between an AI agent (MCP client) and its tools (MCP servers). Every `tools/call` is evaluated against a policy, allowed or denied, timed, and appended to an Ed25519-signed hash-chained ledger. The ledger is portable and byte-for-byte verifiable across languages.

Two runtimes, one wire format:

| Package        | Language | Install                 |
|---------------|----------|-------------------------|
| `custos-mcp`  | Python 3.10+ | `pip install custos-mcp` |
| `custos-mcp`  | Node 18+     | `npm install custos-mcp` |

A ledger signed by the Python package verifies in the Node package, and vice versa. This is enforced by `tests/cross-lang/run.sh` on every change.

## Why not [obsigno](https://github.com/amudhan22/obsigno)?

Custos is inspired by obsigno but rewrites it around three ideas obsigno leaves on the table:

1. **Two runtimes, one wire format.** Ledgers, policies, and evidence bundles are language-agnostic. You can write from Python agents and verify from Node auditors, or run the dashboard in whichever runtime your team owns.
2. **First-class in-process SDK.** The proxy is optional. `Gate.call(tool, args, fn)` gates any function without JSON-RPC in the path — useful for testing, embedded agents, and non-MCP tools.
3. **A tight native policy DSL.** Cedar and OPA are optional adapters. The default engine is 200 lines of pure evaluator with the operators you actually use (`prefix`, `regex`, `in`, `exists`, wildcard) and rule-level `reason` strings that flow straight into the audit record.

## Quickstart (Python)

```bash
pip install custos-mcp
custos keygen                                     # write .custos/ledger.{key,pub}
custos proxy --policy policy.yaml -- python -m my_mcp_server
```

```python
from custos import Gate, Ledger, Actor, Server, generate_keypair, load_policy

kp = generate_keypair(); kp.save(".custos")
ledger = Ledger(".custos/ledger.jsonl", kp)
policy = load_policy("policy.yaml")
gate = Gate(policy, ledger, Actor("agent-1"), Server("fs"))

r = gate.call("read_file", {"path": "/workspace/x"}, fn=open_file)
if r.allowed: use(r.result)
```

## Quickstart (Node)

```bash
npm install custos-mcp
npx custos keygen
npx custos proxy --policy policy.yaml -- node my-mcp-server.js
```

```ts
import { Gate, Ledger, generateKeypair, loadPolicy, newActor } from "custos-mcp";

const kp = generateKeypair(); kp.save(".custos");
const ledger = new Ledger(".custos/ledger.jsonl", kp);
const policy = loadPolicy("policy.yaml");
const gate = new Gate(policy, ledger, newActor("agent-1"), { id: "fs" });

const r = await gate.call("read_file", { path: "/workspace/x" }, ({ path }) => readFile(path));
if (r.allowed) use(r.result);
```

## Policy DSL

```yaml
version: 1
id: default
default: deny
rules:
  - id: allow-workspace-read
    when:
      tool: read_file
      args.path: {prefix: "/workspace/"}
    decision: allow
    reason: workspace-only reads

  - id: safe-http-get
    when:
      tool: http_request
      args.method: {in: ["GET", "HEAD"]}
      args.url: {regex: "^https://"}
    decision: allow

  - id: deny-shell
    when: {tool: {regex: "^shell\\."}}
    decision: deny
    reason: shell tools disabled
```

Full DSL: [`spec/POLICY.md`](spec/POLICY.md). Full wire format: [`spec/WIRE.md`](spec/WIRE.md).

## CLI

Both packages ship the same `custos` command:

```
custos keygen                                    # generate ed25519 keypair
custos proxy --policy p.yaml -- <upstream cmd>   # transparent stdio MCP proxy
custos verify --ledger .custos/ledger.jsonl      # verify chain + signatures
custos bundle out.tar.gz                         # export portable evidence
custos verify-bundle out.tar.gz
custos serve                                     # dashboard on :8787
custos show-policy policy.yaml
```

## Ledger format

`ledger.jsonl` — one canonical-JSON record per line, chained by `prev_hash`, signed with Ed25519. Sidecar `ledger.pub` holds the base64-encoded 32-byte public key. Cross-language verification is part of the test suite.

## Docker demo

```bash
docker compose -f docker/docker-compose.yml up --build
docker compose -f docker/docker-compose.yml run --rm generator
# open http://localhost:8787 (Python dashboard)
# open http://localhost:8788 (Node dashboard)
```

Both dashboards read the same signed ledger volume — visual proof of wire compat.

## Repo layout

```
custos/
├── spec/                 # WIRE.md, POLICY.md — the contract both packages implement
├── packages/
│   ├── custos-py/        # Python package (pip install custos-mcp)
│   └── custos-js/        # Node package  (npm install custos-mcp)
├── examples/             # SDK examples + a policy.yaml + a mock MCP server
├── docker/               # multi-runtime compose demo
└── tests/cross-lang/     # Python↔Node ledger interop test
```

## License

Apache-2.0.
