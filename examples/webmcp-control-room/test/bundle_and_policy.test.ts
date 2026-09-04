import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { createServer, Server } from "node:http";

import { verifyBundle } from "custos-mcp";

import { createApp } from "../server/server.js";

interface Fixture {
  base: string;
  server: Server;
  dir: string;
  app: ReturnType<typeof createApp>;
}
async function startFixture(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "custos-cr-bp-"));
  const app = createApp({ ledgerDir: dir });
  const server = createServer((req, res) => app.handler(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${addr.port}`, server, dir, app };
}
function stopFixture(f: Fixture) {
  return new Promise<void>((resolve) => {
    f.server.close(() => {
      rmSync(f.dir, { recursive: true, force: true });
      resolve();
    });
  });
}

let fx: Fixture;
beforeEach(async () => { fx = await startFixture(); });
afterEach(async () => { await stopFixture(fx); });

describe("GET /api/policy", () => {
  it("returns policy + per-tool classification with matched rules", async () => {
    const r = await fetch(`${fx.base}/api/policy`);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.policy.id).toBe("custos.webmcp.control-room");
    expect(Array.isArray(j.policy.rules)).toBe(true);

    // Sanity checks on the tool classifications.
    const prodDelete = j.tools.find(
      (t: any) => t.tool === "delete_environment" && t.environment === "production",
    );
    expect(prodDelete.risk).toBe("prohibited");
    expect(prodDelete.withoutApproval.decision).toBe("deny");
    // Even with approval, prod delete stays denied (belt-and-braces rule).
    expect(prodDelete.withApproval.decision).toBe("deny");

    const prodRollback = j.tools.find(
      (t: any) => t.tool === "rollback_service" && t.environment === "production",
    );
    expect(prodRollback.risk).toBe("high");
    expect(prodRollback.withoutApproval.decision).toBe("deny");
    expect(prodRollback.withApproval.decision).toBe("allow");
    expect(prodRollback.withApproval.ruleId).toBe("allow-high-approved");

    const stagingRestart = j.tools.find(
      (t: any) => t.tool === "restart_service" && t.environment === "staging",
    );
    expect(stagingRestart.withoutApproval.decision).toBe("allow");
  });
});

describe("GET /api/bundle", () => {
  it("produces a valid signed bundle that verifies with custos-mcp", async () => {
    // Generate some ledger content first.
    await fetch(`${fx.base}/api/tools/list_services`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: {} }),
    });
    await fetch(`${fx.base}/api/tools/delete_environment`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: { environment: "production" } }),
    });

    const r = await fetch(`${fx.base}/api/bundle`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/gzip");
    expect(r.headers.get("content-disposition")).toMatch(/attachment/);

    // Persist and verify via custos-mcp's public verifyBundle.
    const bytes = Buffer.from(await r.arrayBuffer());
    const tmp = join(fx.dir, "downloaded.tar.gz");
    writeFileSync(tmp, bytes);
    const verified = await verifyBundle(tmp);
    expect(verified.ok).toBe(true);
    expect(verified.records).toBeGreaterThanOrEqual(2);
    const manifest = (verified as any).manifest as any;
    expect(manifest.policies_hash).toMatch(/^sha256:/);
    expect(manifest.records).toBeGreaterThanOrEqual(2);
  });
});
