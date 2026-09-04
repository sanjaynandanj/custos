import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { URL } from "node:url";

const HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><title>Custos</title>
<style>
  body{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;margin:0;padding:24px;background:#0b0e14;color:#c5c8c6}
  h1{margin:0 0 16px;color:#ffb86c}
  .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px}
  .card{background:#151a23;border:1px solid #232a36;padding:16px;border-radius:8px}
  .card .n{font-size:28px;font-weight:600}
  .allow .n{color:#8be9fd}.deny .n{color:#ff5555}.error .n{color:#f1fa8c}
  table{width:100%;border-collapse:collapse;font-size:12px}
  th,td{padding:8px;border-bottom:1px solid #232a36;text-align:left}
  th{color:#6272a4;text-transform:uppercase;font-size:10px;letter-spacing:.05em}
  tr.allow td:nth-child(3){color:#8be9fd}tr.deny td:nth-child(3){color:#ff5555}tr.error td:nth-child(3){color:#f1fa8c}
  input,select,button{background:#0b0e14;color:#c5c8c6;border:1px solid #232a36;padding:6px 10px;border-radius:4px;font-family:inherit}
</style></head><body>
<h1>custos · governed MCP calls</h1>
<div class="stats" id="stats"></div>
<div><input id="tool" placeholder="filter by tool"/> <select id="decision"><option value="">all</option><option>allow</option><option>deny</option><option>error</option></select> <button onclick="load()">refresh</button></div>
<table><thead><tr><th>ts</th><th>tool</th><th>decision</th><th>actor</th><th>rule</th><th>reason</th><th>trace</th></tr></thead><tbody id="rows"></tbody></table>
<script>
async function load(){
  const s = await (await fetch('/api/stats')).json();
  document.getElementById('stats').innerHTML =
    '<div class="card"><div>total</div><div class="n">'+s.total+'</div></div>'+
    '<div class="card allow"><div>allow</div><div class="n">'+s.allow+'</div></div>'+
    '<div class="card deny"><div>deny</div><div class="n">'+s.deny+'</div></div>'+
    '<div class="card error"><div>error</div><div class="n">'+s.error+'</div></div>';
  const tool = document.getElementById('tool').value;
  const dec = document.getElementById('decision').value;
  const p = new URLSearchParams({limit:'200'});
  if(tool) p.set('tool', tool);
  if(dec) p.set('decision', dec);
  const rows = await (await fetch('/api/records?'+p)).json();
  document.getElementById('rows').innerHTML = rows.reverse().map(r =>
    '<tr class="'+r.decision+'"><td>'+r.ts+'</td><td>'+r.tool+'</td><td>'+r.decision+'</td><td>'+r.actor.id+'</td><td>'+(r.policy.rule||'—')+'</td><td>'+(r.policy.reason||'')+'</td><td>'+r.trace_id.slice(0,10)+'…</td></tr>'
  ).join('');
}
load(); setInterval(load, 5000);
</script></body></html>`;

function iterRecords(ledgerPath: string): any[] {
  if (!existsSync(ledgerPath)) return [];
  return readFileSync(ledgerPath, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

export function createHandler(
  ledgerPath: string,
  opts: { token?: string } = {},
): (req: IncomingMessage, res: ServerResponse) => void {
  // Resolve token from arg or env; empty string treated as "no token".
  const effectiveToken =
    (opts.token && opts.token.length > 0)
      ? opts.token
      : (process.env.CUSTOS_DASHBOARD_TOKEN && process.env.CUSTOS_DASHBOARD_TOKEN.length > 0
          ? process.env.CUSTOS_DASHBOARD_TOKEN
          : undefined);
  return (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://localhost`);
    // Bearer auth on /api/* only when a token is configured.
    if (effectiveToken !== undefined && url.pathname.startsWith("/api/")) {
      const auth = req.headers["authorization"] ?? "";
      if (auth !== `Bearer ${effectiveToken}`) {
        res.statusCode = 401;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ detail: "unauthorized" }));
        return;
      }
    }
    if (url.pathname === "/") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(HTML);
      return;
    }
    if (url.pathname === "/api/stats") {
      const recs = iterRecords(ledgerPath);
      const stats = { total: 0, allow: 0, deny: 0, error: 0, tools: {} as Record<string, number> };
      for (const r of recs) {
        stats.total++;
        if (r.decision === "allow") stats.allow++;
        else if (r.decision === "deny") stats.deny++;
        else stats.error++;
        stats.tools[r.tool] = (stats.tools[r.tool] ?? 0) + 1;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(stats));
      return;
    }
    if (url.pathname === "/api/records") {
      const tool = url.searchParams.get("tool");
      const dec = url.searchParams.get("decision");
      const limit = Math.min(1000, parseInt(url.searchParams.get("limit") ?? "100", 10));
      let recs = iterRecords(ledgerPath);
      if (tool) recs = recs.filter((r) => r.tool === tool);
      if (dec) recs = recs.filter((r) => r.decision === dec);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(recs.slice(-limit)));
      return;
    }
    if (url.pathname.startsWith("/api/trace/")) {
      const tid = url.pathname.slice("/api/trace/".length);
      const recs = iterRecords(ledgerPath).filter((r) => r.trace_id === tid);
      if (!recs.length) { res.statusCode = 404; res.end("not found"); return; }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(recs));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  };
}

export function serve(
  ledgerPath: string,
  opts: { host?: string; port?: number; token?: string } = {},
): Promise<void> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 8787;
  const handler = createHandler(ledgerPath, { token: opts.token });
  const server = createServer(handler);
  return new Promise<void>((resolve) => {
    server.listen(port, host, () => {
      console.log(`custos dashboard: http://${host}:${port}`);
      resolve();
    });
  });
}
