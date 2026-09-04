import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { createServer, Server } from "node:http";

import { createApp } from "../server/server.js";

interface Fixture {
  base: string;
  server: Server;
  app: ReturnType<typeof createApp>;
  dir: string;
}

async function startFixture(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "custos-cr-"));
  const app = createApp({ ledgerDir: dir });
  const server = createServer((req, res) => app.handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${addr.port}`;
  return { base, server, app, dir };
}
function stopFixture(f: Fixture) {
  return new Promise<void>((resolve) => {
    f.server.close(() => {
      rmSync(f.dir, { recursive: true, force: true });
      resolve();
    });
  });
}
async function invoke(base: string, tool: string, input: unknown, approvalId?: string) {
  const r = await fetch(`${base}/api/tools/${tool}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input, approvalId }),
  });
  return { status: r.status, body: await r.json() };
}

let fx: Fixture;
beforeEach(async () => { fx = await startFixture(); });
afterEach(async () => { await stopFixture(fx); });

describe("integration — read tools", () => {
  it("list_services returns all services when no env passed", async () => {
    const r = await invoke(fx.base, "list_services", {});
    expect(r.status).toBe(200);
    expect(r.body.decision).toBe("allow");
    expect(r.body.result.services.length).toBeGreaterThan(10);
  });
  it("list_services with unknown env is a schema deny", async () => {
    const r = await invoke(fx.base, "list_services", { environment: "prod" });
    expect(r.status).toBe(400);
    expect(r.body.decision).toBe("deny");
    expect(r.body.rule).toBe("custos.schema");
  });
  it("query_logs marks malicious content untrusted", async () => {
    const r = await invoke(fx.base, "query_logs", {
      service: "payment-service", environment: "production", limit: 50,
    });
    expect(r.status).toBe(200);
    const logs = r.body.result.logs;
    expect(logs.some((l: any) => l.untrusted && /SYSTEM OVERRIDE/i.test(l.message))).toBe(true);
  });
});

describe("integration — mutations & policy", () => {
  it("dev restart is auto-allowed and lands in the ledger", async () => {
    const r = await invoke(fx.base, "restart_service", {
      service: "notifications", environment: "staging",
    });
    expect(r.status).toBe(200);
    expect(r.body.decision).toBe("allow");
    const audit = await (await fetch(`${fx.base}/api/audit`)).json();
    const record = audit.ledger.find((x: any) => x.tool === "restart_service");
    expect(record).toBeTruthy();
    expect(record.decision).toBe("allow");
  });

  it("prod delete is hard-denied and does NOT execute", async () => {
    const before = await (await fetch(`${fx.base}/api/state`)).json();
    const r = await invoke(fx.base, "delete_environment", { environment: "production" });
    expect(r.status).toBe(403);
    expect(r.body.decision).toBe("deny");
    const after = await (await fetch(`${fx.base}/api/state`)).json();
    // Same number of prod services before and after.
    const prodBefore = before.services.filter((s: any) => s.env === "production").length;
    const prodAfter = after.services.filter((s: any) => s.env === "production").length;
    expect(prodBefore).toBe(prodAfter);
  });

  it("prod rollback returns approval WITHOUT touching the domain", async () => {
    const svcBefore = await (await fetch(`${fx.base}/api/state`)).json();
    const paymentBefore = svcBefore.services.find(
      (s: any) => s.name === "payment-service" && s.env === "production",
    );
    expect(paymentBefore.status).toBe("degraded");

    const r = await invoke(fx.base, "rollback_service", {
      service: "payment-service", environment: "production", version: "2.3.9",
    });
    expect(r.status).toBe(202);
    expect(r.body.decision).toBe("approval");
    expect(r.body.approvalId).toBeTruthy();

    const svcAfter = await (await fetch(`${fx.base}/api/state`)).json();
    const paymentAfter = svcAfter.services.find(
      (s: any) => s.name === "payment-service" && s.env === "production",
    );
    // Domain untouched.
    expect(paymentAfter.status).toBe("degraded");
    expect(paymentAfter.version).toBe("2.4.1");
  });

  it("approve → invoker redeems → executes exactly once and heals the service", async () => {
    const args = {
      service: "payment-service", environment: "production", version: "2.3.9",
    };
    const created = await invoke(fx.base, "rollback_service", args);
    const id = created.body.approvalId;
    const okResp = await fetch(`${fx.base}/api/approvals/${id}/approve`, { method: "POST" });
    expect(okResp.status).toBe(200);
    // The invoker redeems the approval to trigger the signed execution.
    const redemption = await invoke(fx.base, "rollback_service", args, id);
    expect(redemption.body.decision).toBe("allow");

    const svc = await (await fetch(`${fx.base}/api/state`)).json();
    const payment = svc.services.find(
      (s: any) => s.name === "payment-service" && s.env === "production",
    );
    expect(payment.version).toBe("2.3.9");
    expect(payment.status).toBe("healthy");

    // Second redemption is denied: approval already used.
    const second = await invoke(fx.base, "rollback_service", args, id);
    expect(second.body.decision).toBe("deny");
    expect(second.body.rule).toBe("custos.approval.already_used");

    // Replaying approve on the same id is a 409.
    const replay = await fetch(`${fx.base}/api/approvals/${id}/approve`, { method: "POST" });
    expect(replay.status).toBe(409);
  });

  it("deny → no execution, ledger has no rollback record for that trace", async () => {
    const created = await invoke(fx.base, "rollback_service", {
      service: "payment-service", environment: "production", version: "2.3.9",
    });
    const id = created.body.approvalId;
    const traceId = created.body.traceId;
    const denyResp = await fetch(`${fx.base}/api/approvals/${id}/deny`, { method: "POST" });
    expect(denyResp.status).toBe(200);
    const svc = await (await fetch(`${fx.base}/api/state`)).json();
    const payment = svc.services.find(
      (s: any) => s.name === "payment-service" && s.env === "production",
    );
    expect(payment.status).toBe("degraded");
    const audit = await (await fetch(`${fx.base}/api/audit`)).json();
    const executed = audit.ledger.find(
      (r: any) =>
        r.tool === "rollback_service" &&
        r.trace_id === traceId &&
        r.decision === "allow",
    );
    expect(executed).toBeUndefined();
  });

  it("argument substitution after approval is rejected", async () => {
    // Create approval for payment-service.
    const created = await invoke(fx.base, "rollback_service", {
      service: "payment-service", environment: "production", version: "2.3.9",
    });
    const id = created.body.approvalId;
    await fetch(`${fx.base}/api/approvals/${id}/approve`, { method: "POST" });
    // Attempt to redeem the same approval id with different args.
    const swap = await invoke(
      fx.base,
      "rollback_service",
      { service: "auth-service", environment: "production", version: "2.3.9" },
      id,
    );
    expect(swap.body.decision).toBe("deny");
    expect(swap.body.rule).toBe("custos.approval.args_mismatch");
    // auth-service should not have been rolled back.
    const svc = await (await fetch(`${fx.base}/api/state`)).json();
    const auth = svc.services.find(
      (s: any) => s.name === "auth-service" && s.env === "production",
    );
    expect(auth.version).toBe("2.4.1");
  });

  it("reset while approval pending → approval becomes cancelled", async () => {
    const created = await invoke(fx.base, "rollback_service", {
      service: "payment-service", environment: "production", version: "2.3.9",
    });
    const id = created.body.approvalId;
    await fetch(`${fx.base}/api/reset`, { method: "POST" });
    const req = await (await fetch(`${fx.base}/api/approvals/${id}`)).json();
    expect(req.approval.status).toBe("cancelled");
  });

  it("audit merges signed ledger + control events under same trace", async () => {
    const args = {
      service: "payment-service", environment: "production", version: "2.3.9",
    };
    const created = await invoke(fx.base, "rollback_service", args);
    const id = created.body.approvalId;
    const traceId = created.body.traceId;
    await fetch(`${fx.base}/api/approvals/${id}/approve`, { method: "POST" });
    // Redeem to trigger signed execution.
    await invoke(fx.base, "rollback_service", args, id);
    const audit = await (await fetch(`${fx.base}/api/audit`)).json();
    const events = audit.approvalEvents.filter((e: any) => e.traceId === traceId);
    const record = audit.ledger.find((r: any) => r.trace_id === traceId && r.decision === "allow");
    expect(events.length).toBeGreaterThan(0);
    expect(record).toBeTruthy();
  });

  it("health verifies ledger", async () => {
    await invoke(fx.base, "list_services", {});
    const h = await (await fetch(`${fx.base}/api/health`)).json();
    expect(h.ledgerVerified).toBe(true);
  });

  it("concurrent approvals do not resolve each other", async () => {
    const [a, b] = await Promise.all([
      invoke(fx.base, "rollback_service", {
        service: "payment-service", environment: "production", version: "2.3.9",
      }),
      invoke(fx.base, "restart_service", {
        service: "auth-service", environment: "production",
      }),
    ]);
    expect(a.body.approvalId).not.toBe(b.body.approvalId);
    // Approve only A.
    await fetch(`${fx.base}/api/approvals/${a.body.approvalId}/approve`, { method: "POST" });
    const bReq = await (await fetch(`${fx.base}/api/approvals/${b.body.approvalId}`)).json();
    expect(bReq.approval.status).toBe("pending");
  });
});
