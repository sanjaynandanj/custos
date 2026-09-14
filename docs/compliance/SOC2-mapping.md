# Custos — SOC 2 evidence mapping

**Scope.** Custos produces cryptographic evidence of AI agent tool-call
governance. This document maps that evidence to the SOC 2 Trust Services
Criteria (2017, revised 2022). It is a **crib sheet for your auditor**, not
a certification. Custos is one control among many; a full SOC 2 report also
depends on your identity system, change-management process, incident
response, physical security, and vendor management, none of which Custos
provides.

**What "aligned to" means here.** Every row below names (a) the criterion,
(b) the exact Custos artifact that carries the evidence, (c) how a
preparer or auditor extracts it. If a criterion is out of scope for Custos,
the row says so plainly — we would rather you know the gap than discover
it three weeks into fieldwork.

**Which categories.** Custos evidence is most directly relevant to
**Security** (Common Criteria). It contributes partial evidence to
**Availability** (via attestation heartbeats) and **Processing Integrity**
(via replay verification). It is largely out of scope for **Confidentiality**
and **Privacy**, which govern data handling, not tool-call authorisation.

---

## Common Criteria — Security

### CC5 — Control activities

| Criterion | Custos evidence | How to extract |
|---|---|---|
| **CC5.1** Selects and develops control activities to mitigate risks to acceptable levels | Policy DSL (`spec/POLICY.md`, `spec/WIRE.md §6`) — deny-by-default, actor-scoped rules, tool allowlists. The policy YAML/JSON *is* the control activity, versioned in source control. | `git log spec/POLICY.md`, `git log <your-policies>/`. Show the auditor the current policy and its version history. |
| **CC5.2** Selects and develops general control activities over technology | Evidence bundle (`custos bundle`) is a portable, signed archive of ledger + public key + policy snapshot + manifest. `manifest.policies_hash` commits to the policy bytes; `record.policy.hash` commits to the exact policy at each decision. | `custos bundle -o evidence-YYYY-MM-DD.tar.gz && custos verify-bundle evidence-YYYY-MM-DD.tar.gz`. |

### CC6 — Logical and physical access

| Criterion | Custos evidence | How to extract | Custos does NOT provide |
|---|---|---|---|
| **CC6.1** Implements logical access security software, infrastructure, and architectures over protected information assets | Every tool call is evaluated against policy before execution; deny returns a JSON-RPC error and the call is not forwarded. `DecisionRecord.enforcement` names the enforcement point (`sdk`\|`proxy`\|`attest-only`) and effect (`blocked`\|`advisory`). | Grep the ledger by `decision:"deny"` or filter by `enforcement.effect:"blocked"`. | Identity provisioning; the `actor.id` is caller-supplied. Pair with your SSO/OIDC provider. |
| **CC6.2** Registers and authorises new internal and external users | Out of scope. | — | User provisioning entirely. |
| **CC6.3** Removes access when no longer required | Partial: revoking an actor is a policy change — deny rules for the removed actor's id take effect on next policy reload; the change lands as a `policy-change` attestation in the ledger. | Filter attestations where `attestation.reason:"policy-change"`. | Identity lifecycle automation. |
| **CC6.6** Implements logical access security measures to protect against threats from sources outside its system boundaries | Proxy denies by default; policy hash is committed per record so a swapped-in weaker policy is detectable. | `custos verify --replay` re-evaluates recorded decisions against the pinned policy bytes. | Network perimeter, WAF, DDoS. |
| **CC6.7** Restricts the transmission, movement, and removal of information to authorised users and processes and protects it during transmission, movement, or removal | Partial: tool arguments and results are hashed into the ledger (`args_hash`, `result_hash`), keeping payloads off the audit surface while still binding each call cryptographically. | Ledger records commit to argument hashes; the transported data itself is not stored by Custos. | Encryption at rest of the tool-call payload; TLS on your transport. |
| **CC6.8** Implements controls to prevent or detect and act upon the introduction of unauthorised or malicious software | Policy hash on every decision detects unauthorised policy substitution. Ledger hash-chain detects mid-stream tampering. | `custos verify` walks the chain end-to-end; failure is cryptographically loud. | Malware scanning, EDR. |

### CC7 — System operations

This is the criterion set where Custos evidence is strongest.

| Criterion | Custos evidence | How to extract |
|---|---|---|
| **CC7.1** Uses detection and monitoring procedures to identify (1) changes to configurations that result in the introduction of new vulnerabilities, and (2) susceptibilities to newly discovered vulnerabilities | `record.policy.hash` changes when the policy source changes. Every `policy-change` attestation timestamps the swap. | `jq 'select(.type=="attestation" and .attestation.reason=="policy-change")' ledger.jsonl` |
| **CC7.2** Monitors system components and the operation of those components for anomalies that are indicative of malicious acts, natural disasters, and errors affecting the entity's ability to meet its objectives; anomalies are analysed to determine whether they represent security events | Coverage verifier (`custos verify --coverage`) flags any window between two attestations that exceeds the expected cadence — this is the "silent-down" detector. Signed startup / periodic / shutdown attestations make gaps cryptographically visible. | `custos verify --coverage --interval 60 --tolerance 2 ledger.jsonl` returns gaps with `from_ts`, `to_ts`, `duration_s`. Any non-empty `gaps` array is an anomaly for the auditor. |
| **CC7.3** Evaluates security events to determine whether they could or have resulted in a failure of the entity to meet its objectives (security incidents) and, if so, takes actions to prevent or address such failures | Every deny is a candidate security event with full context: actor, tool, args_hash, policy rule that fired, timestamp, trace_id. | `jq 'select(.decision=="deny")' ledger.jsonl` produces the security-event feed for triage. |
| **CC7.4** Responds to identified security incidents by executing a defined incident-response programme to understand, contain, remediate, and communicate security incidents, as appropriate | Partial: the ledger provides forensic evidence (immutable, signed, timestamped) that supports incident response. The response *process* itself is out of scope. | Bundle the ledger for the incident window: `custos bundle --since 2026-06-01 --until 2026-06-02`. |
| **CC7.5** Identifies, develops, and implements activities to recover from identified security incidents | Out of scope. | — |

### CC8 — Change management

| Criterion | Custos evidence | How to extract |
|---|---|---|
| **CC8.1** Authorises, designs, develops or acquires, configures, documents, tests, approves, and implements changes to infrastructure, data, software, and procedures to meet its objectives | Policy version control (in source, hashed on write) + content-addressed policy snapshots in the evidence bundle (`bundle/policies/<hex>.yaml`). Each decision cites the exact policy bytes that produced it — an auditor can walk the git history of your policy file and cross-reference each hash to the decisions it produced. | `git log <policy>.yaml` + `jq '.policy.hash' ledger.jsonl \| sort -u`. Every distinct hash in the ledger MUST resolve to a snapshot in the bundle. |

---

## Availability (partial)

| Criterion | Custos evidence | How to extract |
|---|---|---|
| **A1.2** Authorises, designs, develops or acquires, implements, operates, approves, maintains, and monitors environmental protections, software, data backup processes, and recovery infrastructure to meet its objectives | Attestation heartbeats produce a cryptographic uptime record. A ledger with continuous periodic attestations *is* an availability log for the gate itself. | `custos verify --coverage` — `window_s` and `total_gap_s` are the numerator/denominator of gate uptime. |

Custos does **not** address broader Availability criteria (backup,
disaster recovery, capacity planning).

---

## Processing Integrity (partial)

| Criterion | Custos evidence | How to extract |
|---|---|---|
| **PI1.4** Implements policies and procedures to make available or deliver output completely, accurately, and timely in accordance with specifications | Replay verification: `custos verify --replay` walks every decision, resolves the pinned policy from its snapshot, and re-evaluates it — a mismatch (recorded decision differs from policy's actual decision) is a processing-integrity failure. | `custos verify --replay ledger.jsonl` — `mismatches` array must be empty. |

Custos does **not** address input validation, business-logic correctness,
or output distribution — only the fidelity between the recorded decision
and the policy that produced it.

---

## Confidentiality / Privacy

Largely out of scope. Custos records **argument hashes**, not argument
values, precisely so that tool-call payloads (which may contain PII / PHI /
customer data) do not enter the audit surface. The audit trail can be
retained and shared with an assessor without exposing the underlying data.

Where confidentiality touches Custos: the ledger itself contains
`actor.id`, `tool` names, timestamps, and trace IDs. Treat the ledger as
its own sensitive artifact.

---

## What an auditor should ask for

A well-prepared engagement package:

1. The current policy file(s), committed to source control.
2. A signed evidence bundle (`custos bundle -o evidence.tar.gz`) covering the audit period.
3. Output of `custos verify-bundle evidence.tar.gz` (must return `ok: true`).
4. Output of `custos verify --replay` against the ledger (must return `mismatches: []`).
5. Output of `custos verify --coverage` (should return `gaps: []` given continuous periodic attestations).
6. Your policy change log: `git log <policy>.yaml`.
7. A one-page control narrative describing which of the criteria above Custos is intended to satisfy in your environment (this document is a starting point, not a substitute).

---

## Explicit non-goals

Custos does not, and does not intend to, evidence:

- Identity provisioning, authentication, or SSO (integrate your IdP; populate `actor.id` from the token).
- Encryption at rest of the underlying tool-call payloads (payloads are hashed, not stored).
- Network security, WAF, DDoS mitigation.
- Physical security of the host running Custos.
- Vendor / third-party risk management.
- Incident response *process* (the ledger provides forensic input; the process is yours).
- Backup, disaster recovery, business continuity.

Anyone reading this document as marketing collateral should treat the
"non-goals" section as the most important part.
