# Custos WebMCP — Baseline Disclosure

This file is written at the start of the WebMCP Challenge work. It records
what already existed in the Custos repository **before** any challenge-scoped
work began, so reviewers can easily distinguish pre-existing product from
work built specifically for the OpenAI WebMCP Challenge.

## Repository state at start

Branch: `main`
Head: `49c4301 docs: architecture, integrations, release notes, launch assets, roadmap`
Regression suite before challenge work: **45 tests passing** across 9 files
(`packages/custos-js`).

## Pre-existing Custos functionality (NOT built for this challenge)

### `packages/custos-js` (Node/TypeScript, v0.2.0)
- Canonical JSON serialization (`canonical.ts`) — byte-identical to Python.
- Ed25519 keypair generation / load / verify (`keys.ts`).
- Append-only signed hash-chained ledger (`ledger.ts`, `verify.ts`).
- Native YAML policy engine with rule DSL (`policy.ts`).
- `Gate` in-process SDK — evaluate policy, invoke tool, seal record
  (`sdk.ts`).
- Signed evidence bundles (`bundle.ts`).
- CLI (`cli.ts` / `init.ts` / `demo.ts`).
- Local dashboard (`dashboard.ts`, optional bearer-token auth).
- Optional OpenTelemetry integration (`otel.ts`).
- Optional telemetry receiver (`telemetry.ts`).
- Existing agent adapters:
  - `adapters/langgraph.ts` — gates any LangChain-shaped tool.
  - `adapters/claude-agent.ts` — gates any Claude Agent SDK tool.
- MCP stdio proxy (`proxy.ts`).

### `packages/custos-py` (Python, v0.2.0)
- Full parity implementation of the wire format.
- Same canonical JSON, ledger, policy, gate, bundle, dashboard.

### Wire spec
- `spec/WIRE.md` — cross-runtime record and policy schema.

### Existing examples
- `examples/basic-mcp-policy/`, `examples/coding-agent/`,
  `examples/enterprise-data-access/`, plus SDK examples.

### CI
- `.github/workflows/` — runs Node + Python tests, dependabot.

## What will be built for the WebMCP Challenge

Only these areas will be added or modified:

1. **`packages/custos-js/src/adapters/webmcp.ts`** — new adapter that
   registers Custos-gated tools with `document.modelContext.registerTool`
   (WebMCP). Isolated behind feature detection; no browser-only globals
   leak into Custos core. Includes a `ModelContext` interface + a
   test-injectable fake so unit tests run in Node/Vitest.
2. **`packages/custos-js/test/webmcp.test.ts`** — Vitest suite covering
   registration, schema forwarding, annotations, allow/deny/approval,
   AbortSignal, cleanup.
3. **`examples/webmcp-control-room/`** — the demo application:
   - Vite/React/TypeScript client that exposes 8 WebMCP tools.
   - Small Node (Fastify) backend that holds Custos policy, Gate, signed
     ledger, deterministic domain state, approval store.
   - Approval UI, decision cards, audit trail, reset.
4. **`docs/webmcp/`** — PRD, TRD, TEST_PLAN, SECURITY, PHASE_STATUS,
   MANUAL_TEST_CHECKLIST, DEMO_SCRIPT, DEMO_PROMPTS, SUBMISSION.
5. **`WEBMCP_CHALLENGE.md`** at repo root — public disclosure of what was
   built during the challenge vs pre-existing.
6. **README addition** — small "Custos × WebMCP" section, no destructive
   edits to existing docs.

## What will NOT be changed

- Core `Gate`, `Policy`, `Ledger`, `bundle`, canonical serialization.
- Wire spec (`spec/WIRE.md`) — Node/Python compatibility must remain
  byte-identical.
- Python package (unless a trivial bugfix is needed for parity).
- Existing adapters (`langgraph`, `claude-agent`).
- Existing CI, dashboards, or CLI behavior.

Rationale: the WebMCP Challenge is about proving Custos-style governance
extends naturally to the agent-native web. The existing Custos engine is
reused unchanged; only a browser-side registration adapter and a
demonstrative application are added.

## Architectural note — browser vs Node

The existing Custos `Gate` / `Ledger` / `Keys` modules depend on Node
built-ins (`node:crypto`, `node:fs`). They are intentionally **not**
bundled into the browser. The WebMCP Control Room therefore uses the
realistic split:

```
Browser (WebMCP tool surface + UI)  ──HTTP──►  Node backend (Custos Gate + Ledger)
```

This mirrors how a real SaaS with WebMCP-exposed capabilities would deploy
Custos, and keeps Custos core untouched.
