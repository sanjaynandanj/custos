# custos-mcp

[![npm version](https://img.shields.io/npm/v/custos-mcp.svg)](https://www.npmjs.com/package/custos-mcp)
[![Node versions](https://img.shields.io/node/v/custos-mcp.svg)](https://www.npmjs.com/package/custos-mcp)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](https://github.com/sanjaynandanj/custos/blob/main/LICENSE)

Runtime governance, policy enforcement, and cryptographic audit for MCP tool calls.

Every `tools/call` from an AI agent is evaluated against a policy, allowed or denied, timed, and appended to an Ed25519-signed hash-chained ledger. Wire-compatible with the [Python `custos-mcp`](https://pypi.org/project/custos-mcp/) package — ledgers written by one runtime verify in the other.

```bash
npm install custos-mcp
```

## Quickstart

```ts
import { Gate, Ledger, Policy, loadPolicy, generateKeypair, newActor } from "custos-mcp";

const kp = generateKeypair();
kp.save(".custos");
const ledger = new Ledger(".custos/ledger.jsonl", kp);
const policy = loadPolicy("policy.yaml");

const gate = new Gate(policy, ledger, newActor("agent-1"), { id: "fs" });

const r = await gate.call("read_file", { path: "/workspace/x" }, async ({ path }) => readFile(path));
if (r.allowed) console.log(r.result);
```

## CLI

```bash
npx custos keygen
npx custos proxy --policy policy.yaml -- node my-mcp-server.js
npx custos verify --ledger .custos/ledger.jsonl
npx custos bundle out.tar.gz
npx custos verify-bundle out.tar.gz
npx custos serve
```
