# Security design — Custos WebMCP

## Trust boundaries

```
[ Web application UI ]   [ AI Agent ]
        │                     │
        └─────WebMCP──────────┘
              │
        [ WebMCP adapter ]  <— UNTRUSTED input from agent
              │
        [ Backend policy + Gate + Ledger ]  <— TRUST ANCHOR
              │
        [ Simulated domain ]
```

Everything crossing the WebMCP surface from the agent is treated as untrusted
input. Everything that the domain returns to the agent is treated as
potentially untrusted output (via `annotations.untrustedContentHint`).

## Threats and mitigations

| Threat | Mitigation |
|---|---|
| Agent calls an unknown tool | WebMCP registration is closed set; backend rejects unknown tool names |
| Agent passes malformed args | JSON Schema on each tool + backend re-validates + Custos policy evaluates enriched context |
| Agent triggers destructive prod action | Risk classifier tags `high`; backend returns `approval` without touching domain until human decides |
| Agent tries to delete production | Two-layer deny: classifier `prohibited` + explicit policy rule matching `tool=delete_environment, environment=production` |
| Agent replays a stale approval | Approvals are single-use; state machine transitions `pending → approved` once |
| Agent substitutes args after approval | Approval stores `argsHash`; approve endpoint accepts only `approvalId` + verdict, never args; backend re-computes hash before executing |
| Attacker calls approve endpoint directly with fake args | Endpoint has no args field; the approvalId lookup is authoritative |
| Approval left dangling | Expiry (default 5 min); expired approvals return `custos.approval.expired` |
| WebMCP call cancelled mid-approval | `AbortSignal` propagates; pending approvals become `cancelled`; further approve/deny no-ops |
| Application log contains prompt-injection | Response marked `untrustedContentHint: true`; UI escapes text; backend never interprets domain content as instructions |
| XSS via `<script>` in log | React default escaping + no `dangerouslySetInnerHTML` on domain data |
| Ledger tampering | Existing Custos hash chain + Ed25519 signature per record; `verifyLedger()` runs on `/api/health` |
| Approval events falsely presented as signed | Approval events written to a separate `approval-events.jsonl` journal; UI labels them "CONTROL EVENT" — only ledger records are labeled "SIGNED EXECUTION RECORD" |
| Two concurrent approve clicks | Approval store uses a single mutex per ID; second call is a no-op |
| Two independent approvals with different IDs | State keyed by approvalId; no cross-contamination (tested) |
| Real infrastructure modification | Domain layer is pure in-memory; no fs/network side effects outside of Custos ledger |

## Data minimisation

- No secrets are logged, stored, or returned to the agent.
- Env-var writes are simulated; the actual host env is never read or written.
- The Ed25519 private key lives in `examples/webmcp-control-room/.custos/`
  (git-ignored).

## Fail-closed defaults

- Custos policy default is `deny`.
- Backend defaults unknown tool → 404, no ledger entry.
- Approval verdict defaults to denied on expiry.
- Adapter surfaces backend errors as `isError: true` — never silent success.

## Not in scope

- Authentication of the operator UI (single-user local demo).
- Rate limiting.
- TLS termination (deployment target provides HTTPS).
