import { describe, it, expect } from "vitest";

import { buildPolicy, classify } from "../server/policy.js";

describe("classifier", () => {
  it("reads are read", () => {
    for (const t of ["list_services", "get_service_health", "get_deployments", "query_logs"]) {
      expect(classify({ tool: t, input: { environment: "production" } }).risk).toBe("read");
    }
  });
  it("prod delete is prohibited", () => {
    expect(
      classify({ tool: "delete_environment", input: { environment: "production" } }).risk,
    ).toBe("prohibited");
  });
  it("prod rollback is high", () => {
    expect(
      classify({
        tool: "rollback_service",
        input: { service: "payment-service", environment: "production", version: "2.3.9" },
      }).risk,
    ).toBe("high");
  });
  it("dev restart is low", () => {
    expect(
      classify({
        tool: "restart_service",
        input: { service: "auth-service", environment: "development" },
      }).risk,
    ).toBe("low");
  });
});

describe("policy", () => {
  const policy = buildPolicy();
  function ctx(tool: string, args: Record<string, unknown>) {
    return { tool, actor: { id: "a", kind: "k", meta: {} }, server: { id: "s" }, args };
  }
  it("hard-deny prohibited", () => {
    const r = policy.evaluate(ctx("delete_environment", { risk: "prohibited", environment: "production" }));
    expect(r.decision).toBe("deny");
    expect(r.ruleId).toMatch(/prohibited|prod-delete/);
  });
  it("hard-deny prod delete even if risk reclassified", () => {
    const r = policy.evaluate(ctx("delete_environment", { risk: "high", environment: "production" }));
    expect(r.decision).toBe("deny");
  });
  it("allow read", () => {
    expect(policy.evaluate(ctx("list_services", { risk: "read" })).decision).toBe("allow");
  });
  it("allow low", () => {
    expect(policy.evaluate(ctx("restart_service", { risk: "low", environment: "development" })).decision).toBe("allow");
  });
  it("deny high without approval", () => {
    expect(policy.evaluate(ctx("rollback_service", { risk: "high", environment: "production" })).decision).toBe("deny");
  });
  it("allow high with approval", () => {
    expect(policy.evaluate(ctx("rollback_service", { risk: "high", environment: "production", approved: true })).decision).toBe("allow");
  });
});
