import { describe, it, expect, afterEach } from "vitest";
import { createServer, Server } from "node:http";
import { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHandler } from "../src/dashboard.js";

function emptyLedger(): string {
  const dir = mkdtempSync(join(tmpdir(), "custos-dash-"));
  const p = join(dir, "ledger.jsonl");
  writeFileSync(p, "");
  return p;
}

function listen(handler: (req: any, res: any) => void): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

async function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("dashboard bearer-token auth", () => {
  let running: Server | undefined;

  afterEach(async () => {
    if (running) {
      await close(running);
      running = undefined;
    }
    // Clean env between tests so we do not leak state.
    delete process.env.CUSTOS_DASHBOARD_TOKEN;
  });

  it("without token config, /api/* is open (backwards compat)", async () => {
    const { server, url } = await listen(createHandler(emptyLedger()));
    running = server;
    const r = await fetch(`${url}/api/stats`);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.total).toBe(0);
  });

  it("with token config, missing header → 401", async () => {
    const { server, url } = await listen(createHandler(emptyLedger(), { token: "s3cret" }));
    running = server;
    const r = await fetch(`${url}/api/stats`);
    expect(r.status).toBe(401);
  });

  it("with token config, wrong header → 401", async () => {
    const { server, url } = await listen(createHandler(emptyLedger(), { token: "s3cret" }));
    running = server;
    const r = await fetch(`${url}/api/stats`, { headers: { Authorization: "Bearer nope" } });
    expect(r.status).toBe(401);
  });

  it("with token config, correct header → 200", async () => {
    const { server, url } = await listen(createHandler(emptyLedger(), { token: "s3cret" }));
    running = server;
    const r = await fetch(`${url}/api/stats`, { headers: { Authorization: "Bearer s3cret" } });
    expect(r.status).toBe(200);
  });

  it("HTML index never requires auth", async () => {
    const { server, url } = await listen(createHandler(emptyLedger(), { token: "s3cret" }));
    running = server;
    const r = await fetch(`${url}/`);
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text.toLowerCase()).toContain("custos");
  });

  it("CUSTOS_DASHBOARD_TOKEN env var enables auth", async () => {
    process.env.CUSTOS_DASHBOARD_TOKEN = "envtok";
    const { server, url } = await listen(createHandler(emptyLedger()));
    running = server;
    const bad = await fetch(`${url}/api/stats`);
    expect(bad.status).toBe(401);
    const good = await fetch(`${url}/api/stats`, { headers: { Authorization: "Bearer envtok" } });
    expect(good.status).toBe(200);
  });
});
