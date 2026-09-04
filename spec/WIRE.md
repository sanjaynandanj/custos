# Custos Wire Spec v1

This spec defines the on-disk and on-wire formats that every Custos implementation MUST follow so that ledgers written by one language can be verified by another.

## 1. Canonical JSON

Whenever a record is hashed or signed, it MUST first be serialized as **Canonical JSON**:

- UTF-8, no BOM
- Object keys sorted lexicographically at every depth
- No insignificant whitespace (`separators=(",", ":")`)
- No trailing newline in the hashed form
- Numbers rendered as compact JSON numbers; timestamps are strings
- Unicode NOT escaped (raw UTF-8 bytes)

Reference implementations: `custos.canonical.dumps` (Python), `canonical(...)` (Node).

## 2. Decision Record

Every gated tool call produces exactly one record appended to the ledger. Field order is illustrative; canonical serialization sorts keys.

```jsonc
{
  "v": 1,                          // spec version
  "seq": 42,                       // monotonic per-ledger sequence, starts at 0
  "ts": "2026-08-08T12:34:56.789Z",// RFC3339 UTC, millisecond precision
  "trace_id": "01HXYZ...",         // 128-bit hex or ULID; shared across correlated calls
  "span_id": "abc123def456",       // 64-bit hex per call
  "actor": {
    "id": "agent-1",
    "kind": "mcp-client",
    "meta": {}                     // optional; opaque map of strings
  },
  "server": {
    "id": "fs-server",
    "pubkey": "base64-ed25519-32bytes"  // MCP server identity key (optional)
  },
  "tool": "read_file",
  "args_hash": "sha256:hex...",    // sha256 of canonical JSON of args
  "result_hash": "sha256:hex...",  // sha256 of canonical JSON of result, or "" if denied
  "decision": "allow",             // one of: allow | deny | error
  "policy": {
    "engine": "native",            // native | cedar | opa
    "id": "default",               // policy bundle id (author-supplied name)
    "rule": "allow-fs-read",       // matching rule id, or "" for default
    "reason": "whitelisted read path",
    "hash": "sha256:hex..."        // optional; see §6.1
  },
  "latency_ms": 12,                // int, 0 for deny (call never executed)
  "prev_hash": "sha256:hex...",    // record_hash of previous record; 64 zeros for seq=0
  "enforcement": {                 // optional; see §2.2
    "point": "sdk",                //   sdk | proxy | attest-only
    "effect": "blocked"            //   blocked | advisory
  },
  "record_hash": "sha256:hex...",  // see §3
  "sig": "ed25519:base64-64bytes"  // see §3
}
```

## 2.2. Enforcement label (added in v0.4.0)

Every `DecisionRecord` MAY include an `enforcement` sub-object naming
WHERE the control ran and WHAT HAPPENED on `deny`. The point is to make
the record honest about its own authority:

- **`point`** — one of:
  - `sdk`         — in-process `Gate.call` wrapping the tool function.
  - `proxy`       — stdio/HTTP MCP proxy in front of the server.
  - `attest-only` — log-and-continue; no execution boundary crossed.
- **`effect`** — one of:
  - `blocked`  — on `deny`, the forwarded call / wrapped function did NOT
                 run. The action failed to happen via this path.
  - `advisory` — on `deny`, the tool WAS executed regardless (staged
                 rollout mode). The record proves the gate had an
                 opinion, NOT that the action failed to occur.

Auditors reading a `deny` row without this label cannot distinguish
"the action was prevented" from "the gate objected but the action
happened anyway." A blank `enforcement` field means the writer predates
this label; treat as unknown.

### Writer conventions

- The bundled `Gate` SDK writes `{point: "sdk", effect: "blocked"}` by
  default, `effect: "advisory"` when constructed with `advisory=True`.
- The bundled stdio proxy writes `{point: "proxy", effect: "blocked"}`
  since a deny returns a JSON-RPC error and the upstream never sees the
  forwarded call.
- Third-party adapters (Cedar/OPA/LangGraph/etc.) SHOULD populate the
  field to match their actual behavior.

### Reader conventions

- Additive: readers MUST accept records that omit `enforcement`.
- Present-but-empty (`{}`) is not valid; writers either emit both
  sub-fields or omit the whole object.
- The signed body includes `enforcement` only when non-null, so old and
  new records verify under the same hash rules.

## 2.3. Attestation records (added in v0.4.0)

Ledgers MAY include **attestation records** interleaved with decision
records. They live in the same signed hash-chained JSONL, share the
same signing key, and participate in the same sequence numbering — so a
gap in the chain (a missing sequence number, a broken prev_hash) is
detectable regardless of record type, and control liveness becomes
cryptographic instead of best-effort log-scraping.

The wire discriminator is a top-level `type` field: absent (or
`"decision"`) means the record is a DecisionRecord (§2); `"attestation"`
means the record has the shape below and the decision-only fields
(tool, args_hash, result_hash, decision, policy, latency_ms, actor,
server, enforcement) are absent.

```jsonc
{
  "v": 1,
  "seq": 1234,
  "ts": "2026-08-08T12:34:56.789Z",
  "trace_id": "01HXYZ...",
  "span_id": "abc123def456",
  "prev_hash": "sha256:hex...",
  "type": "attestation",
  "attestation": {
    "reason": "startup",         // startup | periodic | policy-change
                                 //         | actor-change | shutdown
    "custos_version": "0.4.0",   // runtime version string
    "policy_hash": "sha256:hex", // active policy hash, "" if none
    "active_actors": ["agent-1"],// actor IDs the gate is enforcing for
    "uptime_ms": 3600000         // ms since process start, 0 at startup
  },
  "record_hash": "sha256:hex...",
  "sig": "ed25519:base64-64bytes"
}
```

### Writer conventions

- The bundled `Gate` SDK emits a `"startup"` attestation on
  construction (opt out with `attest=false`).
- Long-running deployments SHOULD emit `"periodic"` attestations on a
  fixed cadence — recommended 60s — so a verifier can compute expected
  count over a window and flag gaps as observable downtime.
- Reloading or rotating the active policy SHOULD emit a
  `"policy-change"` attestation carrying the new `policy_hash`.
- Clean shutdown SHOULD emit a `"shutdown"` attestation. Its absence
  from the tail of a ledger is evidence of crash / unclean exit.

### Reader conventions

- Chain verification (§3) applies uniformly — hash the body as-is,
  check prev_hash link, verify signature. No type-specific parsing is
  required for integrity.
- Replayers of decision records (`custos verify --replay`) MUST skip
  records with `type: "attestation"`.
- Coverage verifiers (`custos verify --coverage`) MUST enumerate
  `type: "attestation"` records and analyze their `reason` and `ts`
  values to detect gaps.

## 3. Hash Chain & Signature

1. Build the record with all fields **except** `record_hash` and `sig` populated.
2. Compute `body = canonical_json(record_without_hash_and_sig)`.
3. `record_hash = "sha256:" + hex(sha256(body))`.
4. Populate `record_hash`.
5. Compute `sig_input = hex_decode(record_hash.split(":")[1])` — the raw 32-byte digest.
6. `sig = "ed25519:" + base64(ed25519_sign(signing_key, sig_input))`.
7. Populate `sig`.
8. Serialize the final record with canonical JSON and append one line to the JSONL ledger.

The **genesis** record MUST have `prev_hash = "sha256:" + "0" * 64`.

## 4. Ledger File

Path convention: `<dir>/ledger.jsonl` alongside `<dir>/ledger.pub` (base64 ed25519 public key, 32 bytes, no newline).

- One record per line, canonical JSON, LF-terminated
- Append-only; verifiers MUST reject any record whose `prev_hash` does not match the prior line's `record_hash`
- Sequence numbers MUST be strictly increasing by 1

## 5. Evidence Bundle

A portable audit export is a `.tar.gz` containing:

```
bundle/
  manifest.json     # {"v":1,"created":"...","records":N,"pubkey":"...","policies_hash":"sha256:..."}
  ledger.jsonl
  ledger.pub
  policies/         # snapshot of active policy bundle
```

`manifest.json` is signed with the same key; signature at `bundle/manifest.sig`.

### `policies_hash` (optional, added in v0.3.0)

If a bundle includes a `bundle/policies/` snapshot, the manifest MAY include a
`policies_hash` field that commits to the exact bytes of those files. This lets
verifiers detect post-signing tampering of individual policy files inside the
tarball (the manifest signature alone would not catch this).

Computation:

1. Enumerate every file under `bundle/policies/`. Use its path relative to
   `bundle/policies/` (POSIX slashes) as the `name`.
2. For each file, compute `sha256(file_bytes)` as lowercase hex.
3. Build a list `[{"name": <rel-path>, "sha256": <hex>}, ...]` sorted by
   `name` lexicographically.
4. Serialize the list as Canonical JSON (§1).
5. `policies_hash = "sha256:" + hex(sha256(canonical_list_bytes))`.

Behaviour:

- Writers MAY emit `policies_hash`. When policies are absent, it MAY be omitted.
- Verifiers that see `policies_hash` MUST recompute it and reject the bundle on
  mismatch.
- Verifiers MUST accept bundles that do NOT contain `policies_hash`
  (backwards-compatible with bundles produced by pre-v0.3.0 writers).

### 5.1. Content-addressed policy snapshots (added in v0.4.0)

A well-formed v0.4.0 bundle SHOULD contain a snapshot of every distinct
`policy.hash` referenced by any record in the ledger. Snapshots are
content-addressed by filename:

```
bundle/policies/<hex>.<ext>
```

where `<hex>` is the lowercase hex portion of `policy.hash` (with the
`sha256:` prefix stripped) and `<ext>` is the original extension of the
policy source (`yaml`, `yml`, `json`, ...). A verifier reconstructing
the decision at `record.policy.hash = sha256:abc123...ext` locates the
source by glob: `bundle/policies/abc123....<any>`.

Runtime convention: the Gate SDK auto-snapshots the active policy to
`<ledger.parent>/policies/<hex>.<ext>` on construction (opt-out via
`snapshot_policy=False`). The `custos bundle` command defaults to that
directory when the caller does not pass an explicit `--policies-dir`.

`policies_hash` (§5) covers every file under `bundle/policies/` — legacy
by-basename snapshots and by-hash snapshots alike — so tamper detection
extends to the content-addressed layout automatically.

## 6. Policy DSL v1

YAML or JSON. Both languages ship the same evaluator.

```yaml
version: 1
id: default              # policy bundle id, recorded in decisions
default: deny            # allow | deny
rules:
  - id: allow-fs-read
    when:
      tool: read_file           # exact match, supports * wildcards
      actor.id: "agent-*"
      args.path: {prefix: "/workspace/"}
    decision: allow
    reason: whitelisted read path

  - id: deny-shell
    when:
      tool: {regex: "^shell\\..*$"}
    decision: deny
    reason: shell tools disabled

  - id: allow-http-get
    when:
      tool: http_request
      args.method: {in: ["GET", "HEAD"]}
      args.url: {prefix: "https://"}
    decision: allow
    reason: safe method + https only
```

### Match operators

| operator | meaning                                     |
|----------|---------------------------------------------|
| scalar   | exact equality; strings support `*` glob    |
| `prefix` | string startswith                           |
| `suffix` | string endswith                             |
| `contains` | substring                                 |
| `regex`  | ECMA/PCRE-compatible regex, unanchored      |
| `in`     | value ∈ list                                |
| `not_in` | value ∉ list                                |
| `eq`/`ne`| exact / not exact                           |
| `gt`/`lt`/`gte`/`lte` | numeric compare              |
| `exists` | boolean: field present                      |

### Path resolution

Dotted paths resolve against a context object:

```
{
  "tool": "<name>",
  "actor": {...},
  "server": {...},
  "args": {...},
  "trace_id": "...",
  "meta": {...}
}
```

Missing paths compare as `null`. Only `exists: false` matches missing paths.

### Evaluation

Rules are evaluated top-to-bottom; **first match wins**. If no rule matches, `default` is used.

## 6.1. Policy content hash (added in v0.4.0)

Every `DecisionRecord.policy` MAY include a `hash` field of the form
`sha256:<lowercase-hex>`. This value commits to the exact policy source
that was in effect when the decision was made. It exists so that an
auditor can, months or years later, reconstruct which policy text
produced a given decision — without trusting any external log about
"which version was live" and without relying on the author-supplied
`id` field, which is a name and not a fingerprint.

### Computation

- **File-backed policies** (loaded from `path/to/policy.yaml`):
  `hash = "sha256:" + hex(sha256(file_bytes))`. The raw on-disk bytes
  are hashed, before parsing. This means CRLF and LF line endings
  produce different hashes; comments and key order matter. That is
  intentional: the hash pins the exact artifact that was committed to
  source control, which is what an auditor will diff.
- **Programmatic policies** (constructed from an in-memory dict):
  `hash = "sha256:" + hex(sha256(canonical_json(dict)))`, using the
  Canonical JSON encoding from §1. Programmatic callers have no "raw
  file," so the same canonicaliser used everywhere else on the wire is
  applied.

### Behaviour

- Writers ≥ v0.4.0 SHOULD emit `hash` on every record.
- Writers MAY omit `hash` for `Policy` objects constructed without a
  hash source (e.g. third-party adapters that predate this field).
- Readers MUST accept records that omit `hash` (backwards-compatible
  with pre-v0.4.0 ledgers).
- Readers that see `hash` MUST include it in the canonical body they
  recompute for chain / signature verification; readers that see no
  `hash` MUST omit it. Old and new records verify under the same
  rules because `hash` is serialised only when non-empty (see §1).

### Relationship to `manifest.policies_hash`

`manifest.policies_hash` (§5) commits to the bytes of the policy
snapshot bundled in an evidence archive. `policy.hash` on a
DecisionRecord commits to the bytes of the policy that produced that
specific decision. A well-formed v0.4.0 bundle contains a
content-addressed snapshot for every distinct `policy.hash` that
appears in the ledger; see §5.1.

## 7. MCP Proxy Behavior

- Proxy speaks JSON-RPC 2.0 over stdio or HTTP, transparently forwarding all methods **except** `tools/call`.
- For `tools/call`, the proxy:
  1. Extracts `params.name` (tool) and `params.arguments`
  2. Builds evaluation context from configured actor/server identity
  3. Evaluates policy → decision
  4. If `allow`: forwards, times execution, records with `result_hash`
  5. If `deny`: replies with JSON-RPC error `{code: -32001, message: "denied by policy: <rule>"}` and records with `result_hash = ""`
  6. If policy engine errors: `decision = "error"`, deny by default, record reason

## 8. Trace Correlation

- If incoming request has `_meta.trace_id`, use it; else generate a new ULID.
- `span_id` is per-call (16 hex chars).
- Both are copied into the outgoing forwarded request under `_meta` so downstream servers see the same trace.

## 9. Per-call Attestation Tokens (added in v0.4.0)

A **call attestation token** is a compact, signed proof that a specific
tool call passed the Custos gate. The proxy (or SDK) generates one on
every `allow` decision and injects it into the forwarded call's
`_meta.custos_token`. A cooperating tool server verifies the token
before executing and logs verified / rejected / unattested calls.

Without downstream cooperation, the Custos ledger proves properties
about the calls that reached it — not that those were all the calls.
Attestation tokens close that gap: cross-checking the tool server's
"verified / unattested" log against the Custos ledger proves coverage
cryptographically.

### Format

URL-safe, no padding:

```
custos:v1:<b64url(canonical_json(payload))>.<b64url(ed25519_sig)>
```

The payload is Canonical JSON (§1). The signature is Ed25519 over the
raw payload bytes (NOT the base64url representation).

### Payload fields

| field       | type   | meaning                                            |
|-------------|--------|----------------------------------------------------|
| `trace_id`  | string | ULID/hex — matches DecisionRecord.trace_id         |
| `span_id`   | string | per-call hex — matches DecisionRecord.span_id      |
| `tool`      | string | tool name                                          |
| `args_hash` | string | `sha256:<hex>` of Canonical JSON of args           |
| `ts`        | string | RFC3339 UTC ms timestamp                           |
| `kid`       | string | b64url(sha256(pubkey)[0..8]) — issuer fingerprint  |

`kid` lets a verifier accept tokens from multiple issuers by mapping
`kid → pubkey`. Not required for security; the signature alone binds
the payload.

### Producer conventions

- The bundled SDK sets `GateResult.token` on every ALLOW outcome. Caller
  is responsible for propagating the token (e.g. inserting into an HTTP
  header) if the transport is not the stdio proxy.
- The stdio proxy injects the token into `_meta.custos_token` of the
  forwarded JSON-RPC call.
- Producers MUST NOT emit tokens on DENY or ERROR — the token means
  "this call passed the gate," which by definition is false for deny.

### Verifier conventions

- Verifiers MUST reject tokens whose signature does not verify against
  the expected public key.
- Verifiers MUST reject tokens missing any required payload field.
- Freshness (age of `ts`) is NOT enforced by the base verifier — it is
  application policy. Cooperating tool servers SHOULD reject tokens
  older than N seconds (recommended: 300s) to bound replay windows.
- Verifiers MAY additionally check that `tool` and `args_hash` match
  the request they are about to execute, defending against
  token-substitution attacks where an old token is re-used for a
  different call.

### What tokens do NOT prove

- **Tokens do not prove the tool ran.** They prove the request reached
  the tool with a valid attestation. A tool that verifies the token
  and then decides to no-op is still consistent with the token.
- **Tokens do not prove absence of bypass.** A tool that ignores the
  token check entirely accepts unattested calls without complaint;
  tokens are only as good as the tool's willingness to check them.
- **Tokens do not prove the call was executed by the intended tool
  instance.** Any process holding the public key can verify a token;
  the token binds the caller (Custos), not the callee.

This last paragraph is intentional: tokens are one layer in a coverage
story that also needs heartbeats (§2.3), enforcement labels (§2.2),
and — critically — deployment-layer credential scoping to prevent
alternate paths to the tool.
