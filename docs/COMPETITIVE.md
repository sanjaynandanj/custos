# Custos competitive landscape

**Research snapshot:** 2026-09-26
**Decision:** Custos competes as the **cross-language, WebMCP-capable, compliance-mapped evidence plane for governed agent actions** — not another MCP gateway, not another AI observability tool, not a Python-only reference implementation.

## Method and claim discipline

This comparison uses current official repositories, documentation, and source files. "Not documented in reviewed sources" means exactly that — it is not proof that a vendor has no private or newly released capability. GitHub activity and feature sets are time-sensitive; re-verify before citing externally.

The decisive questions were:

1. Is the product in the MCP runtime path **before** a tool executes?
2. What policy engines can it enforce, and are decisions reproducible?
3. Does it correlate calls across servers, agents, and workflows?
4. Does it bind each decision to the **exact policy version/hash** that produced it?
5. Is the record **cryptographically tamper-evident** and **offline-verifiable** by a third party?
6. Does it cover the **browser-side** action surface (WebMCP, browser agents) in addition to server-side MCP?
7. Does it ship in more than one host language, with a **wire-compatible** ledger?

Questions 6 and 7 are where Custos is materially ahead of the closest competitors as of this snapshot.

## Direct architectural competitors

| Product | What official sources show | Policy / runtime control | Audit and correlation | Cryptographic, portable evidence | Custos delta |
|---|---|---|---|---|---|
| **Obsigno** ([github.com/amudhan22/obsigno](https://github.com/amudhan22/obsigno)) | Apache-2.0 stdio MCP proxy with FastAPI dashboard, Ed25519 hash-chained ledger, offline evidence bundle export/verify. Python-only, single-author, 1 star, ~7 weeks old at snapshot, last push 2026-09-03 | Pre-invocation gate on `tools/call`; native JSON, OPA Data API, Cedar via `cedarpy` | Cross-server correlation via signed `_meta` trace ID and stable `server_id`; FastAPI + dashboard | Ed25519-signed hash-chained ledger, policy-hash binding, portable trace bundle with derived manifest and optional policy snapshots, offline verifier with public-key fingerprint check | **Nearest positional overlap.** Same wedge, same crypto design. Obsigno is stdio-only by their own admission, Python-only, has no browser/WebMCP path, no compliance evidence mappings, no cross-language wire tests, no npm package |
| **IBM ContextForge** ([github.com/IBM/mcp-context-forge](https://github.com/IBM/mcp-context-forge)) | Apache-2.0 MCP gateway/registry with unified policy decision point, plugins, federation, OTel | Pre-invocation `tool_pre_invoke` enforcement; native OPA and Cedar plugins | W3C/OTel tracing with MCP client and server spans | Published security-features roadmap still lists immutable audit trails as under evaluation; no per-decision policy-digest binding or runtime chain verifier documented in reviewed sources | Broader gateway; not a cryptographic evidence product. Custos should not claim OPA+Cedar+MCP is unique |
| **ToolHive / Stacklok** ([github.com/stacklok/toolhive](https://github.com/stacklok/toolhive)) | Apache-2.0 MCP platform: container isolation, identity, authorization, audit logging, OTel, Kubernetes, virtual MCP | Runtime authorization; native Cedar authorizer | Structured audit events, audit IDs, delegation chains, file/stdout audit output, OTel traces | Reviewed [`pkg/audit/event.go`](https://github.com/stacklok/toolhive/blob/main/pkg/audit/event.go) and [`pkg/audit/config.go`](https://github.com/stacklok/toolhive/blob/main/pkg/audit/config.go) document append-file/stdout logging; no per-event signatures, no hash chain, no offline runtime-evidence verifier. Offline signature verification applies to skill artifacts, not runtime audit | Do not compete on Cedar or K8s integration; compete on signed evidence and cross-language deployment |
| **agentgateway** ([github.com/agentgateway/agentgateway](https://github.com/agentgateway/agentgateway)) | Apache-2.0 Rust proxy for MCP, A2A, and AI traffic; tool federation, multi-transport, OAuth/auth, RBAC, rate limits | MCP-aware pre-request guardrails; native CEL plus generic external authz callouts; no verified native OPA/Rego or Cedar adapter in reviewed source | OpenTelemetry logs, metrics, traces, request stores | Reviewed source does not document signed hash-chained events, per-decision policy digest, or portable offline verification | Do not compete on gateway breadth, throughput, or K8s posture |
| **Docker MCP Gateway** ([github.com/docker/mcp-gateway](https://github.com/docker/mcp-gateway)) | MIT MCP CLI/gateway integrated with Docker MCP catalog and isolated containers | Current source includes policy evaluation and policy audit paths | Audit records include `policy_id`, `policy_version`, `policy_source`, and `trace_id` per [`pkg/policy/audit.go`](https://github.com/docker/mcp-gateway/blob/main/pkg/policy/audit.go) | Reviewed audit structure does not document event signatures, hash-chain linkage, public-key verification, or portable trace bundles | Policy-version logging alone is no longer a differentiator; the wedge is cryptographic binding + offline verify |
| **Kong Gateway** ([github.com/Kong/kong](https://github.com/Kong/kong)) | Apache-2.0 generic API/AI gateway with mature routing, auth, plugins, OTel | Generic plugins can reject HTTP traffic; a current open-source MCP-aware JSON-RPC `tools/call` policy enforcement point was not verified in reviewed sources | Mature generic W3C/OTel propagation; cross-MCP-server lineage not established in reviewed OSS | Generic logging is not evidence of cryptographically chained MCP decisions | Adjacent enterprise gateway; treat as complementary, not feature-equivalent |
| **Portkey Gateway** ([github.com/Portkey-AI/gateway](https://github.com/Portkey-AI/gateway)) | MIT AI gateway data plane plus an MCP product/control plane whose complete OSS scope was not established | Workspace/server claim checks live; official docs mark tool-level authorization, authorization webhooks, and MCP guardrails as future/coming soon | Centralized observability and identity context; one propagated trace across multiple upstream MCP servers not established in reviewed materials | Reviewed MCP materials do not document a signed hash-chained ledger or offline evidence verifier | Do not credit unreleased tool-level controls as shipped |

## Adjacent / scanning / observability

| Product | Verified overlap | Boundary versus Custos |
|---|---|---|
| **Snyk Agent Scan** ([github.com/snyk/agent-scan](https://github.com/snyk/agent-scan)) | Apache-2.0 scanner for agents, MCP servers, and skills; prompt injection, tool poisoning, shadowing, toxic flows | Discovery and scanning, not transparent per-call runtime enforcement. Signed release checksums protect the scanner artifact, not runtime MCP audit events. Complementary: scan components before deployment; Custos governs routed calls at runtime |
| **Langfuse** ([github.com/langfuse/langfuse](https://github.com/langfuse/langfuse)) | Open-source LLM observability, tracing, evaluations, prompt management | Post-hoc observability, not a pre-execution gate. No Ed25519 signatures, no ledger hash chain. Export to Langfuse downstream — don't describe Custos as observability |
| **Arize Phoenix** ([github.com/Arize-ai/phoenix](https://github.com/Arize-ai/phoenix)) | Open-source AI observability with MCP-related tracing/integration | Same: observability layer, not runtime evidence authority |
| **OpenLLMetry** ([github.com/traceloop/openllmetry](https://github.com/traceloop/openllmetry)) | Open-source OTel instrumentation for LLMs; MCP support | OTel instrumentation, not a policy gate or signed ledger |

## Commercial / identity-adjacent

| Product | Verified overlap | Boundary versus Custos |
|---|---|---|
| **Zenity MCP Security** | Real-time MCP gateway can observe and allow, modify, or block tool calls; user/agent-linked step records | No public OSS/self-hosted runtime or documented signed audit chain / offline verifier found |
| **Noma Runtime Protection** | Examines commands, parameters, and context before execution; detect, mask, block, or require approval | Public materials document searchable logs, not cryptographically verifiable evidence |
| **Lasso MCP Gateway** ([github.com/lasso-security/mcp-gateway](https://github.com/lasso-security/mcp-gateway)) | MIT local/Docker gateway plus commercial threat controls | Advanced controls require hosted API key; Xetrack/SQLite/DuckDB logs are not documented as signed runtime evidence |
| **SGNL MCP Gateway** | Context-aware default-deny decisions between MCP clients and servers | No public OSS gateway or cryptographic runtime-evidence format found |
| **Astrix Agent Control Plane** | Strong agent/NHI identity, JIT credentials, signed access tokens | Signed tokens authenticate requests; not signatures over runtime audit history |
| **Oasis Agentic Access Management** | Ephemeral agent/session identities, pre-action policy, approval, semantic "chain of custody" | "Chain of custody" is not documented as a cryptographic hash chain or offline-verifiable bundle |
| **Descope Agentic Identity Hub** | OAuth, consent, scoped credentials, contextual policy, exportable agent audit trails | Identity control plane rather than an OSS transparent MCP evidence proxy; no signed runtime ledger documented |
| **Palo Alto Prisma AIRS MCP Server** | Security-profile allow/block verdicts and detailed threat logs | Documented workflow asks the agent to invoke a scanning tool; universal transparent MCP interception and offline evidence not established |

## What is already occupied

The following messages are **not** defensible wedges for Custos:

- "Open-source MCP gateway" — ContextForge, ToolHive, agentgateway, Docker, Obsigno already occupy it.
- "OPA and Cedar enforcement for MCP" — ContextForge ships both at a pre-invocation point; ToolHive has native Cedar; Obsigno ships both.
- "Ed25519 hash-chained MCP ledger" — Obsigno also ships this exact design. Custos was not first to publish it, so this is parity, not lead.
- "Policy version in MCP audit logs" — Docker's audit structure already includes policy ID/version/source and trace ID.
- "Cross-server MCP traces" — gateway and OTel products already provide federation and/or tracing; Obsigno correlates via signed `_meta`.
- "MCP security scanner" — Snyk Agent Scan is established in that category.
- "AI observability" — Langfuse, Phoenix, OpenLLMetry, and commercial platforms are broader and more mature.

## Custos wedges as of 2026-09-26

Where Custos leads the field per verified sources on this snapshot date:

### 1. Cross-language, wire-compatible ledger

- Custos ships as `pip install custos-mcp` **and** `npm install custos-mcp`, with a cross-language wire-compatibility test suite ([`tests/cross-lang/`](../tests/cross-lang/)) that proves a ledger written by one runtime verifies identically under the other.
- Every direct architectural competitor above is single-language (Python for Obsigno; Go for ContextForge/ToolHive/Docker; Rust for agentgateway).
- WIRE §7 error-handling spec ([`spec/WIRE.md`](../spec/WIRE.md)) is the normative reference that makes cross-language parity testable and auditable.

### 2. WebMCP / browser-side agent action gate

- [`packages/custos-js/src/adapters/webmcp.ts`](../packages/custos-js/src/adapters/webmcp.ts) — browser-safe adapter that gates `document.modelContext.registerTool(...)` calls with the same policy engine and signed-ledger design used server-side.
- [`examples/webmcp-control-room/`](../examples/webmcp-control-room/) — OpenAI WebMCP Challenge submission demonstrating hard-deny / human-approval / allow tiers over 8 simulated cloud-ops tools, all landing in the same Ed25519 ledger.
- No direct competitor above ships a browser-side / WebMCP path in reviewed sources.

### 3. Compliance evidence mapping (shipped, not roadmap)

- [`docs/compliance/SOC2-mapping.md`](compliance/SOC2-mapping.md) — Trust Services Criteria control mapping to specific Custos evidence.
- [`docs/compliance/HIPAA-mapping.md`](compliance/HIPAA-mapping.md) — Security Rule technical safeguards mapping.
- Obsigno's compliance positioning is a single paragraph disclaimer; ContextForge lists immutable audit as roadmap; ToolHive/Docker/agentgateway do not publish comparable control maps.

### 4. Human-approval as a core wire-format outcome

- **`approval`** is a first-class decision in [`spec/WIRE.md`](../spec/WIRE.md) §2.4 alongside `allow`, `deny`, and `error`. The gate records a pending decision (execution blocked); a follow-up record carrying `decides_ref = <approval record hash>` and matching `tool` / `args_hash` / `trace_id` is the human's resolution. The pair is the audit trail.
- Applies uniformly across every Custos surface — in-process SDK (`Gate.call` returns the approval outcome; `Gate.resolve_approval` writes the follow-up), stdio proxy (JSON-RPC `-32002` with `approval_ref` in `error.data`, distinct from the `-32001` deny code), and the WebMCP adapter.
- Cross-language wire parity enforced by `tests/cross-lang/run.sh` — both Python and JS writers produce well-formed approval + resolution pairs; the counterpart verifies them.
- Obsigno's ledger records `allow` and `deny` only. Approval-in-the-loop as a first-class ledger outcome with a signed pending record and cryptographically-bound resolution is not documented in reviewed sources for any direct architectural competitor.

## Honest limitations and next moat

Custos ships policy-attested cryptographic evidence, but the same key-provenance caveat applies to us as to any signed ledger: an attacker who replaces both the ledger and an unpinned public key can construct a different valid history. The verifier exposes SHA-256 public-key fingerprints; pin them out-of-band.

Highest-value next moves, in rough priority order:

1. **Signed checkpoints or Merkle inclusion proofs** — avoid disclosing a full linear-chain prefix in each exported trace and make externally witnessed truncation easier to detect. (Obsigno flags the same gap.)
2. **KMS/HSM signing and key-rotation records** — bind evidence to managed organizational keys instead of on-disk private key files.
3. **OPA bundle attestation** — automatically record a trusted bundle revision/digest rather than relying on operator-supplied `policy_ref`.
4. **Authenticated dashboard/API** — required before the dashboard is exposed outside a trusted local network.
5. **Remote MCP transports** — Streamable HTTP / SSE parity across both language implementations.
6. **A2A protocol support** — extend the gate to agent-to-agent traffic patterns as A2A stabilizes.

## Repository activity snapshot (directional only)

GitHub API values observed 2026-09-26. Stars are not adoption, revenue, or PMF — this is a distribution signal only.

| Repository | Stars at snapshot |
|---|---:|
| `Kong/kong` | 44,199 |
| `langfuse/langfuse` | 35,075 |
| `Portkey-AI/gateway` | 13,086 |
| `Arize-ai/phoenix` | 11,628 |
| `traceloop/openllmetry` | 7,452 |
| `agentgateway/agentgateway` | 5,051 |
| `IBM/mcp-context-forge` | 4,533 |
| `snyk/agent-scan` | 3,091 |
| `stacklok/toolhive` | 2,209 |
| `docker/mcp-gateway` | 1,587 |
| `lasso-security/mcp-gateway` | 390 |
| `amudhan22/obsigno` | 1 |

Refresh the star counts by running `gh api repos/<owner>/<repo> --jq .stargazers_count` before external citation.

## Attribution

The evidence-cited format of this document (six decisive questions, three-column competitor tables, "what is already occupied" section, honest-limitations coda, dated snapshot discipline) is adapted from Obsigno's [`COMPETITIVE.md`](https://github.com/amudhan22/obsigno/blob/main/COMPETITIVE.md) (Apache-2.0). The prose, competitor selection, capability judgements, and Custos-specific wedge analysis are original. The overlap in source URLs and evaluation questions is because the underlying market is the same one; two independent competitive analyses of the same category converged on similar tables.

## Sources

### MCP gateways and runtime policy

- Obsigno: https://github.com/amudhan22/obsigno
- IBM ContextForge: https://github.com/IBM/mcp-context-forge
- ContextForge unified PDP: https://github.com/IBM/mcp-context-forge/tree/main/plugins/unified_pdp
- ContextForge security roadmap: https://github.com/IBM/mcp-context-forge/blob/main/docs/docs/architecture/security-features.md
- ToolHive: https://github.com/stacklok/toolhive
- ToolHive audit event structure: https://github.com/stacklok/toolhive/blob/main/pkg/audit/event.go
- ToolHive audit output configuration: https://github.com/stacklok/toolhive/blob/main/pkg/audit/config.go
- ToolHive Cedar authorizer: https://github.com/stacklok/toolhive/blob/main/pkg/authz/authorizers/cedar/core.go
- agentgateway: https://github.com/agentgateway/agentgateway
- agentgateway CEL architecture: https://github.com/agentgateway/agentgateway/blob/main/architecture/cel.md
- Docker MCP Gateway: https://github.com/docker/mcp-gateway
- Docker policy audit event structure: https://github.com/docker/mcp-gateway/blob/main/pkg/policy/audit.go
- Kong Gateway: https://github.com/Kong/kong
- Portkey Gateway: https://github.com/Portkey-AI/gateway
- Portkey MCP Gateway docs: https://portkey.ai/docs/product/mcp-gateway

### Commercial runtime and identity

- Zenity MCP Security: https://zenity.io/platform/mcp-security
- Noma Runtime Protection: https://noma.security/platform/runtime-protection/
- Lasso MCP Gateway: https://github.com/lasso-security/mcp-gateway
- SGNL MCP Gateway: https://sgnl.ai/2025/06/press-release-sgnl-launches-mcp-gateway-to-enable-secure-ai-adoption-for-enterprise-workforces/
- Astrix Agent Control Plane: https://astrix.security/learn/blog/astrixs-agent-control-plane-acp-secure-ai-agents-from-day-one/
- Oasis Agentic Access Management: https://www.oasis.security/agentic-access-management
- Descope agent auditing: https://www.descope.com/blog/post/auditing-ai-agents
- Palo Alto Prisma AIRS MCP Server: https://docs.paloaltonetworks.com/ai-runtime-security/activation-and-onboarding/prisma-airs-mcp-server-for-centralized-ai-agent-security/understanding-the-prisma-airs-mcp-server

### Scanning and observability

- Snyk Agent Scan: https://github.com/snyk/agent-scan
- Langfuse: https://github.com/langfuse/langfuse
- Arize Phoenix: https://github.com/Arize-ai/phoenix
- OpenLLMetry: https://github.com/traceloop/openllmetry
- OpenTelemetry MCP semantic conventions: https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/mcp.md
- Pydantic Logfire MCP tracing: https://logfire.pydantic.dev/docs/integrations/llms/mcp/
- Langfuse MCP tracing: https://langfuse.com/docs/observability/features/mcp-tracing

### WebMCP

- WebMCP draft: https://webmachinelearning.github.io/webmcp/
- Custos WebMCP adapter: [`packages/custos-js/src/adapters/webmcp.ts`](../packages/custos-js/src/adapters/webmcp.ts)
- Custos WebMCP Control Room demo: [`examples/webmcp-control-room/`](../examples/webmcp-control-room/)
