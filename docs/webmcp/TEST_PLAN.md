# Test plan — Custos WebMCP

Complete matrix. Each row maps to at least one automated test. `M` denotes a
manual-only test (see MANUAL_TEST_CHECKLIST.md).

## Suites

- **A. Adapter unit** — `packages/custos-js/test/webmcp.test.ts`
  (FakeModelContext, no backend, no browser).
- **B. Backend unit** — `examples/webmcp-control-room/server/*.test.ts`
  (domain, policy, approvals, ledger).
- **C. Backend integration** — end-to-end HTTP against a running Fastify
  instance via `supertest`.
- **D. Happy-path E2E** — script that simulates a full agent session
  through the adapter into the running backend.
- **E. Regression** — existing 45 tests in `packages/custos-js` must still
  pass.

## Matrix

| # | Case | Suite |
|---|---|---|
| A1 | registerTool forwards name/title/description/inputSchema | A |
| A2 | readOnlyHint annotation preserved | A |
| A3 | untrustedContentHint annotation preserved | A |
| A4 | allow → returns result unchanged | A |
| A5 | deny → returns `{isError:true}` MCP-shaped result | A |
| A6 | thrown error → normalised MCP error | A |
| A7 | AbortSignal propagates to decider | A |
| A8 | unregister() removes tool | A |
| A9 | registerCustosWebTools + unregisterAll | A |
| A10 | approval outcome waits then resolves with underlying result | A |
| A11 | getModelContext returns null when absent | A |
| B1 | domain seed is deterministic; reset restores | B |
| B2 | rollback in prod flips version and status | B |
| B3 | classifier tags prod delete as prohibited | B |
| B4 | approval store single-use | B |
| B5 | approval store binds argsHash | B |
| B6 | approval expires | B |
| B7 | approval cancel is idempotent | B |
| B8 | ledger append + verify | B |
| C1 | POST list_services returns 5 services | C |
| C2 | POST list_services with unknown env → 400 | C |
| C3 | POST query_logs marks malicious line untrusted | C |
| C4 | POST restart_service dev → executes, ledger has record | C |
| C5 | POST rollback_service prod → returns approval, no domain change | C |
| C6 | approve rollback → executes, ledger has record, state healthy | C |
| C7 | deny rollback → no execution, ledger has deny record | C |
| C8 | replay approval → 409 already-resolved | C |
| C9 | approve with wrong id → 404 | C |
| C10 | POST delete_environment prod → hard deny | C |
| C11 | GET audit merges ledger + approval events by traceId | C |
| C12 | GET health verifies ledger integrity | C |
| C13 | concurrent approvals do not resolve each other | C |
| C14 | reset while approval pending → approval becomes cancelled | C |
| D1 | E2E happy path per spec §19 | D |
| E1 | all pre-existing tests pass | E |
| M1 | real WebMCP: page detected in ChatGPT browser | M |
| M2 | real WebMCP: agent selects rollback tool from natural language | M |
| M3 | real WebMCP: approval genuinely pauses agent | M |
| M4 | real WebMCP: prod delete surfaces DENY to agent | M |
| M5 | XSS attempt in log renders as text (visual check) | M |

## Commands

```
# Regression
cd packages/custos-js && npm test

# WebMCP adapter unit tests
cd packages/custos-js && npm test -- webmcp

# Control room server + integration
cd examples/webmcp-control-room && npm test

# Full: from repo root
npm run -w packages/custos-js test && npm --prefix examples/webmcp-control-room test
```

## Definition of green

- All A/B/C/D tests pass.
- All E (pre-existing) tests pass, unchanged.
- `verifyLedger` reports `ok: true` after every test file that writes to the
  ledger.
