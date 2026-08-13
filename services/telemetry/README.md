# custos-telemetry

Cloudflare Worker + D1 that receives anonymous install/usage pings from the `custos-mcp` CLI (Node and Python).

## What it stores

One row per event: `{ ts, install_id, event, cli_version, os, runtime }`. Nothing else — no IPs, no User-Agents, no hostnames, no policy contents, no tool names, no ledger data.

Clients only send after opt-in (`custos init` prompt). See [../../packages/custos-js/src/telemetry.ts](../../packages/custos-js/src/telemetry.ts) and [../../packages/custos-py/src/custos/telemetry.py](../../packages/custos-py/src/custos/telemetry.py) for the exact payload.

## Deploy (one-time setup)

```bash
cd services/telemetry
npm install

# 1. Create the D1 database. Copy the returned database_id into wrangler.toml.
npx wrangler d1 create custos-telemetry

# 2. Apply the schema.
npm run db:apply:remote

# 3. (Optional) Set a token for the private /stats endpoint.
npx wrangler secret put STATS_TOKEN

# 4. Deploy the Worker.
npm run deploy
```

Once deployed, wire the URL into the client build/release:

```bash
# In the client (npm publish / pip release) set:
CUSTOS_TELEMETRY_URL=https://custos-telemetry.<your-account>.workers.dev
```

Or leave the env unset in OSS releases and set it only on your own build so no third party gets traffic they didn't opt into.

## Endpoints

- `POST /` — ingest one event. 204 on success (or on any silently-dropped invalid input).
- `GET  /stats?token=<STATS_TOKEN>` — aggregates for the traction curve.
- `GET  /healthz` — liveness.

## Local dev

```bash
npm run db:apply:local
npm run dev
curl -X POST http://localhost:8787/ \
  -H 'content-type: application/json' \
  -d '{"id":"11111111-1111-1111-1111-111111111111","event":"install","version":"0.1.0","os":"linux","node":"v20.10.0"}'
curl 'http://localhost:8787/stats?token=$STATS_TOKEN'
```
