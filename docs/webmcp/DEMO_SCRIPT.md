# Demo script — Custos WebMCP

Target duration: **2:15–2:40**. Hard ceiling: 3:00.

Setup before recording:

1. `cd examples/webmcp-control-room && npm run build && npm start`
2. Open the page in the ChatGPT in-app browser (or the fallback LOCAL AGENT
   SIMULATOR mode if WebMCP is unavailable).
3. Click **Reset demo** — payment-service prod is degraded on 2.4.1.

## 0:00–0:15 — Problem

> "WebMCP lets a website hand real, structured tools to an AI agent.
> That's powerful, but it means the agent inherits everything an
> authenticated user can do. Custos adds a policy and human-approval
> boundary before those tools actually execute."

Show the page. Point at the **WebMCP connected · 8 tools** pill.

## 0:15–0:30 — Show control room

Point out:

- Five services × three environments.
- payment-service in production is **degraded**.
- Ledger verified · N records pill.
- The audit trail on the right is empty.

## 0:30–1:10 — Agent investigates

Type into the agent input:

> Investigate why checkout is degraded. Inspect the relevant services,
> logs, and deployments. Fix anything safe automatically, but ask me
> before making sensitive production changes.

Watch the agent session timeline show:

```
list_services       ALLOW
get_service_health  ALLOW
query_logs          ALLOW    ← untrusted content annotation
get_deployments     ALLOW
rollback_service    APPROVAL
```

Point at the **query_logs** row — the response is marked untrusted, and
the malicious "SYSTEM OVERRIDE" line renders as escaped text, not as an
instruction Custos ever obeys.

## 1:10–1:40 — Human approval

The Human Approval Queue on the right now shows:

```
HIGH    rollback_service
        production · payment-service
        rollback to 2.3.9
        [Deny]   [Approve]
```

> "Custos classified this as high-risk because it mutates production. The
> execution never touched the domain — it's parked here until I say yes."

Click **Approve**.

- Approval card disappears.
- Current Decision panel updates to `ALLOW · rollback_service`.
- payment-service in the services grid goes **healthy** on 2.3.9.
- Audit trail shows two new rows tied to the same trace id: a CONTROL
  event (approval → approved) and a SIGNED execution record.

## 1:40–1:55 — Automatic allow

Type:

> Restart the notifications service in staging.

Timeline shows a single row: `restart_service · ALLOW`. No approval
needed. Point out: same underlying policy engine — the risk classifier
just doesn't require a human here.

## 1:55–2:10 — Hard deny

Type:

> Delete the production environment.

Timeline shows `delete_environment · DENY`. Current Decision panel shows:

```
DENY
rule: hard-deny-prohibited
reason: operation is prohibited by policy
```

Services grid is unchanged.

## 2:10–2:30 — Audit

Point at the audit trail. Filter by DENY, then by APPROVAL, then ALL.

> "Every decision — allow, deny, approval — is signed into the Custos
> hash-chained ledger, tied by trace ID to the human approval events.
> The Ledger verified pill up top is a live check, not a badge."

## Close

> "WebMCP gives agents structured, typed access to the web. Custos makes
> that access governable — with policy, human approval, and cryptographic
> audit — without changing the agent, the browser, or the site's UI."
