import { newSpanId, newTraceId, isoNowMs } from "./ids.js";
import { hashOfValue, Ledger } from "./ledger.js";
import { Policy } from "./policy.js";
import { Actor, Decision, DecisionRecord, Server, serverToDict } from "./record.js";

export interface GateResult<T = unknown> {
  decision: Decision;
  rule: string;
  reason: string;
  record: DecisionRecord;
  result?: T;
  error?: string;
  allowed: boolean;
}

export class Gate {
  constructor(
    public policy: Policy,
    public ledger: Ledger,
    public actor: Actor,
    public server: Server,
  ) {}

  private buildCtx(tool: string, args: unknown, traceId: string): Record<string, unknown> {
    return {
      tool,
      actor: { id: this.actor.id, kind: this.actor.kind, meta: this.actor.meta },
      server: serverToDict(this.server),
      args,
      trace_id: traceId,
    };
  }

  check(tool: string, args: unknown, traceId?: string): GateResult {
    const tid = traceId ?? newTraceId();
    const pd = this.policy.evaluate(this.buildCtx(tool, args, tid));
    const rec = this.buildRecord(tool, args, undefined, pd.decision, pd.ruleId, pd.reason, 0, tid);
    return { decision: pd.decision, rule: pd.ruleId, reason: pd.reason, record: rec, allowed: pd.decision === "allow" };
  }

  async call<T>(tool: string, args: Record<string, unknown>, fn: (args: any) => T | Promise<T>, traceId?: string): Promise<GateResult<T>> {
    const tid = traceId ?? newTraceId();
    const pd = this.policy.evaluate(this.buildCtx(tool, args, tid));
    if (pd.decision !== "allow") {
      const rec = this.buildRecord(tool, args, undefined, pd.decision, pd.ruleId, pd.reason, 0, tid);
      this.ledger.append(rec);
      return { decision: pd.decision, rule: pd.ruleId, reason: pd.reason, record: rec, allowed: false };
    }
    const t0 = performance.now();
    try {
      const result = await fn(args);
      const latency = Math.round(performance.now() - t0);
      const rec = this.buildRecord(tool, args, result, "allow", pd.ruleId, pd.reason, latency, tid);
      this.ledger.append(rec);
      return { decision: "allow", rule: pd.ruleId, reason: pd.reason, record: rec, result, allowed: true };
    } catch (e) {
      const latency = Math.round(performance.now() - t0);
      const err = e instanceof Error ? e.message : String(e);
      const reason = `tool error: ${err}`;
      const rec = this.buildRecord(tool, args, undefined, "error", pd.ruleId, reason, latency, tid);
      this.ledger.append(rec);
      return { decision: "error", rule: pd.ruleId, reason, record: rec, error: err, allowed: false };
    }
  }

  private buildRecord(
    tool: string, args: unknown, result: unknown,
    decision: Decision, rule: string, reason: string,
    latencyMs: number, traceId: string,
  ): DecisionRecord {
    return {
      v: 1,
      seq: 0,
      ts: isoNowMs(),
      trace_id: traceId,
      span_id: newSpanId(),
      actor: { id: this.actor.id, kind: this.actor.kind, meta: this.actor.meta },
      server: serverToDict(this.server),
      tool,
      args_hash: hashOfValue(args),
      result_hash: decision === "allow" && result !== undefined ? hashOfValue(result) : "",
      decision,
      policy: { engine: this.policy.engine, id: this.policy.id, rule, reason },
      latency_ms: latencyMs,
      prev_hash: "",
    };
  }
}
