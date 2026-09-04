/**
 * Happy-path E2E — the same story the demo tells. Uses the WebMCP adapter
 * (bundled from custos-mcp) against a live backend so the adapter's
 * decide/execute/wait/unregister flow is fully exercised, without a browser.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { createServer, Server } from "node:http";

import {
  registerCustosWebTools,
  type CustosOutcome,
  type ModelContext,
  type ModelContextTool,
} from "custos-mcp/adapters/webmcp";

import { createApp } from "../server/server.js";
import { TOOL_CATALOG } from "../server/tools.js";

class FakeModelContext implements ModelContext {
  tools = new Map<string, ModelContextTool>();
  registerTool(t: ModelContextTool) {
    this.tools.set(t.name, t);
    return { unregister: () => this.tools.delete(t.name) };
  }
}

let server: Server;
let base: string;
let dir: string;
const mc = new FakeModelContext();

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "custos-e2e-"));
  const app = createApp({ ledgerDir: dir });
  server = createServer((req, res) => app.handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;

  registerCustosWebTools(
    mc,
    TOOL_CATALOG.map((t) => ({
      ...t,
      decide: async (input, ctx): Promise<CustosOutcome> => {
        const r = await fetch(`${base}/api/tools/${t.name}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input }),
          signal: ctx.signal,
        });
        const outcome = (await r.json()) as CustosOutcome;
        if (outcome.decision !== "approval") return outcome;
        const approvalId = outcome.approvalId;
        return {
          ...outcome,
          wait: async () => {
            while (true) {
              const rr = await fetch(`${base}/api/approvals/${approvalId}`);
              const j = await rr.json();
              const req = j.approval;
              if (req.status === "approved" || req.status === "executed") {
                const rrr = await fetch(`${base}/api/tools/${t.name}`, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ input, approvalId }),
                });
                return (await rrr.json()) as CustosOutcome;
              }
              if (req.status === "denied" || req.status === "cancelled" || req.status === "expired") {
                return {
                  decision: "deny",
                  rule: `custos.approval.${req.status}`,
                  reason: `approval ${req.status}`,
                  traceId: outcome.traceId,
                };
              }
              await new Promise((r) => setTimeout(r, 25));
            }
          },
        };
      },
    })),
  );
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

async function invoke(name: string, input: unknown): Promise<unknown> {
  const tool = mc.tools.get(name)!;
  return tool.execute(input, {});
}

describe("E2E happy path — full demo story", () => {
  it("agent investigates, requests prod rollback, human approves, service heals, deny hard-fails", async () => {
    // 1. list services (allow)
    const services = (await invoke("list_services", { environment: "production" })) as any;
    expect(services.services.length).toBe(5);

    // 2. inspect payment health (allow)
    const health = (await invoke("get_service_health", {
      service: "payment-service", environment: "production",
    })) as any;
    expect(health.service.status).toBe("degraded");

    // 3. query logs (allow, untrusted content present)
    const logs = (await invoke("query_logs", {
      service: "payment-service", environment: "production", limit: 50,
    })) as any;
    expect(logs.logs.some((l: any) => l.untrusted)).toBe(true);

    // 4. deployments (allow)
    const deps = (await invoke("get_deployments", {
      service: "payment-service", environment: "production",
    })) as any;
    expect(deps.deployments.some((d: any) => d.version === "2.3.9")).toBe(true);

    // 5. production rollback → approval; approve out-of-band
    const rollbackPromise = invoke("rollback_service", {
      service: "payment-service", environment: "production", version: "2.3.9",
    });

    // Wait briefly for the approval to be created, then approve.
    let approvalId = "";
    while (!approvalId) {
      await new Promise((r) => setTimeout(r, 15));
      const rr = await fetch(`${base}/api/approvals`);
      const j = await rr.json();
      const pending = j.approvals.find((a: any) => a.status === "pending");
      if (pending) approvalId = pending.approvalId;
    }
    await fetch(`${base}/api/approvals/${approvalId}/approve`, { method: "POST" });

    const rollbackResult = (await rollbackPromise) as any;
    expect(rollbackResult.service?.version ?? rollbackResult.result?.service?.version).toBeDefined();
    // Result may be either the underlying domain payload or the raw allow envelope.
    const svc = rollbackResult.service ?? rollbackResult.result?.service;
    expect(svc.version).toBe("2.3.9");
    expect(svc.status).toBe("healthy");

    // 6. restart notifications in staging → auto-allow
    const restart = (await invoke("restart_service", {
      service: "notifications", environment: "staging",
    })) as any;
    const restartSvc = restart.service ?? restart.result?.service;
    expect(restartSvc.status).toBe("healthy");

    // 7. delete production → hard deny (MCP-shaped error result)
    const del = (await invoke("delete_environment", { environment: "production" })) as any;
    expect(del.isError).toBe(true);
    expect(del.content[0].text.toLowerCase()).toContain("custos denied");
    expect(del.content[0].text.toLowerCase()).toContain("production");

    // 8. audit contains signed ledger records for allowed calls
    const audit = await (await fetch(`${base}/api/audit`)).json();
    expect(audit.ledger.some((r: any) => r.tool === "rollback_service" && r.decision === "allow")).toBe(true);
    expect(audit.ledger.some((r: any) => r.tool === "delete_environment" && r.decision === "deny")).toBe(true);

    // 9. ledger integrity verified
    const h = await (await fetch(`${base}/api/health`)).json();
    expect(h.ledgerVerified).toBe(true);
  }, 30_000);
});
