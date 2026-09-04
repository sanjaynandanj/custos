# Custos WebMCP Control Room

A simulated agent operations console built for the **OpenAI WebMCP
Challenge**. It exposes 8 real WebMCP tools via
`document.modelContext.registerTool(...)` and routes every call through
Custos: policy → human approval → Ed25519-signed audit ledger.

> **All infrastructure is simulated.** No real cloud API is ever called.

## Run

```sh
npm install
npm run build     # bundles the client into public/
npm start         # serves at http://localhost:4173
```

Open http://localhost:4173. If your browser supports WebMCP (ChatGPT
in-app browser, or Chrome with WebMCP enabled), the page will register
its 8 tools with the agent. Otherwise a **LOCAL AGENT SIMULATOR** is
available in the same UI so you can drive the demo end to end.

## Demo prompts

Best judge-facing script:

1. **Investigate why checkout is degraded.** Inspect the relevant
   services, logs, and deployments. Fix anything safe automatically, but
   ask for my approval before making sensitive production changes.
2. **Approve** the production rollback when Custos surfaces the approval
   card. Watch the incident heal.
3. **Restart the notifications service in staging.** Auto-allowed.
4. **Delete the production environment.** Hard-denied by Custos policy.

## Architecture

```
Browser (WebMCP tool surface + UI)
        │
        │ HTTP
        ▼
Node backend (this repo)
   ├── policy.ts        risk classifier + Custos policy YAML
   ├── approvals.ts     approval state machine (args-bound, single-use)
   ├── orchestrator.ts  Custos Gate.call per tool
   ├── ledger.ts        wraps Custos Ledger (signed, hash-chained)
   └── domain.ts        deterministic simulated services
```

## Tests

```sh
npm test    # 37 tests: domain, policy, approvals, HTTP integration, full E2E
```

## What Custos actually protects

| Tool | Non-prod | Production |
|---|---|---|
| `list_services`, `get_service_health`, `get_deployments`, `query_logs` | allow | allow |
| `restart_service`, `rollback_service` | allow | **human approval** |
| `set_environment_variable` | allow (medium) | **human approval** |
| `delete_environment` | human approval | **hard deny** |
