// Custos telemetry receiver.
//
// POST /            -> ingest one event
// GET  /stats       -> aggregates for the traction curve
// GET  /healthz     -> 200 ok
//
// We deliberately do not read the client IP, User-Agent, or any Cloudflare
// request metadata beyond what is required to reject malformed input.

export interface Env {
  DB: D1Database;
  ALLOWED_EVENTS: string;
  PUBLIC_STATS: string;
  STATS_TOKEN?: string;
}

const MAX_BODY_BYTES = 1024;
const MAX_FIELD_LEN = 128;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST,GET,OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === "/healthz") return json({ ok: true });

    if (req.method === "POST" && (url.pathname === "/" || url.pathname === "/e")) {
      return ingest(req, env);
    }

    if (req.method === "GET" && url.pathname === "/stats") {
      return stats(req, env, url);
    }

    return json({ error: "not found" }, 404);
  },
};

async function ingest(req: Request, env: Env): Promise<Response> {
  const cl = req.headers.get("content-length");
  if (cl && parseInt(cl, 10) > MAX_BODY_BYTES) return json({ error: "too large" }, 413);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }

  const e = validate(body, env);
  if (!e) return new Response(null, { status: 204, headers: CORS });

  await env.DB
    .prepare(
      "INSERT INTO events (ts, install_id, event, cli_version, os, runtime) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(new Date().toISOString(), e.id, e.event, e.version, e.os, e.runtime)
    .run();

  return new Response(null, { status: 204, headers: CORS });
}

export interface ValidEvent {
  id: string;
  event: string;
  version: string;
  os: string;
  runtime: string;
}

export function validate(body: unknown, env: Pick<Env, "ALLOWED_EVENTS">): ValidEvent | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;

  const id = str(b.id);
  const event = str(b.event);
  const version = str(b.version);
  const os = str(b.os);
  // Clients send either `node` or `python`; normalize.
  const runtime =
    str(b.node) ? `node ${str(b.node)}` :
    str(b.python) ? `python ${str(b.python)}` :
    str(b.runtime);

  if (!id || !event || !version || !os || !runtime) return null;

  const allowed = env.ALLOWED_EVENTS.split(",").map((s) => s.trim());
  if (!allowed.includes(event)) return null;

  // Rough uuid shape check; we do not require a canonical UUID.
  if (id.length < 8 || id.length > 64) return null;

  return { id, event, version, os, runtime };
}

function str(v: unknown): string {
  if (typeof v !== "string") return "";
  const s = v.trim();
  if (!s || s.length > MAX_FIELD_LEN) return "";
  return s;
}

async function stats(req: Request, env: Env, url: URL): Promise<Response> {
  if (env.PUBLIC_STATS !== "1") {
    const token = url.searchParams.get("token");
    if (!env.STATS_TOKEN || token !== env.STATS_TOKEN) return json({ error: "unauthorized" }, 401);
  }

  const totalInstalls = await env.DB
    .prepare("SELECT COUNT(DISTINCT install_id) AS n FROM events WHERE event = 'install'")
    .first<{ n: number }>();

  const weeklyActives = await env.DB
    .prepare("SELECT COUNT(DISTINCT install_id) AS n FROM events WHERE ts >= datetime('now', '-7 days')")
    .first<{ n: number }>();

  const byEvent = await env.DB
    .prepare("SELECT event, COUNT(*) AS n FROM events GROUP BY event ORDER BY n DESC")
    .all<{ event: string; n: number }>();

  const dailyInstalls = await env.DB
    .prepare(`
      SELECT substr(ts, 1, 10) AS day, COUNT(DISTINCT install_id) AS n
      FROM events WHERE event = 'install'
      GROUP BY day ORDER BY day DESC LIMIT 90
    `)
    .all<{ day: string; n: number }>();

  return json({
    totalInstalls: totalInstalls?.n ?? 0,
    weeklyActives: weeklyActives?.n ?? 0,
    byEvent: byEvent.results,
    dailyInstalls: dailyInstalls.results,
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS },
  });
}
