# Custos — OSS vs Cloud roadmap

Strategic evaluation. **Not to be built automatically.** This is a decision doc for what should stay in the OSS package, what could ship as Custos Cloud / Enterprise, and what does not fit yet.

## Guiding principle

OSS Custos must remain useful standalone — never crippleware. A single dev must be able to `pip install custos-mcp`, wrap their MCP server, and get a real audit trail with zero commercial dependency. Cloud earns money by adding SaaS convenience and a hosted control plane, not by locking essential features.

If a capability is essential for basic auth + audit, it belongs in OSS. If it is essential for **operating a fleet** of gates at scale, that is where Cloud earns its keep.

---

## Current OSS scope (v0.3.x)

Shipping today:

- Native YAML policy DSL — `prefix`, `suffix`, `contains`, `regex`, `in`, `not_in`, `eq`, `ne`, `gt`, `lt`, `gte`, `lte`, `exists`
- Ed25519-signed, SHA-256 hash-chained JSONL ledger
- In-process Gate SDK (Python + Node)
- stdio MCP proxy (Python + Node)
- LangGraph adapter (both langs)
- Claude Agent SDK adapter (both langs)
- Cedar and OPA adapters (Python, experimental)
- OpenTelemetry span emission (both langs)
- Live dashboard on :8787 with bearer-token auth
- Portable evidence bundles with `policies_hash`
- CLI: `init`, `demo`, `keygen`, `verify`, `proxy`, `bundle`, `verify-bundle`, `serve`, `show-policy`

---

## Adjacent OSS capabilities (likely v0.4 – v0.6)

Belong in OSS because they are essential to the basic value prop.

| Capability | Difficulty | Fit | Earliest ship |
|---|---|---|---|
| Ledger rotation + segment index | M | Direct extension of ledger.py — long-running gates need it | v0.4 |
| HTTP / SSE MCP transport | M | Called out as a gap in the audit — every serious MCP deployment needs it | v0.4 |
| Streaming verifier (`verify --tail`) | S | Small addition to verify.py | v0.4 |
| Deny-log-only mode | S | One flag on the gate — critical for staged rollouts | v0.4 |
| Wire v2 with `policy.hash` per record | M | Ties each decision to the exact policy blob that decided it. Backwards-compat via `v: 2`. | v0.5 |

---

## Potential Custos Cloud / Enterprise

Each entry evaluated on: (1) does it fit the current architecture, (2) rough difficulty (S / M / L), (3) earliest sensible ship, (4) OSS or Cloud.

### 1. Central policy control plane

Push signed, versioned policy bundles to gates in the field; gates pull on interval and hot-swap.

- **Fit:** Very good — policies are already portable YAML with a hash. Bundle signing is already implemented.
- **Difficulty:** L (control-plane API + agent-side pull loop + rollback semantics).
- **Ship:** Cloud v0. This is the single most valuable Cloud capability.
- **Home:** Cloud. OSS can keep supporting local `policy.yaml` forever.

### 2. Identity integration (SSO / SAML / OIDC actor identity)

Populate the `actor` field on every decision from real identity, not string IDs.

- **Fit:** Good — the record schema already has an `Actor` object with `id`, `kind`, `meta`.
- **Difficulty:** M for OIDC token verification in the gate; L for full SAML.
- **Ship:** OIDC in OSS (v0.6), SAML + directory-sync as Cloud.
- **Home:** Split. OSS gets the interface; Cloud gets the enterprise directory integrations.

### 3. Human approval workflow

Some decisions should not be pure allow / deny — they should be **pending**, queued to a human, approved via UI / Slack / webhook, then executed.

- **Fit:** Requires a new decision state (`PENDING`) and a persistent queue. Ledger schema needs a follow-up record referencing the approval.
- **Difficulty:** L (new state machine, out-of-band delivery, correlation).
- **Ship:** Cloud v0 (queue + UI + Slack). OSS could get a `webhook` mode for a self-hosted approvals endpoint.
- **Home:** Split. OSS gets the primitive (`PENDING` decision + webhook). Cloud provides the UI, notifications, and RBAC on approvers.

### 4. Fleet management

Single pane of glass across every deployed gate: which policy is running where, which is stale, live audit stream.

- **Fit:** Only makes sense once the control plane exists (#1). Reuses the same connection.
- **Difficulty:** M once #1 is done.
- **Ship:** Cloud v1.
- **Home:** Cloud only.

### 5. Distributed audit storage (S3 / Postgres / BigQuery / Splunk / Datadog sinks)

Ledger sinks beyond local JSONL. Local JSONL stays default; sinks are additive.

- **Fit:** Good — needs a sink interface in the ledger. Wire format is unchanged; sinks stream records after signing.
- **Difficulty:** M per sink.
- **Ship:** OSS S3 + Postgres sinks in v0.6. Splunk / Datadog / BigQuery as Cloud (or supported OSS adapters, TBD).
- **Home:** Split. Cloud can offer a hosted collector that fans out to any sink.

### 6. Policy analytics

Coverage reports ("which rules never matched last 30 days"), deny spike detection, unused rule cleanup, per-actor deny rates.

- **Fit:** Trivially built from the ledger.
- **Difficulty:** S–M depending on depth. Requires warm ledger index.
- **Ship:** Cloud v1. A CLI `custos analyze` could live in OSS for local reports.
- **Home:** Split. Basic reports in OSS; live analytics + alerts in Cloud.

### 7. Compliance reports (SOC 2 / HIPAA / ISO 27001 evidence bundles)

Pre-formatted evidence packs tailored to specific control frameworks.

- **Fit:** Extension of `custos bundle`.
- **Difficulty:** L — mostly domain work (which controls, which evidence, what format each auditor wants).
- **Ship:** Cloud v1+. Not soon.
- **Home:** Cloud. OSS bundle stays generic.

### 8. Enterprise SLA + support

Named support contact, response SLA, private security disclosure channel.

- **Fit:** Not a technical capability — a contract.
- **Ship:** As soon as there is one paying customer that wants it.
- **Home:** Cloud only.

### 9. Multi-tenant policy management

Multiple tenants sharing a control plane, each with their own policies, keys, and ledgers.

- **Fit:** Depends on #1 (control plane) shipping first.
- **Difficulty:** L (tenant isolation + key handling + billing).
- **Ship:** Cloud v2.
- **Home:** Cloud only.

### 10. RBAC / ABAC identity-aware policies

Policy DSL extensions like `actor.groups: {contains: "sre"}` or `actor.claim.department: "finance"`.

- **Fit:** DSL is already object-path based (`actor.id`, `actor.meta.*`); extending to structured claims is straightforward once identity (#2) is in.
- **Difficulty:** S once #2 exists.
- **Ship:** OSS v0.7.
- **Home:** OSS. The DSL should stay in OSS forever.

---

## What does not fit yet

- **Runtime sandboxing** (containment of tool execution). Custos is authorization + audit, not a sandbox. Users who need containment should pair Custos with gVisor / Firecracker / OS-level sandboxes.
- **Model-side guardrails** (prompt-injection detection, output filtering). Different problem, different systems. Custos protects the *tool* interface, not the *model* interface.
- **General SIEM.** Custos emits into an OpenTelemetry collector and can sink to Splunk / Datadog; it is not itself a SIEM.

---

## Summary decision framework

- **Ships in OSS if:** it is essential for a single dev to get real value from Custos, or it is a primitive that Cloud builds on top of.
- **Ships in Cloud if:** it is essential only when operating many gates, requires hosted infrastructure to be useful, or is a domain-heavy convenience layer.
- **Never OSS-crippled:** no feature that works in OSS gets moved to Cloud-only.
- **Never Cloud-mandatory:** every Cloud feature must have an OSS-compatible primitive that self-hosters can wire themselves.
