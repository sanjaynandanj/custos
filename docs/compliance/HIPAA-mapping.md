# Custos — HIPAA Security Rule evidence mapping

**Scope.** This document maps Custos evidence to the HIPAA Security Rule
(45 CFR Part 164, Subpart C). It is a **crib sheet for a covered entity's
or business associate's assessor**, not a certification, and not a
substitute for a full risk analysis under §164.308(a)(1)(ii)(A).

Custos is one Technical Safeguard among several a covered entity must
maintain. It is directly relevant to **audit controls** (§164.312(b)),
**integrity** (§164.312(c)), and **information system activity review**
(§164.308(a)(1)(ii)(D)). It is largely out of scope for administrative
policy, workforce training, contingency planning, physical safeguards, and
Business Associate Agreements.

**PHI note.** Custos records `sha256:` hashes of tool call arguments and
results, not the values themselves. This is intentional: the audit trail
can be retained, transported, and shared with an assessor without
transporting PHI. Where PHI enters the picture is in the *arguments and
results* passed through gated tools — Custos evidences that the calls
happened and were governed, but the underlying data is handled by your
upstream tools and their own safeguards.

---

## §164.312 — Technical safeguards

### (a) Access control

| Standard / implementation spec | Custos evidence | How to extract | Custos does NOT provide |
|---|---|---|---|
| **(a)(1)** Access control — implement technical policies and procedures for electronic information systems that maintain electronic protected health information to allow access only to those persons or software programmes that have been granted access rights | Policy DSL evaluates every `tools/call` against actor-scoped rules before the tool executes. Deny returns a JSON-RPC error; the call is not forwarded. Rules can match on `actor.id`, `actor.kind`, `tool`, and argument paths. | `spec/POLICY.md` cookbook, `spec/WIRE.md §6`, and grep the ledger by actor: `jq 'select(.actor.id=="agent-X")' ledger.jsonl`. | Identity provisioning; `actor.id` is caller-supplied. Pair with your IdP. |
| **(a)(2)(i)** Unique user identification (required) | `actor.id` is recorded on every decision. | Ledger field `actor.id`. | Uniqueness enforcement upstream; that lives in your identity system. |
| **(a)(2)(ii)** Emergency access procedure (required) | Out of scope. | — | Break-glass workflows are process, not gate evidence. |
| **(a)(2)(iii)** Automatic logoff (addressable) | Out of scope for Custos; applies to interactive sessions, not agent tool calls. | — | Session termination. |
| **(a)(2)(iv)** Encryption and decryption (addressable) | Custos hashes payloads into the ledger; the ledger itself is signed but not encrypted. | — | Payload encryption at rest — pair with your tool-side controls. |

### (b) Audit controls — §164.312(b)

**This is the bullseye.** The Security Rule text:

> Implement hardware, software, and/or procedural mechanisms that record
> and examine activity in information systems that contain or use
> electronic protected health information.

| Custos evidence | How to extract |
|---|---|
| **Every tool call produces exactly one signed, hash-chained JSONL record.** Fields include `ts` (RFC3339 UTC ms), `actor.id`, `tool`, `args_hash`, `result_hash`, `decision` (allow / deny / error), `policy.rule` (which rule fired), `policy.reason`, `trace_id`, `span_id`, `latency_ms`, `enforcement.point`, `enforcement.effect`, `record_hash`, `sig` (Ed25519). | Read the JSONL ledger directly; each line is a self-contained record. `custos verify ledger.jsonl` proves the chain is intact. |
| **The chain is tamper-evident.** Each record's `prev_hash` commits to the previous record's `record_hash`; the genesis record's `prev_hash` is 64 zeros. Any insertion, deletion, or edit breaks the chain. Records are Ed25519-signed against a public key you publish alongside the ledger. | `custos verify` walks the chain end-to-end. Failure returns a specific line number and error class. |
| **The recording control is itself auditable.** Startup, periodic, policy-change, and shutdown attestation records live in the same signed chain, so the ledger evidences its own liveness. `custos verify --coverage` flags any window where attestations went silent — this is the "did you turn off the audit?" detector. | `custos verify --coverage --interval 60 --tolerance 2 ledger.jsonl` — non-empty `gaps` array is a coverage failure. |

Assessor-facing takeaway: §164.312(b) asks whether you can **record** and
**examine** activity. Custos delivers both, cryptographically, in a
format any auditor can grep with `jq`.

### (c) Integrity — §164.312(c)

> Implement policies and procedures to protect electronic protected
> health information from improper alteration or destruction.

| Standard | Custos evidence | How to extract |
|---|---|---|
| **(c)(1)** Integrity | Ledger hash chain (SHA-256 per record, chained via `prev_hash`) + Ed25519 signature per record. Sequence numbers strictly increase by 1; any gap is detectable. | `custos verify` fails on any of: seq gap, prev_hash mismatch, record_hash mismatch, invalid signature. |
| **(c)(2)** Mechanism to authenticate electronic PHI (addressable) | The audit trail *of PHI-touching tool calls* is cryptographically authenticated. Authentication of the PHI payloads themselves is upstream (Custos hashes them, does not carry them). | Verify record signature against `ledger.pub`. |

### (d) Person or entity authentication — §164.312(d)

> Implement procedures to verify that a person or entity seeking access
> to electronic protected health information is the one claimed.

Partial. Custos records who the caller *claims* to be (`actor.id`), and
the per-call attestation token (WIRE §9) lets a cooperating downstream
tool cryptographically verify that a call reached it via a Custos gate.
Custos does not authenticate the human or agent behind `actor.id` — that
is your identity provider's job. Deploy behind an authenticated transport
and populate `actor.id` from the authenticated principal.

### (e) Transmission security — §164.312(e)

Out of scope. Custos operates in-process (SDK) or over stdio / JSON-RPC
(proxy); transport security is your deployment concern (TLS, mTLS).

---

## §164.308 — Administrative safeguards (partial)

### (a)(1)(ii)(D) Information system activity review (required)

> Implement procedures to regularly review records of information system
> activity, such as audit logs, access reports, and security incident
> tracking reports.

Custos provides the *records*; the *review procedure* is yours. What Custos
gives you to review:

| Activity | How to surface it |
|---|---|
| All denies over the audit period | `jq 'select(.decision=="deny")' ledger.jsonl` |
| All errors (policy or tool) | `jq 'select(.decision=="error")' ledger.jsonl` |
| Per-actor call volume | `jq -r '.actor.id' ledger.jsonl \| sort \| uniq -c` |
| Per-tool call volume | `jq -r '.tool' ledger.jsonl \| sort \| uniq -c` |
| Policy version changes over the period | `jq 'select(.type=="attestation" and .attestation.reason=="policy-change")' ledger.jsonl` |
| Gate downtime windows | `custos verify --coverage ledger.jsonl` |

### (a)(5)(ii)(C) Log-in monitoring (addressable)

Partial: Custos captures every gated call by actor, providing a
call-level activity log. Login events themselves are your IdP's concern.

### (a)(8) Evaluation (required)

> Perform a periodic technical and non-technical evaluation ...

Signed evidence bundles (`custos bundle`) are the portable input to
periodic evaluations. Each bundle carries the ledger, the public key, the
policy snapshot(s), and a signed manifest.

---

## What an assessor should ask for

1. The current policy file, committed to source control.
2. A signed evidence bundle covering the assessment period: `custos bundle -o evidence.tar.gz`.
3. `custos verify-bundle evidence.tar.gz` returns `ok: true`.
4. `custos verify --replay` returns `mismatches: []`.
5. `custos verify --coverage` returns `gaps: []` (assuming continuous periodic attestations).
6. A short control narrative that names which HIPAA safeguards Custos is intended to satisfy in your environment.

---

## Explicit non-goals

Custos does not, and does not intend to, evidence:

- Workforce training (§164.308(a)(5)).
- Security management process, sanction policy, risk analysis (§164.308(a)(1)).
- Assigned security responsibility (§164.308(a)(2)).
- Workforce clearance and termination (§164.308(a)(3), (a)(4)).
- Contingency planning, backup, disaster recovery, emergency mode operation (§164.308(a)(7)).
- Business Associate Agreements (§164.308(b)).
- Physical safeguards (§164.310).
- Encryption of the underlying PHI payloads (payloads are hashed into the ledger, not carried).
- Person authentication upstream of the gate (integrate your IdP).
- Transmission encryption (deploy behind TLS / mTLS).

Anyone treating this document as marketing should re-read this section.
