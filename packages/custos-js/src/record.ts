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
  record_hash?: string;
  sig?: string;
}

export const GENESIS_PREV_HASH = "sha256:" + "0".repeat(64);

export function newActor(id: string, kind = "mcp-client", meta: Record<string, string> = {}): Actor {
  return { id, kind, meta };
}

export function serverToDict(s: Server): { id: string; pubkey?: string } {
  return s.pubkey ? { id: s.id, pubkey: s.pubkey } : { id: s.id };
}

export function recordBody(rec: DecisionRecord): Record<string, unknown> {
  return {
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
    policy: rec.policy,
    latency_ms: rec.latency_ms,
    prev_hash: rec.prev_hash,
  };
}
