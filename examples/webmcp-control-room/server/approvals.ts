import { hashOfValue } from "custos-mcp";

import type { Environment, Risk } from "./types.js";

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "denied"
  | "cancelled"
  | "expired"
  | "executed"
  | "failed";

export interface ApprovalRequest {
  approvalId: string;
  toolName: string;
  input: unknown;
  argsHash: string;
  risk: Risk;
  environment?: Environment;
  service?: string;
  reason: string;
  createdAt: number;
  expiresAt: number;
  status: ApprovalStatus;
  traceId: string;
  verdict?: "approve" | "deny";
  decidedAt?: number;
}

export interface ApprovalEvent {
  ts: number;
  approvalId: string;
  traceId: string;
  toolName: string;
  status: ApprovalStatus;
  actor: "system" | "operator" | "agent";
  detail?: string;
}

export class ApprovalStore {
  private byId = new Map<string, ApprovalRequest>();
  private _events: ApprovalEvent[] = [];
  private counter = 0;
  private nowFn: () => number;
  public ttlMs: number;
  private listeners = new Set<(id: string) => void>();

  constructor(opts: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? 5 * 60 * 1000;
    this.nowFn = opts.now ?? (() => Date.now());
  }

  create(input: {
    toolName: string;
    input: unknown;
    risk: Risk;
    environment?: Environment;
    service?: string;
    reason: string;
    traceId: string;
  }): ApprovalRequest {
    this.counter += 1;
    const id = `ap-${Date.now().toString(36)}-${this.counter}`;
    const now = this.nowFn();
    const req: ApprovalRequest = {
      approvalId: id,
      toolName: input.toolName,
      input: input.input,
      argsHash: hashOfValue(input.input),
      risk: input.risk,
      environment: input.environment,
      service: input.service,
      reason: input.reason,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      status: "pending",
      traceId: input.traceId,
    };
    this.byId.set(id, req);
    this.emitEvent({
      ts: now,
      approvalId: id,
      traceId: input.traceId,
      toolName: input.toolName,
      status: "pending",
      actor: "system",
      detail: "approval requested",
    });
    return { ...req };
  }

  get(id: string): ApprovalRequest | undefined {
    const req = this.byId.get(id);
    if (!req) return undefined;
    this.maybeExpire(req);
    return { ...req };
  }

  list(): ApprovalRequest[] {
    return [...this.byId.values()]
      .map((r) => {
        this.maybeExpire(r);
        return { ...r };
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  approve(id: string): ApprovalRequest {
    return this.decide(id, "approve");
  }
  deny(id: string): ApprovalRequest {
    return this.decide(id, "deny");
  }

  cancel(id: string, detail = "cancelled"): ApprovalRequest | undefined {
    const req = this.byId.get(id);
    if (!req) return undefined;
    if (req.status !== "pending") return { ...req };
    req.status = "cancelled";
    req.decidedAt = this.nowFn();
    this.emitEvent({
      ts: req.decidedAt,
      approvalId: id,
      traceId: req.traceId,
      toolName: req.toolName,
      status: "cancelled",
      actor: "system",
      detail,
    });
    this.notify(id);
    return { ...req };
  }

  /**
   * Cancel every pending approval. Used by `reset`.
   */
  cancelAll(detail = "reset"): void {
    for (const req of this.byId.values()) {
      if (req.status === "pending") this.cancel(req.approvalId, detail);
    }
  }

  /**
   * Mark an approval as executed / failed once the second-pass Gate call
   * finishes. Called by the routes after `Gate.call`.
   */
  markExecuted(id: string, ok: boolean, detail?: string): void {
    const req = this.byId.get(id);
    if (!req) return;
    const status: ApprovalStatus = ok ? "executed" : "failed";
    req.status = status;
    this.emitEvent({
      ts: this.nowFn(),
      approvalId: id,
      traceId: req.traceId,
      toolName: req.toolName,
      status,
      actor: "system",
      detail,
    });
  }

  events(): ApprovalEvent[] {
    return [...this._events];
  }

  /**
   * Register a listener called whenever an approval transitions to a terminal
   * status. Used by the HTTP long-poll endpoint.
   */
  onChange(fn: (id: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ---- internal ----

  private decide(id: string, verdict: "approve" | "deny"): ApprovalRequest {
    const req = this.byId.get(id);
    if (!req) throw new ApprovalNotFound(id);
    this.maybeExpire(req);
    if (req.status !== "pending") {
      throw new ApprovalAlreadyResolved(id, req.status);
    }
    req.status = verdict === "approve" ? "approved" : "denied";
    req.verdict = verdict;
    req.decidedAt = this.nowFn();
    this.emitEvent({
      ts: req.decidedAt,
      approvalId: id,
      traceId: req.traceId,
      toolName: req.toolName,
      status: req.status,
      actor: "operator",
      detail: `operator ${verdict === "approve" ? "approved" : "denied"}`,
    });
    this.notify(id);
    return { ...req };
  }

  private maybeExpire(req: ApprovalRequest): void {
    if (req.status !== "pending") return;
    if (this.nowFn() >= req.expiresAt) {
      req.status = "expired";
      req.decidedAt = this.nowFn();
      this.emitEvent({
        ts: req.decidedAt,
        approvalId: req.approvalId,
        traceId: req.traceId,
        toolName: req.toolName,
        status: "expired",
        actor: "system",
        detail: "approval expired",
      });
      this.notify(req.approvalId);
    }
  }

  private emitEvent(ev: ApprovalEvent): void {
    this._events.push(ev);
  }

  private notify(id: string): void {
    for (const fn of this.listeners) {
      try {
        fn(id);
      } catch {
        /* ignore */
      }
    }
  }
}

export class ApprovalNotFound extends Error {
  constructor(public approvalId: string) {
    super(`approval not found: ${approvalId}`);
    this.name = "ApprovalNotFound";
  }
}
export class ApprovalAlreadyResolved extends Error {
  constructor(public approvalId: string, public status: ApprovalStatus) {
    super(`approval ${approvalId} already resolved (${status})`);
    this.name = "ApprovalAlreadyResolved";
  }
}
