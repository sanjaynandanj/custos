import { describe, it, expect } from "vitest";

import { Domain } from "../server/domain.js";

describe("domain", () => {
  it("seeds the payment-service prod incident", () => {
    const d = new Domain();
    const svc = d.getService("payment-service", "production")!;
    expect(svc.status).toBe("degraded");
    expect(svc.version).toBe("2.4.1");
    const deps = d.listDeployments("payment-service", "production");
    expect(deps.some((x) => x.version === "2.3.9" && x.status === "healthy")).toBe(true);
  });

  it("rollback to 2.3.9 restores payment-service", () => {
    const d = new Domain();
    const svc = d.rollbackService("payment-service", "production", "2.3.9");
    expect(svc.version).toBe("2.3.9");
    expect(svc.status).toBe("healthy");
    expect(svc.errorRate).toBeLessThan(0.05);
  });

  it("logs include one untrusted line", () => {
    const d = new Domain();
    const logs = d.listLogs("payment-service", "production", undefined, 100);
    expect(logs.some((l) => l.untrusted)).toBe(true);
  });

  it("delete of production is refused at the domain layer", () => {
    const d = new Domain();
    expect(() => d.deleteEnvironment("production")).toThrow(/production/);
  });

  it("seed() is deterministic", () => {
    const d = new Domain();
    d.rollbackService("payment-service", "production", "2.3.9");
    d.setEnvVar("payment-service", "development", "FOO", "BAR");
    d.seed();
    const svc = d.getService("payment-service", "production")!;
    expect(svc.version).toBe("2.4.1");
    expect(svc.status).toBe("degraded");
    expect(d.envVars.find((e) => e.key === "FOO")).toBeUndefined();
  });
});
