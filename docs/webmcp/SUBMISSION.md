# Devpost submission — Custos WebMCP

## Project name
Custos WebMCP

## One-line pitch
The policy, human-approval, and cryptographic audit layer for the
agent-native web.

## Elevator pitch
WebMCP lets a website expose real, structured tools to an AI agent
running in the user's browser. That's powerful — the agent no longer
has to guess at UIs — and dangerous, because the agent inherits
everything a signed-in user can do. Custos WebMCP sits between the
agent and the application: policy classifies each call, high-risk
mutations pause for human approval, prohibited actions fail closed,
and every decision lands in an Ed25519-signed hash-chained ledger. The
demo is a simulated cloud operations console where the agent can
investigate a production incident, propose a rollback, and only
execute it once a human clicks Approve.

## Problem
WebMCP creates a new trust boundary:

```
User → AI Agent → WebMCP Tool → Authenticated Web Application → Real action
```

Without governance the agent can act with the user's full privilege,
follow prompt-injection embedded in application data, take irreversible
production actions, or perform sensitive changes the user meant to see
first. Custos WebMCP is the guardrail.

## Why WebMCP (and not DOM automation)
Traditional browser-driving agents click through the UI. That's brittle,
opaque, and impossible to policy-check — every action looks like a
mouse move. WebMCP exposes typed tools with JSON Schema input, safety
annotations (`readOnlyHint`, `untrustedContentHint`), and cancellation.
That structure is what makes Custos-style governance possible in the
browser.

## What humans and agents can now do together
- Agents investigate autonomously with read-only tools.
- Safe operations execute automatically.
- Risky operations pause for human judgment, argument-bound and
  single-use.
- Prohibited actions are blocked by policy, not by the UI.
- Every action — allowed, denied, or awaiting approval — is auditable
  under a single trace id.

## How WebMCP is implemented
- Browser-side: `document.modelContext.registerTool(...)` for each of 8
  Control Room tools, with `inputSchema`, `readOnlyHint`, and
  `untrustedContentHint` annotations set correctly. Registration is
  wrapped by the new **Custos WebMCP adapter** so every `execute` call
  runs through Custos before touching the application.
- Cancellation: WebMCP's `AbortSignal` propagates through the adapter
  into the backend; pending approvals become `cancelled`.
- Feature detection: `getModelContext()` gracefully falls back to a
  clearly-labelled LOCAL AGENT SIMULATOR when WebMCP is unavailable in
  the current browser (so judges without a WebMCP-enabled browser can
  still see the same behaviour).

## Architecture
```
Browser (WebMCP tool surface + UI)
   │
   │ HTTP
   ▼
Node backend
   ├── policy: risk classifier + Custos native policy
   ├── approvals: state machine, argsHash-bound, single-use, TTL
   ├── orchestrator: Custos Gate.call per tool
   ├── ledger: existing Custos Ed25519 + hash chain
   └── domain: deterministic simulated services
```

## Security highlights
- Approve endpoint takes only `approvalId` + verdict — never args.
- Args are hashed at approval creation; re-invocation with different
  args is rejected (`custos.approval.args_mismatch`).
- Production deletion is denied by both the risk classifier and an
  explicit policy rule.
- Application data (logs) is annotated untrusted; UI escapes it; policy
  never converts domain content into privilege.
- Approval events are recorded separately from the signed Custos ledger
  so cryptographic properties are never overclaimed.

## Built during the challenge
Full disclosure: `WEBMCP_CHALLENGE.md`. Pre-existing Custos (v0.2.0) is
unchanged. New for the challenge: the WebMCP adapter + 18 unit tests,
the full Control Room example (server + client + 37 tests including a
happy-path E2E), and the docs under `docs/webmcp/`.

## Technologies used
- Custos (Node runtime + Ed25519 ledger + native policy engine).
- WebMCP `document.modelContext`.
- TypeScript (strict), plain Node `http`, vanilla TS client, esbuild
  bundler.
- Vitest for automated tests.
- No LLM inference, no vector DB, no cloud infrastructure.

## Test summary
- `packages/custos-js` — 63 passing (45 pre-existing + 18 new).
- `examples/webmcp-control-room` — 37 passing, including a full E2E
  that drives the WebMCP adapter through the live backend.
- Regression: every one of the 45 pre-existing tests still green.

## Repository
Custos monorepo. Demo: `examples/webmcp-control-room`. Docs:
`docs/webmcp/`. Adapter: `packages/custos-js/src/adapters/webmcp.ts`.
