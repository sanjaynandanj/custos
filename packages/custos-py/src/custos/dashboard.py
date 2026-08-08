"""FastAPI dashboard and REST API for the ledger.

Optional feature — install with `pip install custos-mcp[web]`.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

try:
    from fastapi import FastAPI, HTTPException, Query
    from fastapi.responses import HTMLResponse, JSONResponse
except ImportError as e:  # pragma: no cover
    raise ImportError(
        "custos.dashboard requires FastAPI; install with `pip install custos-mcp[web]`"
    ) from e


def create_app(ledger_path: str | Path) -> "FastAPI":
    ledger_path = Path(ledger_path)
    app = FastAPI(title="Custos Dashboard", version="0.1.0")

    def _iter_records():
        if not ledger_path.exists():
            return
        with ledger_path.open("rb") as f:
            for line in f:
                if not line.strip():
                    continue
                yield json.loads(line)

    @app.get("/api/stats")
    def stats():
        total = allow = deny = err = 0
        tools: dict = {}
        for r in _iter_records():
            total += 1
            d = r.get("decision")
            if d == "allow":
                allow += 1
            elif d == "deny":
                deny += 1
            else:
                err += 1
            tools[r["tool"]] = tools.get(r["tool"], 0) + 1
        return {"total": total, "allow": allow, "deny": deny, "error": err, "tools": tools}

    @app.get("/api/records")
    def records(limit: int = Query(100, ge=1, le=1000), tool: Optional[str] = None, decision: Optional[str] = None):
        out = []
        for r in _iter_records():
            if tool and r["tool"] != tool:
                continue
            if decision and r["decision"] != decision:
                continue
            out.append(r)
        # last N
        return out[-limit:]

    @app.get("/api/trace/{trace_id}")
    def trace(trace_id: str):
        out = [r for r in _iter_records() if r.get("trace_id") == trace_id]
        if not out:
            raise HTTPException(status_code=404, detail="trace not found")
        return out

    @app.get("/", response_class=HTMLResponse)
    def index():
        return _HTML

    return app


_HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Custos</title>
<style>
  body{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;margin:0;padding:24px;background:#0b0e14;color:#c5c8c6}
  h1{margin:0 0 16px;color:#ffb86c}
  .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px}
  .card{background:#151a23;border:1px solid #232a36;padding:16px;border-radius:8px}
  .card .n{font-size:28px;font-weight:600}
  .allow .n{color:#8be9fd}.deny .n{color:#ff5555}.error .n{color:#f1fa8c}
  table{width:100%;border-collapse:collapse;font-size:12px}
  th,td{padding:8px;border-bottom:1px solid #232a36;text-align:left;vertical-align:top}
  th{color:#6272a4;text-transform:uppercase;font-size:10px;letter-spacing:.05em}
  tr.allow td:nth-child(3){color:#8be9fd}tr.deny td:nth-child(3){color:#ff5555}tr.error td:nth-child(3){color:#f1fa8c}
  code{font-family:inherit}
  .filter{margin-bottom:12px}
  input,select{background:#0b0e14;color:#c5c8c6;border:1px solid #232a36;padding:6px 10px;border-radius:4px;font-family:inherit}
</style>
</head>
<body>
<h1>custos · governed MCP calls</h1>
<div class="stats" id="stats"></div>
<div class="filter">
  <input id="tool" placeholder="filter by tool"/>
  <select id="decision"><option value="">all decisions</option><option>allow</option><option>deny</option><option>error</option></select>
  <button onclick="load()">refresh</button>
</div>
<table><thead><tr><th>ts</th><th>tool</th><th>decision</th><th>actor</th><th>rule</th><th>reason</th><th>trace</th></tr></thead><tbody id="rows"></tbody></table>
<script>
async function load(){
  const s = await (await fetch('/api/stats')).json();
  document.getElementById('stats').innerHTML =
    `<div class="card"><div>total</div><div class="n">${s.total}</div></div>`+
    `<div class="card allow"><div>allow</div><div class="n">${s.allow}</div></div>`+
    `<div class="card deny"><div>deny</div><div class="n">${s.deny}</div></div>`+
    `<div class="card error"><div>error</div><div class="n">${s.error}</div></div>`;
  const tool = document.getElementById('tool').value;
  const decision = document.getElementById('decision').value;
  const params = new URLSearchParams({limit:200});
  if(tool) params.set('tool', tool);
  if(decision) params.set('decision', decision);
  const rows = await (await fetch('/api/records?'+params)).json();
  document.getElementById('rows').innerHTML = rows.reverse().map(r =>
    `<tr class="${r.decision}"><td>${r.ts}</td><td>${r.tool}</td><td>${r.decision}</td><td>${r.actor.id}</td><td>${r.policy.rule||'—'}</td><td>${r.policy.reason||''}</td><td><code>${r.trace_id.slice(0,10)}…</code></td></tr>`
  ).join('');
}
load(); setInterval(load, 5000);
</script>
</body></html>
"""
