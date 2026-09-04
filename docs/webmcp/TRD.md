# TRD — Custos WebMCP

## 1. Scope

This document specifies the concrete implementation of Custos WebMCP as
shipped in this repository. It refers to code paths that actually exist
after Phases 2–6.

## 2. Component map

```
packages/custos-js/
  src/adapters/webmcp.ts         WebMCP registration adapter (browser-safe,
                                 imports no node built-ins)
  test/webmcp.test.ts            Vitest suite using FakeModelContext

examples/webmcp-control-room/
  server/                        Node (Fastify) backend
    domain.ts                    Deterministic services + logs + deployments
    policy.ts                    Custos policy YAML + risk classifier
    approvals.ts                 Approval store (state machine, arg-binding)
    ledger.ts                    Wraps Custos Ledger + trace correlation
    routes.ts                    /api/tools/:name, /api/approvals/*, /api/audit
    server.ts                    Fastify bootstrap
  client/                        Vite + React + TS
    src/webmcp/register.ts       Uses adapter to register all 8 tools
    src/webmcp/api.ts            Calls backend
    src/App.tsx                  Control Room layout
    src/components/*             Services / Approvals / Audit / Decision
    src/agent-sim.ts             LOCAL AGENT SIMULATOR (fallback only)
  package.json                   Workspaces: client + server
  README.md
```

## 3. WebMCP adapter (`custos-js/src/adapters/webmcp.ts`)

Isolated, browser-safe. Does not import `node:crypto` / `node:fs`. Provides:

```ts
export interface ModelContextTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    untrustedContentHint?: boolean;
  };
  execute: (
    input: unknown,
    ctx: { signal?: AbortSignal }
  ) => Promise<unknown>;
}

export interface ModelContext {
  registerTool(tool: ModelContextTool): { unregister(): void } | void;
}

export interface CustosDecider {
  (input: unknown, ctx: { signal?: AbortSignal }): Promise<CustosOutcome>;
}

export type CustosOutcome =
  | { decision: "allow";    result: unknown; traceId: string }
  | { decision: "deny";     rule: string; reason: string; traceId: string }
  | { decision: "approval"; approvalId: string; reason: string; traceId: string;
      wait: (signal?: AbortSignal) => Promise<CustosOutcome> };

export function getModelContext(doc?: Document): ModelContext | null;

export function registerCustosWebTool(
  mc: ModelContext,
  spec: ModelContextTool,
  decider: CustosDecider,
): { unregister(): void };

export function registerCustosWebTools(
  mc: ModelContext,
  entries: Array<{ spec: ModelContextTool; decider: CustosDecider }>,
): { unregisterAll(): void };
```

Responsibilities:

- Feature-detect `document.modelContext` when caller doesn't pass one.
- Forward name / title / description / inputSchema / annotations verbatim.
- Wrap `execute` so it invokes the decider and normalises the response shape
  the agent sees:
  - **allow** — returns the underlying result.
  - **deny** — returns `{ isError: true, content: [{ type: "text", text: "custos denied [rule]: reason (trace …)" }] }`.
  - **approval** — awaits `wait(signal)`, then applies the same mapping.
- Propagate `AbortSignal` cancellation.
- Provide `unregister()` per tool and `unregisterAll()` bulk cleanup.

**Non-goals for the adapter:** it does not know about services, policies,
approvals, or ledgers. Those live in the app.

## 4. Custos application layer (Control Room backend)

The backend is where the actual Custos `Gate` runs.

### 4.1 Domain (`server/domain.ts`)

Deterministic in-memory state seeded on boot and on `POST /api/reset`.

Types:

```
Environment = "development" | "staging" | "production"
Service     = { name; env; version; status; latencyMs; errorRate; }
Deployment  = { service; env; version; deployedAt; status; }
LogLine     = { ts; service; env; severity; message; untrusted?: boolean }
```

`payment-service` prod is seeded degraded on 2.4.1, previous deployment
2.3.9 healthy. A malicious log line is seeded in `payment-service` prod.

### 4.2 Risk classifier (`server/policy.ts`)

```ts
type Risk = "read" | "low" | "medium" | "high" | "prohibited";
function classify(tool: string, input: any): { risk: Risk; env?: Environment };
```

- read tools → `read`
- restart/rollback in dev/staging → `low`
- set_environment_variable in dev → `medium`
- delete_environment in dev/staging → `high`
- restart/rollback/set_env in production → `high`
- delete_environment in production → `prohibited`

### 4.3 Custos policy YAML

The backend loads a Custos native policy via `loadPolicy(...)`. The policy
matches on the enriched context:

```
{ tool, actor, server, args: { environment, service, risk, ... }, trace_id }
```

Rules:

1. `deny` when `args.risk = prohibited` → hard deny (production delete).
2. `deny` when `tool = delete_environment` and `args.environment = production`
   (defense in depth).
3. `allow` when `args.risk in [read, low]`.
4. `allow` when `args.risk = medium` and `args.environment != production`.
5. `allow` when `args.risk = high` **and** `args.approved = true`.
   (Approved calls re-enter the Gate with `approved = true` to receive a
   signed execution record.)
6. default `deny`.

### 4.4 Approvals (`server/approvals.ts`)

State machine per spec §10 (created → pending → approved | denied |
cancelled | expired; approved → executed | failed). Enforces:

- single-use approval IDs,
- args-hash binding (`hashOfValue(canonical(input))` from Custos),
- expiry (default 5 min),
- the approve endpoint never accepts new args — only an approval ID + verdict.

### 4.5 Ledger (`server/ledger.ts`)

Wraps the existing Custos `Ledger` writing to `./.custos/ledger.jsonl` in
the example folder (git-ignored). The signed record is written for actual
Gate decisions. A **separate correlated approval journal** (`approval-events.jsonl`,
not signed by the ledger key) records approval lifecycle events, tied to
the ledger via `trace_id` and `approvalId`. The UI clearly labels which is
which so we never overclaim cryptographic properties.

### 4.6 Routes (`server/routes.ts`)

```
GET  /api/state
POST /api/reset

POST /api/tools/:name           body: { input, traceId?, approvalId? }
                                → { decision, ... }

GET  /api/approvals
POST /api/approvals/:id/approve
POST /api/approvals/:id/deny

GET  /api/audit                 signed ledger records + approval events, merged
                                by traceId

GET  /api/health                { ledgerVerified: boolean, records: n }
```

Every `POST /api/tools/:name` runs through Custos `Gate.call(...)`. On risk =
`high` and `approved != true`, the route creates an approval and returns
`{ decision: "approval", approvalId, ... }` without touching the domain.

The client polls the approvals endpoint (or uses SSE if implemented) and,
when a decision arrives, the backend calls the Gate a second time with
`approved: true` to produce a signed execution record.

## 5. Browser flow

```
Agent invokes rollback_service ─► WebMCP execute()
   │
   ▼
adapter.decider(input) ─HTTP─► POST /api/tools/rollback_service
   │                                ← { decision: "approval", approvalId, wait: ... }
   ▼
adapter awaits wait(signal)
   │
UI shows Approval card
   │
Operator clicks Approve
   │
POST /api/approvals/:id/approve
   │
backend re-invokes Gate with approved=true → signed ledger record
   │
adapter resolves → agent gets tool result
```

## 6. Security boundaries

- WebMCP output is treated as untrusted by both the UI (escaped) and by any
  downstream consumer that reads `annotations.untrustedContentHint`.
- Approve endpoint accepts only `approvalId` + verdict — never args.
- Approvals are single-use and args-bound.
- Production delete is denied both by the risk classifier AND by an explicit
  rule in the Custos policy — belt-and-braces.
- The Custos ledger uses the existing Ed25519 keypair and hash chain from
  the Custos core. Approval events are stored in a separate journal to
  avoid falsely claiming signature on lifecycle metadata.
- `AbortSignal` cancellation propagates from WebMCP → adapter → backend;
  in-flight approvals become `cancelled`.

## 7. Error propagation

- Deny → structured tool error (`isError: true`) with rule + reason + trace.
- Backend error → same shape with `rule: "custos.error"`.
- Approval expiry → same shape with `rule: "custos.approval.expired"`.

## 8. Cancellation

Adapter listens for `signal.aborted`. On abort:

- if the underlying call is still in-flight, `fetch` is aborted;
- if an approval is pending, `POST /api/approvals/:id/cancel` is called;
- the returned result is `{ isError: true, rule: "custos.cancelled" }`.

## 9. Testability

The adapter accepts a `ModelContext` argument so unit tests inject a
`FakeModelContext`. The backend runs headless in Vitest — every test is
deterministic (fake time for expiry, seeded state, single Ledger instance).
