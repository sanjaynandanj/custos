export type Decision = "allow" | "deny" | "error";

export interface Actor {
  id: string;
  kind: string;
  meta: Record<string, string>;
}

export interface Server {
  id: string;
  pubkey?: string;
}

export interface PolicyResult {
  engine: string;
  id: string;
  rule: string;
  reason: string;
  /**
   * sha256:<hex> of the exact policy source in effect at decision time.
   * Emitted on the wire only when non-empty; readers must tolerate its
   * absence for cross-version compatibility with records produced before
   * v0.4.0. See spec/WIRE.md §6.1.
   */
  hash?: string;
}

/**
 * Labels the enforcement point and effect of a decision (WIRE §2.2).
 *
 * `point` names WHERE the control ran:
 *   - `sdk`         — in-process Gate.call wrapping the tool function.
 *   - `proxy`       — stdio/HTTP MCP proxy in front of the server.
 *   - `attest-only` — log-and-continue; no execution boundary crossed.
 *
 * `effect` names WHAT HAPPENED when the decision was `deny`:
 *   - `blocked`  — the forwarded call / wrapped function did not run.
 *   - `advisory` — the tool WAS executed regardless (staged rollout).
 *
 * The distinction matters for audit: a `deny` in `advisory` mode proves
 * the gate had an opinion, NOT that the action failed to occur.
 */
export interface Enforcement {
  point: "sdk" | "proxy" | "attest-only";
  effect: "blocked" | "advisory";
}

export const VALID_ENFORCEMENT_POINTS = ["sdk", "proxy", "attest-only"] as const;
export const VALID_ENFORCEMENT_EFFECTS = ["blocked", "advisory"] as const;

/**
 * Author-time validation of an `Enforcement` sub-object. Called by the
 * Gate constructor and any other site that accepts a caller-supplied
 * enforcement label. NOT called by wire deserialization — records preserve
 * whatever producer wrote for forward-compatibility with future enum
 * extensions.
 *
 * TypeScript's union type is compile-time only; a plain-JS caller (or a
 * cast) can pass any string. This gets the typo caught before it lands
 * in the ledger where it would look valid to a downstream reader.
 */
export function validateEnforcement(e: Enforcement): void {
  if (!(VALID_ENFORCEMENT_POINTS as readonly string[]).includes(e.point)) {
    throw new Error(
      `Enforcement.point must be one of ${JSON.stringify(VALID_ENFORCEMENT_POINTS)}, ` +
      `got ${JSON.stringify(e.point)}`,
    );
  }
  if (!(VALID_ENFORCEMENT_EFFECTS as readonly string[]).includes(e.effect)) {
    throw new Error(
      `Enforcement.effect must be one of ${JSON.stringify(VALID_ENFORCEMENT_EFFECTS)}, ` +
      `got ${JSON.stringify(e.effect)}`,
    );
  }
}

export interface DecisionRecord {
  v: number;
  seq: number;
  ts: string;
  trace_id: string;
  span_id: string;
  actor: Actor;
  server: { id: string; pubkey?: string };
  tool: string;
  args_hash: string;
  result_hash: string;
  decision: Decision;
  policy: PolicyResult;
  latency_ms: number;
  prev_hash: string;
  enforcement?: Enforcement;
  record_hash?: string;
  sig?: string;
}

export const GENESIS_PREV_HASH = "sha256:" + "0".repeat(64);

// ---------------------------------------------------------------------------
// Attestation records (added in v0.4.0; see WIRE §2.3).
//
// Attestation records live in the same signed hash-chained JSONL as
// decision records, so a gap in the chain is detectable and control
// liveness becomes cryptographic instead of best-effort. Wire
// discriminator is a top-level `type` field: absent (or "decision")
// means DecisionRecord; "attestation" means the fields below apply and
// the decision-only fields are absent.
// ---------------------------------------------------------------------------

export type AttestationReason =
  | "startup"
  | "periodic"
  | "policy-change"
  | "actor-change"
  | "shutdown";

export interface AttestationRecord {
  v: number;
  seq: number;
  ts: string;
  trace_id: string;
  span_id: string;
  prev_hash: string;
  type: "attestation";
  attestation: {
    reason: AttestationReason;
    custos_version: string;
    policy_hash: string;
    active_actors: string[];
    uptime_ms: number;
  };
  record_hash?: string;
  sig?: string;
}

/** Canonical body (no record_hash/sig) for an attestation record. */
export function attestationBody(rec: AttestationRecord): Record<string, unknown> {
  return {
    v: rec.v,
    seq: rec.seq,
    ts: rec.ts,
    trace_id: rec.trace_id,
    span_id: rec.span_id,
    prev_hash: rec.prev_hash,
    type: rec.type,
    attestation: rec.attestation,
  };
}

export function newActor(id: string, kind = "mcp-client", meta: Record<string, string> = {}): Actor {
  return { id, kind, meta };
}

export function serverToDict(s: Server): { id: string; pubkey?: string } {
  return s.pubkey ? { id: s.id, pubkey: s.pubkey } : { id: s.id };
}

export function recordBody(rec: DecisionRecord): Record<string, unknown> {
  // Build the policy sub-object explicitly so we can omit `hash` when
  // empty — canonical serialization sorts keys and forbids `undefined`,
  // so a present-but-empty field would diverge from the Python wire
  // format. Mirrors PolicyResult.to_dict() in record.py.
  const policy: Record<string, unknown> = {
    engine: rec.policy.engine,
    id: rec.policy.id,
    rule: rec.policy.rule,
    reason: rec.policy.reason,
  };
  if (rec.policy.hash) policy.hash = rec.policy.hash;
  const body: Record<string, unknown> = {
    v: rec.v,
    seq: rec.seq,
    ts: rec.ts,
    trace_id: rec.trace_id,
    span_id: rec.span_id,
    actor: { id: rec.actor.id, kind: rec.actor.kind, meta: rec.actor.meta },
    server: rec.server,
    tool: rec.tool,
    args_hash: rec.args_hash,
    result_hash: rec.result_hash,
    decision: rec.decision,
    policy,
    latency_ms: rec.latency_ms,
    prev_hash: rec.prev_hash,
  };
  // Additive: emit `enforcement` only when populated so v0.3.0-era
  // readers (which don't know the field) still verify.
  if (rec.enforcement) body.enforcement = rec.enforcement;
  return body;
}
