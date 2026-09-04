import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";

import { newTraceId } from "custos-mcp";

import { ApprovalStore } from "./approvals.js";
import { Domain } from "./domain.js";
import { createCustosStack, type CustosStack } from "./ledger.js";
import { Orchestrator } from "./orchestrator.js";
import { buildPolicy, POLICY_DEFINITION, policyAsYaml, classify } from "./policy.js";
import { TOOL_BY_NAME, TOOL_CATALOG, ValidationError, validateInput } from "./tools.js";
import type { Environment } from "./types.js";
import { ENVIRONMENTS } from "./types.js";

export interface AppOptions {
  ledgerDir: string;
  staticDir?: string;
  now?: () => number;
  approvalTtlMs?: number;
}

export interface App {
  domain: Domain;
  stack: CustosStack;
  approvals: ApprovalStore;
  orchestrator: Orchestrator;
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  reset(): void;
}

export function createApp(opts: AppOptions): App {
  const domain = new Domain();
  const policy = buildPolicy();
  const stack = createCustosStack({
    dir: opts.ledgerDir,
    policy,
    policyYaml: policyAsYaml(),
  });
  const approvals = new ApprovalStore({
    ttlMs: opts.approvalTtlMs,
    now: opts.now,
  });
  const orchestrator = new Orchestrator(domain, stack, approvals);

  function reset(): void {
    approvals.cancelAll("reset");
    stack.reset();
    domain.seed();
  }

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://x");
    const method = req.method ?? "GET";
    try {
      // CORS: same-origin in prod; permissive here so devs can point curl at it.
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("access-control-allow-headers", "content-type");
      res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      if (method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
      }

      if (method === "GET" && url.pathname === "/api/health") {
        return sendJson(res, 200, await healthPayload(stack));
      }
      if (method === "GET" && url.pathname === "/api/state") {
        return sendJson(res, 200, {
          services: domain.listServices(),
          envVars: domain.envVars,
        });
      }
      if (method === "GET" && url.pathname === "/api/tools") {
        return sendJson(res, 200, { tools: TOOL_CATALOG });
      }
      if (method === "POST" && url.pathname === "/api/reset") {
        reset();
        return sendJson(res, 200, { ok: true });
      }
      if (method === "POST" && url.pathname.startsWith("/api/tools/")) {
        const name = decodeURIComponent(url.pathname.slice("/api/tools/".length));
        return invokeTool(orchestrator, stack, name, req, res);
      }
      if (method === "GET" && url.pathname === "/api/approvals") {
        return sendJson(res, 200, { approvals: approvals.list() });
      }
      if (method === "GET" && url.pathname.startsWith("/api/approvals/")) {
        const id = decodeURIComponent(
          url.pathname.slice("/api/approvals/".length),
        );
        const req0 = approvals.get(id);
        if (!req0) return sendJson(res, 404, { error: "not_found" });
        return sendJson(res, 200, { approval: req0 });
      }
      if (
        method === "POST" &&
        /^\/api\/approvals\/[^/]+\/(approve|deny|cancel)$/.test(url.pathname)
      ) {
        return resolveApproval(orchestrator, approvals, stack, url.pathname, res);
      }
      if (method === "GET" && url.pathname === "/api/audit") {
        return sendJson(res, 200, buildAudit(stack));
      }
      if (method === "GET" && url.pathname === "/api/policy") {
        return sendJson(res, 200, buildPolicySnapshot());
      }
      if (method === "GET" && url.pathname === "/api/bundle") {
        return sendBundle(stack, res);
      }

      // Static files from the client bundle.
      if (opts.staticDir && (method === "GET" || method === "HEAD")) {
        if (serveStatic(opts.staticDir, url.pathname, res)) return;
      }

      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "not_found", path: url.pathname }));
    } catch (err) {
      console.error("[control-room] request error", err);
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: "server_error", message: msg });
    }
  };

  return { domain, stack, approvals, orchestrator, handler, reset };
}

async function invokeTool(
  orch: Orchestrator,
  stack: CustosStack,
  name: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!TOOL_BY_NAME.has(name)) {
    return sendJson(res, 404, {
      decision: "deny",
      rule: "custos.unknown_tool",
      reason: `unknown tool: ${name}`,
      traceId: newTraceId(),
    });
  }
  let body: any;
  try {
    body = await readJson(req);
  } catch (err) {
    return sendJson(res, 400, { error: "bad_json", message: String(err) });
  }
  const input = body?.input ?? {};
  try {
    validateInput(name, input);
  } catch (err) {
    if (err instanceof ValidationError) {
      return sendJson(res, 400, {
        decision: "deny",
        rule: "custos.schema",
        reason: err.message,
        traceId: newTraceId(),
      });
    }
    throw err;
  }
  const approvalId = typeof body?.approvalId === "string" ? body.approvalId : undefined;
  const traceId = typeof body?.traceId === "string" ? body.traceId : undefined;

  const outcome = await orch.invoke(name, input, { approvalId, traceId });

  // Persist approval events written by the invoke.
  // (Orchestrator already writes them via stack.appendApprovalEvent.)
  const status =
    outcome.decision === "approval"
      ? 202
      : outcome.decision === "allow"
        ? 200
        : 403;
  return sendJson(res, status, outcome);
}

async function resolveApproval(
  orch: Orchestrator,
  approvals: ApprovalStore,
  stack: CustosStack,
  pathname: string,
  res: ServerResponse,
): Promise<void> {
  const parts = pathname.split("/");
  const id = decodeURIComponent(parts[3] ?? "");
  const action = parts[4];
  const req = approvals.get(id);
  if (!req) return sendJson(res, 404, { error: "not_found" });
  try {
    let after;
    if (action === "approve") after = approvals.approve(id);
    else if (action === "deny") after = approvals.deny(id);
    else after = approvals.cancel(id) ?? req;
    // Write the operator lifecycle event to the correlated journal.
    for (const ev of approvals.events().filter((e) => e.approvalId === id)) {
      // best-effort append; the journal is idempotent per event line so
      // duplicates on retries are acceptable.
      stack.appendApprovalEvent(ev);
    }

    // NOTE: we intentionally do NOT run the second-pass Gate call here.
    // The invoker (agent or UI) is responsible for re-POSTing to
    // /api/tools/:name with the approvalId — that redemption is what
    // produces the signed execution record. This keeps the "no signed
    // record without an actual execution" property tight.
    return sendJson(res, 200, { approval: approvals.get(id) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return sendJson(res, 409, { error: "conflict", message: msg });
  }
}

function buildPolicySnapshot() {
  // For every tool × environment, run the classifier so the UI can show
  // exactly what would happen — including which policy rule matches.
  const policy = buildPolicy();
  const perTool: Array<{
    tool: string;
    environment: Environment | "(none)";
    risk: string;
    withoutApproval: { decision: string; ruleId: string; reason: string };
    withApproval: { decision: string; ruleId: string; reason: string };
  }> = [];
  for (const t of TOOL_CATALOG) {
    const envs: Array<Environment | "(none)"> =
      t.name === "delete_environment"
        ? [...ENVIRONMENTS]
        : ["development", "staging", "production"];
    if (t.name === "list_services") envs.push("(none)");
    for (const env of envs) {
      const input =
        env === "(none)"
          ? {}
          : { environment: env, service: "payment-service", version: "2.3.9", key: "k", value: "v" };
      const cls = classify({ tool: t.name, input });
      const enrich = (approved: boolean) =>
        policy.evaluate({
          tool: t.name,
          actor: { id: "a", kind: "k", meta: {} },
          server: { id: "s" },
          args: {
            risk: cls.risk,
            approved,
            ...(cls.environment !== undefined ? { environment: cls.environment } : {}),
            ...(cls.service !== undefined ? { service: cls.service } : {}),
          },
        });
      const without = enrich(false);
      const wapp = enrich(true);
      perTool.push({
        tool: t.name,
        environment: env,
        risk: cls.risk,
        withoutApproval: { decision: without.decision, ruleId: without.ruleId, reason: without.reason },
        withApproval: { decision: wapp.decision, ruleId: wapp.ruleId, reason: wapp.reason },
      });
    }
  }
  return {
    policy: POLICY_DEFINITION,
    tools: perTool,
  };
}

async function sendBundle(stack: CustosStack, res: ServerResponse): Promise<void> {
  const out = join(
    tmpdir(),
    `custos-webmcp-${Date.now().toString(36)}.tar.gz`,
  );
  try {
    await stack.buildEvidenceBundle(out);
    const bytes = readFileSync(out);
    const fname = `custos-webmcp-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz`;
    res.statusCode = 200;
    res.setHeader("content-type", "application/gzip");
    res.setHeader("content-length", String(bytes.length));
    res.setHeader("content-disposition", `attachment; filename="${fname}"`);
    res.end(bytes);
  } finally {
    try { rmSync(out, { force: true }); } catch { /* ignore */ }
  }
}

function buildAudit(stack: CustosStack) {
  const ledger: any[] = [];
  for (const rec of stack.ledger.iterRecords()) ledger.push(rec);
  const approvalEvents = stack.readApprovalEvents();
  return { ledger, approvalEvents };
}

async function healthPayload(stack: CustosStack) {
  let ledgerVerified = false;
  let records = 0;
  let error: string | null = null;
  try {
    const r = stack.verify();
    ledgerVerified = r.ok;
    records = r.records;
    if (!r.ok) error = r.error ?? null;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  return {
    ok: ledgerVerified,
    ledgerVerified,
    records,
    error,
    server: stack.server,
    ts: new Date().toISOString(),
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.from(c)));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

const STATIC_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".map": "application/json",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

function serveStatic(dir: string, pathname: string, res: ServerResponse): boolean {
  const safeDir = resolve(dir);
  const rel = pathname === "/" ? "/index.html" : pathname;
  const target = resolve(join(safeDir, "." + rel));
  if (!target.startsWith(safeDir)) return false;
  if (!existsSync(target)) {
    // SPA fallback for non-API paths
    if (pathname.startsWith("/api/")) return false;
    const fallback = join(safeDir, "index.html");
    if (!existsSync(fallback)) return false;
    const html = readFileSync(fallback);
    res.statusCode = 200;
    res.setHeader("content-type", STATIC_MIME[".html"]);
    res.end(html);
    return true;
  }
  const st = statSync(target);
  if (st.isDirectory()) return false;
  const ext = extname(target).toLowerCase();
  res.statusCode = 200;
  res.setHeader(
    "content-type",
    STATIC_MIME[ext] ?? "application/octet-stream",
  );
  res.end(readFileSync(target));
  return true;
}

export function startServer(app: App, port: number, host = "0.0.0.0") {
  const srv = createServer((req, res) => app.handler(req, res));
  return new Promise<{ close: () => Promise<void>; address: string }>((resolve, reject) => {
    srv.on("error", reject);
    srv.listen(port, host, () => {
      const addr = srv.address();
      const url =
        typeof addr === "string"
          ? addr
          : `http://${host}:${(addr && addr.port) ?? port}`;
      resolve({
        address: url,
        close: () =>
          new Promise<void>((r) => srv.close(() => r())),
      });
    });
  });
}
