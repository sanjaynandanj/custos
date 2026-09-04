# Changelog

## 0.4.0 — 2026-09-04

Auditor-facing release. Two GRC reviewers pointed at real gaps in the
evidence story: (a) records didn't pin *which* policy fired, only its
name; (b) a signed chain proves records weren't altered, not that the
control was actually in the path. This release closes both without
overselling either. Wire spec bumped additively — pre-v0.4.0 ledgers
verify unchanged; new writers layer the additional fields.

### Point-in-time policy reconstruction

- **`policy.hash` on every DecisionRecord** (WIRE §6.1) — `sha256:` of
  the exact policy source live at decision time. File-backed policies
  hash raw bytes (CRLF vs LF matter, byte-level); programmatic
  policies hash canonical JSON. Enforced byte-parity across Python
  and Node via cross-lang test.
- **Content-addressed policy snapshots** (WIRE §5.1) — `Gate` init
  writes `<ledger>/../policies/<hex>.<ext>` for every distinct policy
  loaded. `custos bundle` auto-discovers that directory and embeds
  every referenced version, not just the latest. `manifest.policies_hash`
  covers the whole content-addressed layout.
- **`custos verify --replay`** — walks the ledger, resolves each
  `policy.hash` in the snapshot dir, loads the policy, and asserts the
  recorded rule/default is consistent with the policy text. Missing
  snapshots and swapped-policy tamper are both flagged. Honest limit:
  argument-level replay is not attempted — records store `args_hash`,
  not `args`, to keep tool inputs out of the audit surface.

### Control liveness + honest enforcement labels

- **`enforcement.point` + `enforcement.effect`** (WIRE §2.2) — every
  record can carry `{point: sdk | proxy | attest-only, effect: blocked
  | advisory}` so a `deny` row is never mistaken for outcome. Advisory
  mode on the Gate SDK (`advisory=True`) logs the policy's decision
  but executes anyway; staged-rollout use case.
- **Attestation records** (WIRE §2.3) — new `type: "attestation"`
  entries interleave with decisions in the same signed hash chain.
  `Gate` init emits a `"startup"` attestation; operators SHOULD emit
  `"periodic"` on their own cadence and `"shutdown"` on clean exit.
  A gap in attestations is now cryptographically visible instead of
  ambiguous silence.
- **`custos verify --coverage`** — walks attestations, computes
  expected count over the observed window, and reports any gap
  exceeding `interval * tolerance`. Answers "was the control actually
  running the whole time, or did it just stop observing?"

### Per-call attestation tokens

- **Signed call tokens** (WIRE §9) — on every ALLOW decision, the SDK
  and proxy generate a compact `custos:v1:<payload>.<sig>` token
  binding `{trace_id, span_id, tool, args_hash, ts, kid}`. The proxy
  injects it into forwarded `_meta.custos_token`; the SDK returns it
  on `GateResult.token`.
- **`custos.token` module** (both languages) — `generate_token()` /
  `verify_token()`. Cooperating tool servers verify the token before
  executing and log verified / rejected / unattested. Cross-checking
  the tool-side log against the Custos ledger turns coverage from a
  best-effort claim into cryptographic evidence — but only with
  downstream cooperation, which the docs state plainly.

### Docs

- **New README section "What Custos proves"** — states plainly what
  Custos proves cryptographically, what it proves with downstream
  cooperation, and what it does NOT prove. Written in the language a
  GRC reviewer uses.

### Breaking / behavioral

- `Gate()` now emits a startup attestation record by default. Opt out
  with `attest=False`. Ledgers produced by Gate constructors now
  contain one extra record; adjust record-count expectations.

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
