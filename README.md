<div align="center">

# custos

**Runtime governance, policy enforcement, and cryptographic audit for MCP tool calls.**

Every tool call your AI agent makes — read a file, hit an API, run a query — is intercepted, evaluated against your policy, and recorded in a tamper-proof signed ledger. Before execution. Every time.

[![PyPI](https://img.shields.io/pypi/v/custos-mcp?color=0073b7&label=PyPI&logo=pypi&logoColor=white)](https://pypi.org/project/custos-mcp/)
[![npm](https://img.shields.io/npm/v/custos-mcp?color=cb3837&label=npm&logo=npm&logoColor=white)](https://www.npmjs.com/package/custos-mcp)
[![Python](https://img.shields.io/badge/python-3.10%2B-3776AB?logo=python&logoColor=white)](https://pypi.org/project/custos-mcp/)
[![Node](https://img.shields.io/badge/node-18%2B-339933?logo=node.js&logoColor=white)](https://www.npmjs.com/package/custos-mcp)
[![Tests](https://img.shields.io/badge/tests-82%20passing-brightgreen?logo=pytest&logoColor=white)](tests/)
[![Wire compat](https://img.shields.io/badge/wire-cross--language-7c3aed)](tests/cross-lang/)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

```
pip install custos-mcp        # Python 3.10+
npm install custos-mcp        # Node 18+
```

</div>

---

## Custos × WebMCP

> **New:** Custos ships an adapter for the emerging
> [WebMCP](https://webmachinelearning.github.io/webmcp/) standard, plus a
> complete demo application built for the OpenAI WebMCP Challenge:
> the **Custos Agent Operations Control Room**.

WebMCP lets a website expose real, structured tools to an AI agent running
in the user's browser via `document.modelContext.registerTool(...)`. That
means the agent inherits everything an authenticated user can do. Custos
sits in the middle:

```
AI Agent  ─►  WebMCP  ─►  Custos  ─►  ALLOW / APPROVAL / DENY  ─►  Web Application
```

- **`packages/custos-js/src/adapters/webmcp.ts`** — browser-safe adapter
  that registers Custos-gated WebMCP tools. Normalises Custos allow /
  deny / approval outcomes into MCP-shaped tool results, and propagates
  `AbortSignal` cancellation.
- **`examples/webmcp-control-room/`** — simulated cloud operations
  console with 8 WebMCP tools. Read tools auto-allow; production
  restart / rollback / config write require **human approval**;
  production delete is **hard-denied**. Every decision lands in the
  existing Custos Ed25519-signed hash-chained ledger.

Docs: [`docs/webmcp/PRD.md`](docs/webmcp/PRD.md) ·
[`TRD`](docs/webmcp/TRD.md) ·
[`SECURITY`](docs/webmcp/SECURITY.md) ·
[`DEMO_SCRIPT`](docs/webmcp/DEMO_SCRIPT.md). Challenge disclosure:
[`WEBMCP_CHALLENGE.md`](WEBMCP_CHALLENGE.md).

Quickstart:

```sh
cd examples/webmcp-control-room
npm install && npm run build && npm start
# open http://localhost:4173
```

---

## What is Custos?

AI agents call tools. Tools read files, hit APIs, run shell commands, query databases. Without governance, an agent can call *anything* with *any* arguments — and there is no record that it happened.

Custos puts a gate in front of every tool call:

```
  ┌─────────────┐        tools/call        ┌──────────────────────┐        ┌─────────────┐
  │             │ ───────────────────────► │                      │        │             │
  │  AI Agent   │                          │    Custos Gate       │ ──────►│  MCP Server │
  │  (client)   │ ◄─────────────────────── │  policy + ledger     │        │   / tool    │
  │             │   result or deny error   │                      │        │             │
  └─────────────┘                          └──────────────────────┘        └─────────────┘
                                                      │
                                                      ▼
                                            ┌──────────────────┐
                                            │  ledger.jsonl    │
                                            │  ──────────────  │
                                            │  seq:0  sha256:● │
                                            │  seq:1  sha256:● │
                                            │  seq:2  sha256:● │
                                            │  Ed25519 signed  │
                                            └──────────────────┘
```

**Every call produces a decision record:** who called what with which arguments, was it allowed or denied, how long it took, which policy rule matched, and why. Records are Ed25519-signed and hash-chained — any modification to any record breaks the chain and is immediately detectable.

---

## What Custos proves — and what it does not

Two GRC reviewers separately pointed at the shape of the same problem:
a signed log can prove records weren't altered, but it can't prove the
control was actually in the path. Silence in a log means either
"nothing happened" or "you stopped observing." Custos is honest about
which claims it can make and which it cannot.

### Custos proves cryptographically

- **The records it emitted have not been altered** — SHA-256 hash chain
  + Ed25519 signatures, verified with `custos verify`.
- **Which policy was in effect at each decision** — every record
  carries `policy.hash`, a `sha256:` fingerprint of the exact policy
  source. `custos verify --replay` reconstructs the rule that fired
  from a content-addressed snapshot; missing or swapped policies are
  flagged.
- **The control was observably running across a time window** —
  attestation records (`type: "attestation"`) interleaved in the chain
  bracket periods of liveness. `custos verify --coverage` reports gaps
  larger than a configured tolerance.
- **Whether a `deny` blocked the action or merely opined about it** —
  `enforcement.point` and `enforcement.effect` label every record so
  an auditor can distinguish `blocked` (the call didn't run) from
  `advisory` (staged-rollout mode; the call ran anyway).

### Custos proves — *with downstream cooperation*

- **That every call the tool executed was gated** — the SDK and proxy
  emit a signed per-call attestation token
  (`custos:v1:<payload>.<sig>`) on every ALLOW. Cooperating tool
  servers verify it via `custos.token.verify_token` before executing
  and log verified / rejected / unattested. Cross-checking the
  tool-side log against the Custos ledger produces the missing
  evidence: every allow must appear as verified downstream; any
  unattested downstream call is a smoking gun for bypass.

### Custos does not prove

- **That the tool has no other reachable path.** Coverage attestation
  needs the tool to check tokens. A tool that doesn't verify tokens,
  or credentials scoped so agents can reach the resource without going
  through Custos, defeat the ledger's authority. That is a
  deployment-layer property (network policy, credential scoping,
  container boundaries) outside the ledger's scope.
- **That records exist for calls that never reached Custos.** The
  ledger is closed under "calls that were gated." Attestation records
  bound coverage to the extent of `custos verify --coverage` and
  attestation-token verification on the tool side; neither eliminates
  the class of bypass.
- **That the recorded arguments actually satisfied the matched
  rule.** Records store `args_hash`, not `args`, to keep tool inputs
  out of the audit surface. `verify --replay` proves the rule
  identified in the record exists in the policy at that hash with the
  recorded decision — argument-level replay requires an out-of-band
  args log the operator opts into.

This is the shape of the evidence, stated plainly. If your reviewer
asks what a Custos ledger authoritatively answers, point them here.

### Operational notes worth calling out

A few properties of the current implementation that GRC readers ask
about, stated plainly rather than buried in the code:

- **Attestation records name the active actors in plaintext.**
  `attestation.active_actors` is a list of `actor.id` values. In a
  multi-tenant deployment where `actor.id` is tenant-scoped
  (`agent-acme-corp`), attestation records leak tenant names to
  anyone with the ledger. If that matters, use opaque IDs.
- **`active_actors` is not bounded.** A proxy gating a thousand agents
  produces attestations carrying a thousand IDs each. At current
  scale this is fine; large deployments should either hash actor IDs
  or emit per-actor attestations.
- **Multiple Gates on the same ledger share one policy snapshot
  directory.** `<ledger>/../policies/` is content-addressed, so
  concurrent snapshots are idempotent and safe — but no per-Gate
  isolation. If two Gates in the same process load different policies
  with the same `id`, both hashes land in one directory; the
  content-addressed naming keeps them distinct.
- **`verify --coverage` requires periodic attestations from the
  operator.** The Gate emits `startup`; nothing emits `periodic`
  automatically yet. A ledger with only startup attestations shows
  gaps between restart events, which is often useful (restart cycles
  as coverage bounds) but is not a substitute for a real heartbeat
  cadence. Call `ledger.append_attestation(reason="periodic", ...)`
  on your own timer.
- **Token freshness is application policy, not library policy.**
  `verify_token` checks the signature but not the age of `ts`. If a
  tool server accepts attested calls, it MUST also reject tokens
  older than a bounded window (recommended: 300s) — otherwise a
  captured token replays forever.

None of these are bugs. They are boundaries between what the runtime
enforces and what the operator has to choose. Stating them here
prevents an auditor from finding them for you.

---

## Features

- **Policy-first** — every `tools/call` is evaluated before execution. Deny by default.
- **Native policy DSL** — YAML rules with `prefix`, `suffix`, `regex`, `in`, `exists`, glob wildcards. No external engine required.
- **Cryptographic audit ledger** — Ed25519-signed, SHA-256 hash-chained JSONL. Tamper-evident, offline-verifiable.
- **Two runtimes, one wire format** — Python and Node produce identical ledger records. Sign in Python, verify in Node. Enforced by the test suite.
- **In-process SDK** — `Gate.call(tool, args, fn)` gates any function without running a proxy subprocess.
- **Transparent stdio proxy** — drop in front of any MCP server with zero server code changes.
- **Portable evidence bundles** — export a `.tar.gz` with ledger + signed manifest for compliance hand-off.
- **Live dashboard** — real-time allow/deny/error breakdown, trace view, tool filter at `:8787`.
- **Optional adapters** — Cedar policy engine, OPA sidecar, OpenTelemetry spans (Python).
- **CLI parity** — same `custos` commands in both runtimes.

---

## How the ledger works

```
  ┌────────────────────────────────────────────────────────────────────┐
  │  Record (seq=0)                                                    │
  │  prev_hash : sha256:0000...0000  (genesis)                         │
  │  tool      : read_file                                             │
  │  decision  : allow                                                 │
  │  args_hash : sha256:a3f2...                                        │
  │  ts        : 2026-08-08T12:00:00.000Z                             │
  │  record_hash: sha256:b1c9...  ◄─────────────────────────────┐     │
  │  sig        : ed25519:BASE64                                  │     │
  └────────────────────────────────────────────────────────────────┘     │
                                                                         │
  ┌────────────────────────────────────────────────────────────────────┐ │
  │  Record (seq=1)                                                    │ │
  │  prev_hash : sha256:b1c9...  ──────────────────────────────────────┘ │
  │  tool      : shell.exec                                             │
  │  decision  : deny                                                   │
  │  record_hash: sha256:d4e7...  ◄────────────────────────────────┐   │
  │  sig        : ed25519:BASE64                                    │   │
  └────────────────────────────────────────────────────────────────┘   │
                                                                        │
  ┌───────────────────────────────────────────────────────────────────┐ │
  │  Record (seq=2)                                                   │ │
  │  prev_hash : sha256:d4e7...  ─────────────────────────────────────┘ │
  │  ...                                                              │
  └───────────────────────────────────────────────────────────────────┘
```

Each record's `record_hash` is the SHA-256 of its own canonical JSON body. The signature covers the hash digest. Breaking the chain or forging a record requires the private key.

---

## 30-second start

```bash
# Node
npx custos-mcp init      # scaffolds .custos/ (keypair + starter policy + .gitignore)
npx custos-mcp demo      # runs 3 tool calls (1 allow, 2 deny) against a mock MCP + verifies the ledger

# Python
pip install custos-mcp
custos init
custos demo
```

`init` also prompts once, opt-in, about anonymous usage counts. Say no and it never asks again.
Set `CUSTOS_TELEMETRY=off` to disable at any time.

---

## Quickstart — Python

```bash
pip install custos-mcp[web]   # +web adds the FastAPI dashboard
```

### 1. Generate a keypair

```bash
custos keygen
# wrote .custos/ledger.key + ledger.pub
```

### 2. Write a policy

```yaml
# policy.yaml
version: 1
id: my-agent
default: deny

rules:
  - id: allow-workspace-reads
    when:
      tool: read_file
      args.path: {prefix: "/workspace/"}
    decision: allow
    reason: workspace-only reads

  - id: safe-https-get
    when:
      tool: http_request
      args.method: {in: ["GET", "HEAD"]}
      args.url: {regex: "^https://"}
    decision: allow
    reason: safe HTTP reads

  - id: block-shell
    when: {tool: {regex: "^shell\\."}}
    decision: deny
    reason: shell tools disabled
```

### 3a. In-process SDK (recommended)

```python
from custos import Gate, Ledger, Actor, Server, generate_keypair, load_policy

kp = generate_keypair()
kp.save(".custos")

ledger = Ledger(".custos/ledger.jsonl", kp)
policy = load_policy("policy.yaml")
gate   = Gate(policy, ledger, Actor("agent-1"), Server("fs-server"))

# Wrap any tool function
result = gate.call("read_file", {"path": "/workspace/notes.md"}, fn=open_file)

if result.allowed:
    print(result.result)       # the tool's return value
else:
    print(result.reason)       # why it was denied
```

### 3b. Stdio proxy (zero server changes)

```bash
custos proxy \
  --policy policy.yaml \
  --actor-id agent-1 \
  --server-id fs-server \
  -- python -m my_mcp_server
```

The proxy transparently forwards all MCP traffic except `tools/call`, which it gates.

### 4. Verify the ledger

```bash
custos verify --ledger .custos/ledger.jsonl
# OK  42 records verified
```

### 5. Launch the dashboard

```bash
custos serve
# open http://localhost:8787
```

---

## Quickstart — Node / TypeScript

```bash
npm install custos-mcp
```

### 1. Generate a keypair

```bash
npx custos keygen
```

### 2. In-process SDK

```typescript
import { Gate, Ledger, generateKeypair, loadPolicy, newActor } from "custos-mcp";
import { readFile } from "node:fs/promises";

const kp     = generateKeypair();
kp.save(".custos");

const ledger = new Ledger(".custos/ledger.jsonl", kp);
const policy = loadPolicy("policy.yaml");          // same YAML as Python
const gate   = new Gate(policy, ledger, newActor("agent-1"), { id: "fs-server" });

const result = await gate.call(
  "read_file",
  { path: "/workspace/notes.md" },
  ({ path }) => readFile(path, "utf8"),
);

if (result.allowed) console.log(result.result);
else                console.log(result.reason);
```

### 3. Stdio proxy

```bash
npx custos proxy \
  --policy policy.yaml \
  --actor-id agent-1 \
  -- node my-mcp-server.js
```

### 4. Verify + dashboard

```bash
npx custos verify
npx custos serve       # http://localhost:8787
```

---

## Policy DSL reference

Rules are evaluated **top to bottom — first match wins**. If no rule matches, `default` applies.

```yaml
version: 1
id: my-policy
default: deny        # allow | deny

rules:
  - id: my-rule
    when:
      tool: read_file              # exact match (supports * glob)
      actor.id: "agent-*"         # glob wildcard
      args.path: {prefix: "/workspace/"}
      args.method: {in: ["GET", "HEAD"]}
      args.url: {regex: "^https://"}
      args.size: {lte: 10485760}  # numeric: gt, lt, gte, lte
      args.token: {exists: false} # field presence
    decision: allow
    reason: "human-readable reason recorded in the audit log"
```

### Match operators

| Operator | Example | Meaning |
|----------|---------|---------|
| scalar / `*` glob | `"agent-*"` | exact match or glob wildcard |
| `prefix` | `{prefix: "/workspace/"}` | string starts with |
| `suffix` | `{suffix: ".json"}` | string ends with |
| `contains` | `{contains: ".."}` | substring (catches path traversal) |
| `regex` | `{regex: "^https://"}` | PCRE / ECMA regex, unanchored |
| `in` | `{in: ["GET","HEAD"]}` | value in list |
| `not_in` | `{not_in: ["DELETE"]}` | value not in list |
| `eq` / `ne` | `{eq: 42}` | exact / not exact |
| `gt` / `lt` / `gte` / `lte` | `{lte: 1048576}` | numeric compare |
| `exists` | `{exists: false}` | field presence / absence |

### Dotted path resolution

Match keys are dotted paths into the call context:

```
tool         → "read_file"
actor.id     → "agent-1"
actor.kind   → "mcp-client"
server.id    → "fs-server"
args.*       → any argument field
trace_id     → ULID trace identifier
```

---

## Cross-language wire compatibility

The ledger format is a formal spec (`spec/WIRE.md`). Both packages implement it independently and the test suite proves they produce identical output:

```
tests/cross-lang/run.sh
  ├── Python writes 6 records (5 allow + 1 deny, with Unicode args)
  ├── Node verifies Python's ledger    → OK
  ├── Node writes 6 records
  └── Python verifies Node's ledger   → OK
```

This means:
- An agent written in Python can be audited by a compliance tool written in Node
- You can run both dashboards over the same ledger file simultaneously
- Evidence bundles can be verified without the runtime that created them

---

## Evidence bundles

A signed, portable audit export for compliance hand-off:

```bash
custos bundle audit-2026-08.tar.gz
```

The bundle contains:

```
bundle/
  manifest.json      # record count, pubkey, timestamp
  manifest.sig       # Ed25519 signature of the manifest
  ledger.jsonl       # the full signed chain
  ledger.pub         # verifier public key
  policies/          # snapshot of the active policy
```

Verify offline without running Custos:

```bash
custos verify-bundle audit-2026-08.tar.gz
# OK  1247 records verified
```

---

## Use cases

### Compliant AI agents in regulated industries

Run a coding or document-processing agent inside your SOC 2 / HIPAA perimeter. Define a policy that allows only approved tool calls, collect the signed ledger, and hand the evidence bundle to your auditor. They can verify it cryptographically without access to your system.

### Multi-agent security boundary

In a multi-agent pipeline, each sub-agent gets its own policy and actor ID. The shared ledger gives you a correlated trace across all agents via `trace_id`, so you can reconstruct exactly what happened and in what order.

### Development guardrails

During development, run agents with a permissive policy but collect the full ledger. Review it to understand what tools your agent actually calls — then tighten the policy before production.

### Red-teaming and jailbreak detection

Log every denied call. A spike in denies with `shell.*` tools or path traversal attempts (`args.path contains ..`) is a signal your agent is being prompted adversarially.

### Audit trail for SaaS AI features

If you offer AI-powered features to customers, each customer gets their own policy and ledger. You have per-customer proof of what the agent accessed on their behalf.

---

## CLI reference

Both packages ship the same `custos` command:

```
custos init                                         Scaffold .custos/ (keypair + starter policy)
custos demo                                         Self-contained end-to-end run (30s)
custos keygen                                       Generate Ed25519 keypair
custos proxy --policy p.yaml -- <cmd>              Transparent stdio MCP proxy
custos verify [--ledger path] [--pub path]         Verify ledger chain + sigs
custos bundle [--ledger path] output.tar.gz        Export evidence bundle
custos verify-bundle bundle.tar.gz                 Verify evidence bundle
custos serve [--host h] [--port p]                 Launch dashboard (default :8787)
custos show-policy policy.yaml                     Print normalized policy
```

---

## Dashboard

```bash
custos serve                   # Python (FastAPI)
npx custos serve               # Node (built-in http)
```

Both open a live dashboard at `http://localhost:8787`:

- **Stats bar** — total calls, allow / deny / error counts
- **Record table** — tool, decision, actor, rule, reason, trace ID — auto-refreshes every 5s
- **Filter** — by tool name and decision
- **Trace view** — `GET /api/trace/:id` returns all records for a correlated trace

---

## Optional adapters (Python)

### Cedar policy engine

```bash
pip install custos-mcp[cedar]
```

```python
from custos.adapters.cedar import CedarPolicy
policy = CedarPolicy(id="my-cedar", policy_text=open("policy.cedar").read())
```

### OPA sidecar

```bash
pip install custos-mcp   # OPA runs as a separate process
```

```python
from custos.adapters.opa import OpaPolicy
policy = OpaPolicy(id="my-opa", url="http://localhost:8181/v1/data/custos/authz")
```

### OpenTelemetry spans

```bash
pip install custos-mcp[otel]
```

```python
from custos.otel import wrap_gate
gate = wrap_gate(gate)   # emits a span per call with decision/rule/latency attrs
```

---

## Repo walkthrough

```
custos/
│
├── spec/
│   ├── WIRE.md          Canonical JSON encoding, hash-chain algorithm,
│   │                    Ed25519 signing scheme, ledger file format,
│   │                    evidence bundle structure, trace correlation
│   └── POLICY.md        Policy DSL grammar, match operators, evaluation
│                        order, cookbook with common patterns
│
├── packages/
│   ├── custos-py/                    Python package
│   │   └── src/custos/
│   │       ├── canonical.py          Canonical JSON (sort keys, no whitespace)
│   │       ├── keys.py               Ed25519 keypair — generate, save, load
│   │       ├── record.py             DecisionRecord dataclass + serialization
│   │       ├── ledger.py             Append-only JSONL ledger, thread-safe
│   │       ├── policy.py             Native DSL evaluator (200 lines)
│   │       ├── sdk.py                Gate — in-process sync + async API
│   │       ├── proxy.py              Transparent asyncio stdio proxy
│   │       ├── verify.py             Offline chain + signature verifier
│   │       ├── bundle.py             Evidence bundle export + verify
│   │       ├── dashboard.py          FastAPI app + HTML dashboard
│   │       ├── ids.py                ULID trace IDs, hex span IDs
│   │       ├── otel.py               OpenTelemetry span wrapper
│   │       ├── init.py               `custos init` scaffolder
│   │       ├── demo.py               `custos demo` end-to-end walkthrough
│   │       ├── telemetry.py          Opt-in anonymous usage counters
│   │       ├── cli.py                Click CLI (keygen/proxy/verify/serve...)
│   │       └── adapters/
│   │           ├── cedar.py          Cedar policy engine adapter
│   │           ├── opa.py            OPA HTTP sidecar adapter
│   │           ├── langgraph.py      LangGraph tool node adapter
│   │           └── claude_agent.py   Claude Agent SDK adapter
│   │
│   └── custos-js/                    Node / TypeScript package
│       └── src/
│           ├── canonical.ts          Canonical JSON — byte-identical to Python
│           ├── keys.ts               Ed25519 via node:crypto
│           ├── record.ts             DecisionRecord types
│           ├── ledger.ts             Append-only JSONL ledger
│           ├── policy.ts             Native DSL evaluator
│           ├── sdk.ts                Gate — async API
│           ├── proxy.ts              Transparent stdio proxy
│           ├── verify.ts             Offline verifier
│           ├── bundle.ts             Evidence bundle (pure tar+gzip, no deps)
│           ├── dashboard.ts          Dashboard via node:http
│           ├── ids.ts                ULID + span IDs
│           ├── init.ts               `custos init` scaffolder
│           ├── demo.ts               `custos demo` end-to-end walkthrough
│           ├── telemetry.ts          Opt-in anonymous usage counters
│           ├── cli.ts                CLI — mirrors Python commands
│           ├── index.ts              Public API surface
│           └── adapters/
│               ├── langgraph.ts      LangGraph tool node adapter
│               └── claude-agent.ts   Claude Agent SDK adapter
│
├── tests/
│   └── cross-lang/
│       ├── run.sh         End-to-end: Python writes → Node verifies
│       │                              Node writes → Python verifies
│       ├── py_write.py    Writes a signed ledger via Python SDK
│       ├── py_verify.py   Verifies a ledger via Python verifier
│       ├── js_write.mjs   Writes a signed ledger via Node SDK
│       └── js_verify.mjs  Verifies a ledger via Node verifier
│
├── examples/
│   ├── policy.yaml              Production-ready starter policy
│   ├── python_sdk_example.py    Python Gate SDK walkthrough
│   ├── node_sdk_example.mjs     Node Gate SDK walkthrough
│   └── mock_mcp_server.py       Minimal MCP server for local testing
│
├── services/
│   └── telemetry/               Cloudflare Worker that receives opt-in
│                                anonymous usage counters (no PII)
│
├── docs/                        Static landing/marketing page for the
│                                project (deployed alongside packages)
│
└── docker/
    ├── Dockerfile.python        Python dashboard image
    ├── Dockerfile.node          Node dashboard image
    └── docker-compose.yml       Both dashboards + traffic generator
                                 sharing a single signed ledger volume
```

---

## Docker demo

Run both dashboards side-by-side over a shared signed ledger:

```bash
docker compose -f docker/docker-compose.yml up --build

# In a second terminal — generate traffic:
docker compose -f docker/docker-compose.yml run --rm generator

# Python dashboard: http://localhost:8787
# Node dashboard:   http://localhost:8788
```

Both dashboards read the same `ledger.jsonl` — you can watch the same records appear in both UIs simultaneously.

---

## Installing

| Runtime | Command | Extras |
|---------|---------|--------|
| Python | `pip install custos-mcp` | `[web]` FastAPI dashboard · `[otel]` OpenTelemetry · `[cedar]` Cedar engine |
| Node | `npm install custos-mcp` | — all included |

Python extras:
```bash
pip install custos-mcp[web]          # dashboard
pip install custos-mcp[web,otel]     # dashboard + OTel
pip install custos-mcp[all]          # everything
```

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: the wire spec is the contract — any change to the on-disk format must update `spec/WIRE.md` first, then both packages, then `tests/cross-lang/run.sh` must pass.

---

## License

[Apache-2.0](LICENSE)
