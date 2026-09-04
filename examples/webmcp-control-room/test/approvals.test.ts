import { describe, it, expect } from "vitest";

import {
  ApprovalAlreadyResolved,
  ApprovalNotFound,
  ApprovalStore,
} from "../server/approvals.js";

function makeStore(now = () => 1000, ttl = 5_000) {
  const clock = { t: now() };
  const store = new ApprovalStore({ now: () => clock.t, ttlMs: ttl });
  return { store, clock };
}

describe("ApprovalStore", () => {
  it("creates pending approval bound to argsHash", () => {
    const { store } = makeStore();
    const req = store.create({
      toolName: "rollback_service",
      input: { service: "payment-service", environment: "production", version: "2.3.9" },
      risk: "high",
      environment: "production",
      service: "payment-service",
      reason: "prod rollback",
      traceId: "t-1",
    });
    expect(req.status).toBe("pending");
    expect(req.argsHash).toMatch(/^sha256:/);
  });

  it("approve → status=approved, single-use", () => {
    const { store } = makeStore();
    const r = store.create({
      toolName: "t", input: { a: 1 }, risk: "high", reason: "x", traceId: "t-2",
    });
    const approved = store.approve(r.approvalId);
    expect(approved.status).toBe("approved");
    expect(() => store.approve(r.approvalId)).toThrow(ApprovalAlreadyResolved);
    expect(() => store.deny(r.approvalId)).toThrow(ApprovalAlreadyResolved);
  });

  it("deny → status=denied", () => {
    const { store } = makeStore();
    const r = store.create({ toolName: "t", input: {}, risk: "high", reason: "x", traceId: "t-3" });
    expect(store.deny(r.approvalId).status).toBe("denied");
  });

  it("cancel is idempotent", () => {
    const { store } = makeStore();
    const r = store.create({ toolName: "t", input: {}, risk: "high", reason: "x", traceId: "t-4" });
    const first = store.cancel(r.approvalId)!;
    expect(first.status).toBe("cancelled");
    const second = store.cancel(r.approvalId)!;
    expect(second.status).toBe("cancelled");
  });

  it("expires after ttl", () => {
    const { store, clock } = makeStore(() => 0, 5_000);
    const r = store.create({ toolName: "t", input: {}, risk: "high", reason: "x", traceId: "t-5" });
    clock.t += 6_000;
    const fetched = store.get(r.approvalId)!;
    expect(fetched.status).toBe("expired");
    expect(() => store.approve(r.approvalId)).toThrow(ApprovalAlreadyResolved);
  });

  it("markExecuted transitions approved → executed", () => {
    const { store } = makeStore();
    const r = store.create({ toolName: "t", input: {}, risk: "high", reason: "x", traceId: "t-6" });
    store.approve(r.approvalId);
    store.markExecuted(r.approvalId, true);
    expect(store.get(r.approvalId)!.status).toBe("executed");
  });

  it("approve unknown id throws ApprovalNotFound", () => {
    const { store } = makeStore();
    expect(() => store.approve("nope")).toThrow(ApprovalNotFound);
  });

  it("cancelAll cancels only pending", () => {
    const { store } = makeStore();
    const a = store.create({ toolName: "t", input: {}, risk: "high", reason: "x", traceId: "t-7" });
    const b = store.create({ toolName: "t", input: { b: 1 }, risk: "high", reason: "x", traceId: "t-8" });
    store.approve(b.approvalId);
    store.cancelAll();
    expect(store.get(a.approvalId)!.status).toBe("cancelled");
    expect(store.get(b.approvalId)!.status).toBe("approved");
  });
});
