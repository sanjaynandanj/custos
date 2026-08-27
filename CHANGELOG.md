# Changelog

## 0.2.0 — 2026-08-27

Adapter + zero-friction-onboarding release. Framework parity between Node and Python, first-class Claude Agent SDK integration, and everything queued in `Unreleased` since 0.1.0.

### Adapters

- **Claude Agent SDK adapter** (Node + Python) — `gate_tool(tool, gate)` wraps any `@anthropic-ai/claude-agent-sdk` / `claude-agent-sdk` tool so every `.handler` invocation is policy-checked and ledger-recorded. Denies return an MCP-shaped `{ isError: true, content: [...] }` result the model surfaces on its next turn — no exception leaks into the agent loop. Duck-typed on `.name` + `.handler`; safe to import without the SDK installed. `pip install custos-mcp[claude-agent]` on the Python side; import from `custos-mcp/adapters/claude-agent` on Node.
- **LangGraph / LangChain-JS adapter (Node)** (`custos-mcp/adapters/langgraph`) — closes the parity gap with the Python adapter. `gateTool(tool, gate)` wraps any LangChain-JS-shaped tool (`.name` + `.invoke`); denies throw `CustosDenied` for `ToolNode` to surface as a `ToolMessage`. `makeToolNode(tools, gate)` lazily imports `@langchain/langgraph/prebuilt` and returns a fully gated node.
- **LangGraph adapter (Python)** (`custos.adapters.langgraph`, `pip install custos-mcp[langgraph]`) — `gate_tool(tool, gate)` wraps any LangChain-shaped tool so every `.invoke` / `.ainvoke` is policy-checked and ledger-recorded. Denies raise `CustosDenied`, which `ToolNode` surfaces as a `ToolMessage`. `make_tool_node(tools, gate)` returns a fully gated `ToolNode` in one call.
- **OpenTelemetry adapter (Node)** (`custos-mcp/otel`) — mirrors Python's `wrap_gate`. If `@opentelemetry/api` is installed, `wrapGate(gate)` returns a gate that emits a span per `.call` with attributes for tool, decision, rule, latency, and trace id. No-op if the peer dep is missing.
- **Subpath exports** (Node) — `custos-mcp/otel`, `custos-mcp/adapters/langgraph`, `custos-mcp/adapters/claude-agent` are now first-class entry points with their own `.d.ts`. Framework deps declared as optional `peerDependencies`.

### 30-second start

- **`custos init`** (Node + Python) — scaffolds `.custos/` with a keypair, starter `policy.yaml`, and `.gitignore` protecting the signing key + ledger. Idempotent; `--force` overwrites.
- **`custos demo`** (Node + Python) — self-contained end-to-end run against an in-process mock MCP. Three tool calls (allow / path-traversal deny / shell deny), signature chain verified, tmpdir cleaned up. `--keep` retains the ledger for inspection.

### Telemetry (opt-in)

- **Opt-in anonymous telemetry** (Node + Python) — first-run prompt on `custos init`. Off by default. Payload is `{ id (uuid), event, cli version, os, runtime version }` — nothing else. Config at `~/.custos/telemetry.json`. `CUSTOS_TELEMETRY=off` overrides consent; no network activity unless `CUSTOS_TELEMETRY_URL` is set. Wired into `init`, `demo`, `proxy`, `serve` — deliberately NOT into `verify`, `verify-bundle`, `bundle`, or `keygen` (auditor + key ops stay silent).
- **`services/telemetry/`** — Cloudflare Worker + D1 receiver for the pings above. Rejects unknown events, drops overlong fields, records nothing beyond `{ ts, install_id, event, cli_version, os, runtime }`. Ships with `GET /stats` for the traction curve (token-gated by default).

## 0.1.0 — 2026-08-08

Initial release. Both `custos-mcp` (Python) and `custos-mcp` (npm) at 0.1.0.

- Native policy DSL (`prefix`, `suffix`, `contains`, `regex`, `in`, `not_in`, `eq/ne/gt/lt/gte/lte`, `exists`, glob wildcards)
- Ed25519-signed, hash-chained JSONL ledger with tamper detection
- In-process `Gate` SDK — enforce and audit without running as a proxy
- Transparent stdio MCP proxy
- Dashboard on `:8787` in both runtimes
- Portable evidence bundles (`.tar.gz` with signed manifest)
- CLI: `keygen`, `proxy`, `verify`, `bundle`, `verify-bundle`, `serve`, `show-policy`
- Optional Cedar + OPA policy adapters (Python)
- Optional OpenTelemetry span emission (Python)
- Wire compatibility: Python-signed ledgers verify in Node and vice versa
