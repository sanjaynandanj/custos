import { createServer } from "node:http";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { Gate, Ledger, generateKeypair, loadPolicy, newActor, verifyLedger } from "custos-mcp";
import { createAuthenticator } from "./auth.js";
import { planAction } from "./planner.js";
import { DEMO_POLICY } from "./policy.js";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "../public");
const port = Number(process.env.PORT || 8080);
const config = {
  clientId: process.env.GOOGLE_CLIENT_ID || "",
  projectId: process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || "",
  location: process.env.VERTEX_LOCATION || "us-central1",
  model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
};
const authenticate = config.clientId ? createAuthenticator(config.clientId) : null;
const sessions = new Map();

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32_768) throw new Error("Request is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function sessionFor(user) {
  if (sessions.has(user.id)) return sessions.get(user.id);
  const safeId = createHash("sha256").update(user.id).digest("hex").slice(0, 20);
  const dir = join("/tmp/custos-ideathon", safeId);
  mkdirSync(dir, { recursive: true });
  const kp = generateKeypair();
  const ledgerPath = join(dir, "ledger.jsonl");
  const ledger = new Ledger(ledgerPath, kp);
  const gate = new Gate(loadPolicy(DEMO_POLICY), ledger, newActor(`google:${safeId}`), { id: "ideathon-tools", pubkey: kp.publicB64() });
  const session = { gate, ledgerPath, publicKey: kp.publicB64() };
  sessions.set(user.id, session);
  return session;
}

async function handler(req, res) {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });
  if (req.method === "GET" && url.pathname === "/api/config") {
    return send(res, 200, { googleClientId: config.clientId, ready: Boolean(config.clientId && config.projectId) });
  }
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/app.js" || url.pathname === "/styles.css")) {
    const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const types = { "index.html": "text/html", "app.js": "text/javascript", "styles.css": "text/css" };
    return send(res, 200, readFileSync(join(publicDir, name), "utf8"), types[name]);
  }
  if (req.method === "POST" && url.pathname === "/api/evaluate") {
    if (!authenticate) return send(res, 503, { error: "Google sign-in is not configured" });
    try {
      const user = await authenticate(req);
      const { intent } = await readJson(req);
      if (typeof intent !== "string" || intent.trim().length < 3 || intent.length > 500) throw new Error("Enter an intent between 3 and 500 characters");
      const plan = await planAction(intent.trim(), config);
      const session = sessionFor(user);
      const result = await session.gate.call(plan.tool, plan.args, async () => ({ simulated: true, message: "Tool execution simulated safely for the public demo" }));
      const verification = verifyLedger(session.ledgerPath, session.ledgerPath.replace(/\.jsonl$/, ".pub"));
      return send(res, 200, {
        user: { name: user.name },
        plan,
        decision: result.decision,
        rule: result.rule || "default-deny",
        reason: result.reason,
        receipt: { sequence: result.record.seq, hash: result.record.record_hash, signature: result.record.sig, previousHash: result.record.prev_hash, publicKey: session.publicKey },
        ledger: { verified: verification.ok, records: verification.records },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Request failed";
      const authError = /sign in|token|account/i.test(message);
      return send(res, authError ? 401 : 400, { error: message });
    }
  }
  return send(res, 404, { error: "Not found" });
}

createServer((req, res) => handler(req, res).catch((error) => send(res, 500, { error: error.message }))).listen(port, "0.0.0.0", () => {
  console.log(`Custos Ideathon app listening on :${port}`);
});
