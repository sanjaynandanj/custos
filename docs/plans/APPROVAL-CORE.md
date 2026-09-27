# Plan: `approval` as a core policy outcome

**Status:** proposed
**Owner:** solo (Sanjay)
**Target:** v0.5.0

## Goal

Promote `approval` from a WebMCP-adapter-only decision (currently in
`packages/custos-js/src/adapters/webmcp.ts` and exercised by
`examples/webmcp-control-room/test/approvals.test.ts`) to a first-class
ledger outcome that also works for the stdio proxy, the in-process SDK, and
future transports.

Human-in-the-loop with a signed *pending* record is a natural fit for the
compliance story `docs/compliance/SOC2-mapping.md` and
`docs/compliance/HIPAA-mapping.md` already tell — but only if it applies
uniformly across surfaces, not just in the browser adapter.

## Non-goals

- OPA `policy_ref` threading through the wire format. Belongs in a later
  wire-format v2 batch alongside signed checkpoints and Merkle inclusion
  proofs (see `docs/COMPETITIVE.md` "Honest limitations and next moat").
- Cedar `@id("...")` annotation extraction into `rule_id`. Small separate
  PR.
- Any change to the ledger verifier semantics. Approval records are
  ordinary signed entries; the pair (approval + resolution) is a
  consumer-side pattern, not a verifier-side one.

## Wire spec changes (`spec/WIRE.md`)

1. Add `approval` to the Decision enum (currently `allow` / `deny` /
   `error`).
2. Define its semantics precisely: **the gate produced an opinion of
   pending human confirmation; the underlying tool did NOT execute at the
   moment this record was signed.** This is the meaning readers need to
   agree on.
3. Reuse the existing `Enforcement.effect` axis. Approvals are recorded
   with `effect: blocked` at the point they are signed — because at that
   moment, execution has not happened.
4. Introduce `decides_ref` as an optional field on `DecisionRecord`.
   When populated on a follow-up record, it names the record hash of the
   earlier `approval` record whose outcome this record resolves. Both the
   approval record and the resolution record are in the chain; the pair
   is the audit trail.
5. Bump the wire minor version. Old ledgers still verify. Old readers
   encountering `decision: "approval"` should treat them as "record valid,
   decision semantics unknown to me" rather than fail — matches the
   forward-compat pattern already documented at
   `packages/custos-py/src/custos/record.py:86-94`.

## Package changes

### Python (`packages/custos-py`)

- `record.Decision`: add `APPROVAL = "approval"`.
- `policy.PolicyDecision`: no schema change; new value flows through
  `decision` field.
- `sdk.Gate.call`: raise `PolicyApproval` (parallels the existing
  `PolicyDenied` at `custos/errors.py`) that carries the pending record
  hash so the caller can await resolution out of band and then submit a
  resolution record.
- New method: `Gate.resolve_approval(record_hash, resolution: Decision,
  reason: str)` — writes a follow-up `DecisionRecord` with
  `decides_ref=record_hash` and `decision` set to the resolution.
- `proxy.py`: on `approval`, the stdio proxy returns an MCP-compatible
  tool error naming the pending record hash (mirrors the WebMCP adapter's
  shape). It does NOT block the process waiting for resolution — that is
  the operator's job.
- `policy.py` native DSL: add `effect: approval` alongside `allow` and
  `deny`. Reference:
  `examples/webmcp-control-room/server/policy.ts` already models this
  shape; port that structure.

### JavaScript (`packages/custos-js`)

- `Decision` enum: add `APPROVAL`.
- Same shape of changes as Python: `Gate.call` produces a normalized
  approval outcome carrying the pending record hash; `Gate.resolveApproval`
  writes the follow-up record.
- Existing `packages/custos-js/src/adapters/webmcp.ts` migrates from its
  own approval type to the core one — no behaviour change for existing
  WebMCP integrators, just a common source of truth.

## Cross-language wire tests (`tests/cross-lang/`)

New fixture pair:

- `py_write_approval.py` + `js_verify_approval.mjs`: Python writes an
  approval record, then a resolution record with `decides_ref` back. JS
  verifies the chain and confirms both records deserialize with the
  expected decision values and back-pointer.
- Reverse: `js_write_approval.mjs` + `py_verify_approval.py`.
- Extend `run.sh` to include both fixtures.

## Dashboard

- `services/dashboard-py` and `services/dashboard-js` (whichever exist):
  render approval-pending state, resolution status, and the linked pair
  as a single block on the events view.
- Add a `?decision=approval` filter to `/api/events`.

## Compliance docs

- `docs/compliance/SOC2-mapping.md`: approval-with-signed-pending is a
  clean fit for CC6.3 (logical-access authorization) — an auditor can
  point at the two-record pair and show that a human authorized the
  specific action.
- `docs/compliance/HIPAA-mapping.md`: fits §164.308(a)(3) (workforce
  authorization) and §164.308(a)(4) (access management) evidence rows.

## Competitive positioning update

Once shipped, edit `docs/COMPETITIVE.md`:

- Wedge #4 loses the "Roadmap gap to close" paragraph.
- Upgrade its lead line from "in the WebMCP adapter" to "across all
  Custos surfaces (in-process SDK, stdio proxy, WebMCP)".

## Effort estimate

- Wire spec + Python core + Python tests: ~1 day
- JS core + JS tests + cross-lang fixtures: ~1 day
- Dashboards + compliance doc updates + COMPETITIVE.md refresh: ~half day
- Total: **2–3 days**

## Backward compatibility

Additive. Existing ledgers verify unchanged. Existing readers see records
with `decision: "approval"` and either display "unknown" or upgrade. No
producer that currently writes only `allow`/`deny` needs to change.

## Order of operations

1. WIRE spec draft (PR 1, docs only, invites review before code lands).
2. Python core + tests (PR 2).
3. JS core + tests (PR 3).
4. Cross-language fixtures (PR 4).
5. Dashboards + compliance + COMPETITIVE.md (PR 5).

Bundling into fewer PRs is fine if solo — the split above is optimistic
about review latency. Realistically: two PRs, one spec + Python, one JS +
cross-lang + docs.
