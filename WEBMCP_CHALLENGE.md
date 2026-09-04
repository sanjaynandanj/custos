# Custos × OpenAI WebMCP Challenge

This file discloses exactly what was pre-existing in the Custos repository
versus what was built during the WebMCP Challenge. Baseline snapshot:
commit `49c4301` on `main`, 45 tests passing.

## Pre-existing Custos work (not built for this challenge)

Full Custos v0.2.0, in `packages/custos-js` and `packages/custos-py`:

- Canonical JSON (byte-identical Node/Python).
- Ed25519 keypair + hash-chained append-only signed ledger.
- Native YAML policy engine + Gate SDK.
- Signed evidence bundles.
- Local dashboard, OpenTelemetry integration, telemetry receiver.
- Existing adapters: `langgraph`, `claude-agent`.
- MCP stdio proxy, CLI, cross-language wire spec (`spec/WIRE.md`).
- 45 pre-existing tests, all still green.

## Built specifically for the WebMCP Challenge

### New WebMCP adapter (in `packages/custos-js`)

- `src/adapters/webmcp.ts` — browser-safe adapter. Registers Custos-gated
  tools with `document.modelContext.registerTool`. Forwards name / title /
  description / inputSchema / annotations verbatim; normalises Custos
  outcomes into MCP-shaped results; supports allow, deny, human approval
  and `AbortSignal` cancellation. Ships with a `makeHttpDecider` helper
  and a `getModelContext` feature-detector.
- `test/webmcp.test.ts` — 18 Vitest cases using an injectable
  `FakeModelContext`. Includes registration, schema/annotation forwarding,
  allow/deny/error normalisation, approval wait, AbortSignal, unregister,
  batch registration, and the HTTP decider.
- Package exports and tsup build wired for `custos-mcp/adapters/webmcp`.

### New Control Room example (`examples/webmcp-control-room`)

Simulated SaaS operations console:

- 8 WebMCP tools: `list_services`, `get_service_health`,
  `get_deployments`, `query_logs`, `restart_service`, `rollback_service`,
  `set_environment_variable`, `delete_environment`.
- Deterministic domain: 5 services × 3 environments, seeded
  `payment-service` production incident on version 2.4.1 with a healthy
  2.3.9 rollback target.
- Risk classifier + Custos policy YAML:
  - read/low → auto-allow,
  - medium (non-prod) → auto-allow,
  - high (prod restart/rollback/set-env) → **human approval required**,
  - prohibited (prod delete) → **hard deny** (belt-and-braces: risk class +
    explicit policy rule).
- Approval store: state machine (pending → approved | denied | cancelled |
  expired), args-hash binding, single-use, expiry, cancellation. Approve
  endpoint accepts only `approvalId` + verdict — never args.
- Custos ledger integration: signed execution records via the existing
  Ed25519 key + hash chain. Separate correlated approval-events journal
  labelled "CONTROL EVENT" in the UI so lifecycle metadata is never
  falsely presented as cryptographically signed.
- HTTP surface: `/api/tools/:name`, `/api/approvals`,
  `/api/approvals/:id/{approve,deny,cancel}`, `/api/audit`, `/api/health`,
  `/api/reset`, `/api/state`, `/api/tools`.
- Client: vanilla TypeScript UI (dark ops console aesthetic), reactive
  render, WebMCP-connection indicator, agent-session timeline, decision
  card, approval queue with keyboard-accessible approve/deny, audit
  timeline with filters, reset. Untrusted log content is escaped and
  labelled.
- Local Agent Simulator: fallback path when WebMCP is unavailable in the
  current browser — labelled clearly, never confused with WebMCP.
- Tests: 37 Vitest cases — domain seed/rollback/reset determinism, risk
  classifier and policy, approval state machine, HTTP integration
  (schema validation, allow/deny/approval, replay, args-binding, reset
  behaviour, concurrent approvals, ledger integrity), and one full
  happy-path E2E that drives the adapter through the actual server to
  investigate, request approval, heal the incident, and hit the hard-deny.

### New documentation (in `docs/webmcp/`)

- `BASELINE.md` — pre-existing vs new work.
- `PRD.md` — product requirements.
- `TRD.md` — implementation reference.
- `SECURITY.md` — trust boundaries, threats, mitigations.
- `TEST_PLAN.md` — full test matrix.
- `PHASE_STATUS.md` — phase completion tracker.
- `DEMO_SCRIPT.md` — sub-3-minute recorded demo script.
- `DEMO_PROMPTS.md` — copy-paste prompts.
- `MANUAL_TEST_CHECKLIST.md` — real-browser validation checklist.
- `SUBMISSION.md` — Devpost submission copy.

### Root

- `WEBMCP_CHALLENGE.md` (this file).
- README addition: prominent "Custos × WebMCP" section.
- `.gitignore` update for `examples/webmcp-control-room/.custos/` and the
  built `public/main.js` bundle.

## What was *not* changed

- Custos wire spec (`spec/WIRE.md`).
- Cross-language byte-for-byte parity.
- `custos-py` (Python package).
- Existing adapters, dashboard, CLI, bundles.
- CI configuration.
- Any of the 45 pre-existing tests (all still green).

## Test summary

```
packages/custos-js         63 passed  (45 pre-existing + 18 new webmcp)
examples/webmcp-control-room  37 passed  (5 files, incl. E2E)
```

## Deployment

The Control Room is a single Node process. To deploy, run
`npm install && npm run build` then `PORT=$PORT node --import tsx server/index.ts`
on any Node ≥ 18 host with a public URL. See
`docs/webmcp/MANUAL_TEST_CHECKLIST.md` for the real-browser walkthrough.
