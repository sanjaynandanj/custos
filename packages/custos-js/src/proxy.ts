import { spawn, ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

import { isoNowMs, newSpanId, newTraceId } from "./ids.js";
import { hashOfValue, Ledger } from "./ledger.js";
import { Policy } from "./policy.js";
import { Actor, Decision, DecisionRecord, Server, serverToDict } from "./record.js";
import { generateToken } from "./token.js";

const DENY_CODE = -32001;

export interface ProxyConfig {
  upstreamCmd: string[];
  policy: Policy;
  ledger: Ledger;
  actor: Actor;
  server: Server;
}

export async function runStdioProxy(cfg: ProxyConfig): Promise<number> {
  const [cmd, ...args] = cfg.upstreamCmd;
  if (!cmd) throw new Error("upstream cmd required");
  const proc: ChildProcess = spawn(cmd, args, { stdio: ["pipe", "pipe", "inherit"] });

  const pending = new Map<string | number, {
    tool: string; args: any; traceId: string; spanId: string;
    t0: number; rule: string; reason: string;
  }>();

  const clientRl = createInterface({ input: process.stdin });
  const upstreamRl = createInterface({ input: proc.stdout! });

  clientRl.on("line", (line: string) => {
    if (!line.trim()) return;
    let msg: any;
    try { msg = JSON.parse(line); } catch { proc.stdin!.write(line + "\n"); return; }
    if (msg && msg.method === "tools/call") {
      const params = msg.params ?? {};
      const tool = params.name ?? "";
      const args = params.arguments ?? {};
      const meta = params._meta ?? {};
      const traceId = meta.trace_id ?? newTraceId();
      const spanId = newSpanId();
      params._meta = { ...meta, trace_id: traceId, span_id: spanId };
      const ctx = {
        tool,
        actor: { id: cfg.actor.id, kind: cfg.actor.kind, meta: cfg.actor.meta },
        server: serverToDict(cfg.server),
        args,
        trace_id: traceId,
      };
      const pd = cfg.policy.evaluate(ctx);
      if (pd.decision !== "allow") {
        const rec = buildRecord(cfg, tool, args, undefined, pd.decision, pd.ruleId, pd.reason, 0, traceId, spanId);
        cfg.ledger.append(rec);
        const err = {
          jsonrpc: "2.0", id: msg.id,
          error: { code: DENY_CODE, message: `denied by policy: ${pd.ruleId || "default"}`, data: { reason: pd.reason, trace_id: traceId } },
        };
        process.stdout.write(JSON.stringify(err) + "\n");
        return;
      }
      // Attach a signed per-call attestation token to the forwarded
      // call's _meta so a cooperating upstream can prove the call
      // passed through Custos. See WIRE §8.
      try {
        const kp: any = (cfg.ledger as any).kp;
        if (kp && typeof kp.sign === "function") {
          params._meta.custos_token = generateToken(
            kp, traceId, spanId, tool, hashOfValue(args), isoNowMs(),
          );
        }
      } catch {
        // Token generation is best-effort — the ledger still records
        // the decision. Never block the forwarded call over an
        // optional evidence artifact.
      }
      pending.set(msg.id, { tool, args, traceId, spanId, t0: performance.now(), rule: pd.ruleId, reason: pd.reason });
      proc.stdin!.write(JSON.stringify(msg) + "\n");
    } else {
      proc.stdin!.write(line + "\n");
    }
  });

  upstreamRl.on("line", (line: string) => {
    if (!line.trim()) { process.stdout.write("\n"); return; }
    let msg: any;
    try { msg = JSON.parse(line); } catch { process.stdout.write(line + "\n"); return; }
    if (msg && pending.has(msg.id)) {
      const info = pending.get(msg.id)!;
      pending.delete(msg.id);
      const latency = Math.round(performance.now() - info.t0);
      const decision: Decision = msg.error ? "error" : "allow";
      const reason = decision === "allow" ? info.reason : `upstream error: ${JSON.stringify(msg.error)}`;
      const rec = buildRecord(cfg, info.tool, info.args, msg.result, decision, info.rule, reason, latency, info.traceId, info.spanId);
      cfg.ledger.append(rec);
    }
    process.stdout.write(line + "\n");
  });

  return new Promise<number>((resolve) => {
    proc.on("exit", (code) => resolve(code ?? 0));
  });
}

function buildRecord(
  cfg: ProxyConfig, tool: string, args: unknown, result: unknown,
  decision: Decision, rule: string, reason: string,
  latencyMs: number, traceId: string, spanId: string,
): DecisionRecord {
  return {
    v: 1, seq: 0, ts: isoNowMs(),
    trace_id: traceId, span_id: spanId,
    actor: { id: cfg.actor.id, kind: cfg.actor.kind, meta: cfg.actor.meta },
    server: serverToDict(cfg.server),
    tool,
    args_hash: hashOfValue(args),
    result_hash: decision === "allow" && result !== undefined ? hashOfValue(result) : "",
    decision,
    policy: {
      engine: cfg.policy.engine,
      id: cfg.policy.id,
      rule,
      reason,
      ...(cfg.policy.hash ? { hash: cfg.policy.hash } : {}),
    },
    latency_ms: latencyMs,
    prev_hash: "",
    // Stdio proxy is a hard enforcement point: a deny is a JSON-RPC error
    // and the upstream server never sees the forwarded call.
    enforcement: { point: "proxy", effect: "blocked" },
  };
}
