# Security Policy

Custos enforces policy on MCP tool calls and produces a tamper-evident audit
ledger. Because it sits on the invocation path for real agent actions, we take
security reports seriously. Thank you for helping keep users safe.

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security problems.**

Preferred path:

1. Open a private security advisory:
   <https://github.com/sanjaynandanj/custos/security/advisories/new>
2. Include a proof-of-concept, affected version(s), and the impact you observed.
3. If you cannot use GitHub advisories, open a public issue titled
   `security-contact` (with no vulnerability details) and a maintainer will
   reach out privately to coordinate.

## Response SLA

- **Acknowledgment:** within 3 business days of the advisory being filed.
- **Triage + fix or mitigation:** within 14 days for High/Critical severity.
- **Coordinated disclosure:** preferred. We will agree a disclosure date with
  the reporter and credit you in the advisory unless you ask us not to.

## Supported Versions

Only the latest published minor line is supported with security fixes.

| Version | Supported |
| ------- | --------- |
| 0.2.x   | Yes       |
| < 0.2   | No        |

When a new minor ships, the previous minor stops receiving security backports
unless we explicitly say otherwise in the release notes.

## Scope

**In scope:**

- Custos SDK (Python and Node)
- Custos CLI (`custos ...`)
- Custos proxy / Gate
- Custos dashboard (`custos serve`)
- Ledger reader/writer and verifier
- Bundle create / verify
- First-party adapters shipped in this repo

**Out of scope:**

- User-authored policies (a permissive policy is not a Custos vulnerability;
  we ship deny-by-default primitives, use them)
- Downstream MCP servers that Custos guards
- The host OS and any secrets stored outside Custos
- Third-party policy engines run as sidecars (e.g. Cedar, OPA) — their
  security posture is the operator's concern
- Third-party dependencies unless the vulnerability is triggerable through
  Custos's own API surface

## Security Model

- Custos is a Policy Enforcement Point (PEP). It evaluates policy **before**
  the guarded tool runs.
- Every allow / deny / redact / ask decision is written to a hash-chained,
  Ed25519-signed ledger.
- Ledger tampering is **detectable** (via chain and signature verification)
  but not **preventable** — Custos does not guarantee ledger integrity
  against an attacker with write access to the host.
- Custos does **not** prevent an agent from bypassing Custos entirely. If an
  agent calls a tool directly instead of through the Gate/proxy, no policy
  is enforced and no record is written. Deployment topology is what makes
  Custos load-bearing; Custos itself cannot force agents to route through it.
- Dashboard bearer-token auth (`--token`) is opt-in. Network exposure of
  `custos serve` is the operator's responsibility.

## Deployment Recommendations

- Store `.custos/ledger.key` on a user-only-readable path (`chmod 600` on
  POSIX; keep it inside the user profile on Windows and do not sync it to
  shared drives).
- Do **not** expose `custos serve` to untrusted networks without `--token`,
  and prefer binding to `127.0.0.1` when the dashboard is only for the
  operator.
- Ledger records store `args_hash` (SHA-256 over canonical JSON), never raw
  args or tool results. It is safe to include sensitive values in the tool
  argument dict — they are not written to the ledger.
- Rotate signing keys periodically. See the roadmap for the key-rotation
  workflow; until then, generate a new key and archive the old ledger.
- If you archive ledgers, verify the bundle's `policies_hash` (added in
  v0.3.0) with `custos verify-bundle` on the archival side, not just at
  write time.

## Threat Model Summary

**In scope for a security report:**

- Policy bypass caused by Custos misuse (a request path that reaches the
  guarded tool without a matching ledger record)
- Unauthorized tool invocation through the Gate/proxy
- Undetected ledger tampering (a mutation the verifier accepts as valid)
- Policy engine correctness bugs (a rule that should deny but allows, or
  vice versa)
- Injection through first-party adapters (arg parsing, DSL evaluation)

**Out of scope for a security report:**

- Side-channel timing attacks on policy evaluation
- Compromised host / root-level attacker on the same machine
- Supply-chain compromises of upstream dependencies
  (`cryptography`, `js-yaml`, etc.) — report those upstream first, then
  ping us so we can pin or replace

If you are unsure whether something is in scope, file the advisory anyway
and we will triage.
