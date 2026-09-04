import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { newSpanId, newTraceId, isoNowMs } from "./ids.js";
import { hashOfValue, Ledger } from "./ledger.js";
import { Policy } from "./policy.js";
import { Actor, Decision, DecisionRecord, Enforcement, Server, serverToDict, validateEnforcement } from "./record.js";
import { generateToken } from "./token.js";

let _cachedVersion: string | null = null;

/**
 * Warn-once bucket for attestation failures. Keyed by the failing
 * Ledger's constructor name so different Ledger implementations each
 * get one warning, but a repeated failure on the same class stays
 * quiet.
 */
const _warnedAttestFor = new Set<string>();

function warnAttestOnce(ledger: Ledger, err: unknown): void {
  const kind = (ledger as any)?.constructor?.name ?? "Ledger";
  if (_warnedAttestFor.has(kind)) return;
  _warnedAttestFor.add(kind);
  const msg = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.warn(
    `custos: startup attestation failed on ${kind}: ${msg}. This Gate ` +
    "will produce no liveness records — `custos verify --coverage` will " +
    "show a silent-down window. Pass `{ attest: false }` to suppress " +
    "this warning if intentional.",
  );
}

/**
 * Read the package's declared version from package.json at import time.
 * Cached so we don't touch disk per Gate construction. Falls back to
 * "unknown" if package.json can't be located (bundled/single-file
 * deployments); callers may override via GateOptions.custosVersion.
 */
function readCustosVersion(): string {
  if (_cachedVersion !== null) return _cachedVersion;
  try {
    // src/sdk.ts → package.json is two levels up in the source tree
    // and one level up in the built dist. Walk parents until found.
    const here = dirname(fileURLToPath(import.meta.url));
    for (const rel of ["..", "../.."]) {
      try {
        const pkg = JSON.parse(readFileSync(join(here, rel, "package.json"), "utf8"));
        if (typeof pkg.version === "string") {
          _cachedVersion = pkg.version;
          return _cachedVersion!;
        }
      } catch { /* try next */ }
    }
  } catch { /* fallthrough */ }
  _cachedVersion = "unknown";
  return _cachedVersion;
}

export interface GateResult<T = unknown> {
  decision: Decision;
  rule: string;
  reason: string;
  record: DecisionRecord;
  result?: T;
  error?: string;
  allowed: boolean;
  /**
   * Signed per-call attestation token (WIRE §8). Populated on ALLOW
   * decisions. Cooperating tool servers verify it before executing to
   * prove the call actually went through Custos.
   */
  token?: string;
}

export interface GateOptions {
  /**
   * Snapshot the policy source to `<ledger.parent>/policies/<hex>.<ext>`
   * on construction so an evidence bundle can preserve every policy
   * version referenced by any record in the ledger. Default: true.
   * See spec/WIRE.md §5.1.
   */
  snapshotPolicy?: boolean;
  /**
   * Override the enforcement label attached to every record. Defaults to
   * `{ point: "sdk", effect: advisory ? "advisory" : "blocked" }`.
   */
  enforcement?: Enforcement;
  /**
   * Advisory mode: log the policy's decision but always execute the fn.
   * Useful for staged rollouts — the ledger shows what a stricter policy
   * would deny before you're ready to enforce. See WIRE §2.2.
   */
  advisory?: boolean;
  /**
   * Emit a startup attestation on construction so ledger silence stops
   * being ambiguous ("nothing happened" vs "you stopped observing").
   * Default: true. Opt out with `false` for tests or write-heavy paths
   * that manage attestation externally. See WIRE §2.3.
   */
  attest?: boolean;
  /**
   * Custos runtime version string embedded in attestations. Defaults to
   * the package.json version discovered at import time — override only
   * for testing.
   */
  custosVersion?: string;
}

export class Gate {
  public enforcement: Enforcement;
  public advisory: boolean;
  constructor(
    public policy: Policy,
    public ledger: Ledger,
    public actor: Actor,
    public server: Server,
    options: GateOptions = {},
  ) {
    this.advisory = options.advisory === true;
    if (options.enforcement) validateEnforcement(options.enforcement);
    this.enforcement = options.enforcement ?? {
      point: "sdk",
      effect: this.advisory ? "advisory" : "blocked",
    };
    if (options.snapshotPolicy !== false && typeof (policy as any).snapshotTo === "function") {
      try {
        (policy as any).snapshotTo(join(dirname(ledger.path), "policies"));
      } catch {
        // Snapshot failure must not block gate operation.
      }
    }
    if (options.attest !== false) {
      try {
        ledger.appendAttestation({
          reason: "startup",
          custosVersion: options.custosVersion ?? readCustosVersion(),
          policyHash: (policy as any).hash ?? "",
          activeActors: [actor.id],
        });
      } catch (err) {
        // Failure here MUST NOT be silent — that reproduces the exact
        // "you stopped observing" failure mode Custos exists to make
        // detectable. Warn once per Ledger class so operators wiring
        // up a third-party Ledger without appendAttestation see the
        // gap in coverage they've opted into.
        warnAttestOnce(ledger, err);
      }
    }
  }

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
    if (pd.decision !== "allow" && !this.advisory) {
      const rec = this.buildRecord(tool, args, undefined, pd.decision, pd.ruleId, pd.reason, 0, tid);
      this.ledger.append(rec);
      return { decision: pd.decision, rule: pd.ruleId, reason: pd.reason, record: rec, allowed: false };
    }
    const t0 = performance.now();
    try {
      const result = await fn(args);
      const latency = Math.round(performance.now() - t0);
      // Advisory mode: record the policy's decision (deny/error) but still
      // returned the executed result. The record accurately says "gate
      // had an opinion, action ran regardless."
      const recordedDecision: Decision =
        this.advisory && pd.decision !== "allow" ? pd.decision : "allow";
      const rec = this.buildRecord(tool, args, result, recordedDecision, pd.ruleId, pd.reason, latency, tid);
      this.ledger.append(rec);
      const token = this.maybeToken(rec, recordedDecision);
      return { decision: recordedDecision, rule: pd.ruleId, reason: pd.reason, record: rec, result, allowed: recordedDecision === "allow", token };
    } catch (e) {
      const latency = Math.round(performance.now() - t0);
      const err = e instanceof Error ? e.message : String(e);
      const reason = `tool error: ${err}`;
      const rec = this.buildRecord(tool, args, undefined, "error", pd.ruleId, reason, latency, tid);
      this.ledger.append(rec);
      return { decision: "error", rule: pd.ruleId, reason, record: rec, error: err, allowed: false };
    }
  }

  /**
   * Generate a per-call attestation token for ALLOW outcomes. Silent on
   * failure (missing key material, adapter that stores keys elsewhere) —
   * coverage attestation is opt-in on the tool side and the ledger already
   * records the decision.
   */
  private maybeToken(rec: DecisionRecord, decision: Decision): string | undefined {
    if (decision !== "allow") return undefined;
    const kp: any = (this.ledger as any).kp ?? (this.ledger as any).keypair;
    if (!kp || typeof kp.sign !== "function") return undefined;
    try {
      return generateToken(kp, rec.trace_id, rec.span_id, rec.tool, rec.args_hash, rec.ts);
    } catch {
      return undefined;
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
      policy: {
        engine: this.policy.engine,
        id: this.policy.id,
        rule,
        reason,
        ...(this.policy.hash ? { hash: this.policy.hash } : {}),
      },
      latency_ms: latencyMs,
      prev_hash: "",
      enforcement: this.enforcement,
    };
  }
}
