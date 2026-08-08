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
    "id": "default",               // policy bundle id
    "rule": "allow-fs-read",       // matching rule id, or "" for default
    "reason": "whitelisted read path"
  },
  "latency_ms": 12,                // int, 0 for deny (call never executed)
  "prev_hash": "sha256:hex...",    // record_hash of previous record; 64 zeros for seq=0
  "record_hash": "sha256:hex...",  // see §3
  "sig": "ed25519:base64-64bytes"  // see §3
}
```

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
  manifest.json     # {"v":1,"created":"...","records":N,"pubkey":"..."}
  ledger.jsonl
  ledger.pub
  policies/         # snapshot of active policy bundle
```

`manifest.json` is signed with the same key; signature at `bundle/manifest.sig`.

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
