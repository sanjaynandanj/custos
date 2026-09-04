#!/usr/bin/env node
import { generateKeypair, loadKeypair } from "./keys.js";
import { Ledger } from "./ledger.js";
import { loadPolicy } from "./policy.js";
import { newActor } from "./record.js";
import { replayLedger, verifyCoverage, verifyLedger } from "./verify.js";
import { createBundle, verifyBundle } from "./bundle.js";
import { runInit } from "./init.js";
import { runDemo } from "./demo.js";
import { emit, promptConsent } from "./telemetry.js";

const argv = process.argv.slice(2);
const cmd = argv.shift();

function opt(name: string, def?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return def;
}

function flag(name: string): boolean {
  return argv.includes(`--${name}`);
}

async function readVersion(): Promise<string> {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
  return pkg.version as string;
}

async function main() {
  switch (cmd) {
    case "init": {
      const dir = opt("dir", "./.custos");
      const force = flag("force");
      const yes = flag("yes");
      const no = flag("no-telemetry");
      const r = runInit({ dir, force });
      console.log(`custos init  ->  ${r.dir}`);
      for (const f of r.created) console.log(`  + ${f}`);
      for (const f of r.skipped) console.log(`  = ${f} (exists, use --force to overwrite)`);
      console.log(`  pubkey (base64): ${r.pubkey}`);
      const cfg = await promptConsent({ assumeYes: yes, assumeNo: no });
      if (cfg.enabled) emit({ event: "install", cliVersion: await readVersion() });
      console.log("\nNext:");
      console.log("  custos demo                       # 30-second end-to-end run");
      console.log("  custos show-policy .custos/policy.yaml");
      console.log("  custos proxy --policy .custos/policy.yaml -- <upstream-mcp-cmd>");
      break;
    }
    case "demo": {
      const keep = flag("keep");
      const quiet = flag("quiet");
      const r = await runDemo({ keep, quiet });
      emit({ event: "demo", cliVersion: await readVersion() });
      if (!r.verified) process.exit(1);
      break;
    }
    case "keygen": {
      const dir = opt("dir", "./.custos")!;
      const kp = generateKeypair();
      kp.save(dir);
      console.log(`wrote ${dir}/ledger.key + ledger.pub`);
      console.log(`pubkey (base64): ${kp.publicB64()}`);
      break;
    }
    case "verify": {
      const ledger = opt("ledger", "./.custos/ledger.jsonl")!;
      const pub = opt("pub");
      const r = verifyLedger(ledger, pub);
      if (r.ok) {
        console.log(`OK  ${r.records} records verified`);
      } else {
        for (const e of r.errors) console.error(`ERR ${e}`);
        process.exit(1);
      }
      if (flag("replay")) {
        const policiesDir = opt("policies-dir");
        const rr = replayLedger(ledger, policiesDir);
        console.log(
          `REPLAY  ${rr.replayed}/${rr.records} records replayed` +
          ` (skipped ${rr.skippedNoHash} pre-v0.4.0 records)`,
        );
        for (const m of rr.missingPolicies) console.error(`MISS   ${m}`);
        for (const m of rr.mismatches) console.error(`MISMATCH ${m}`);
        if (!rr.ok) process.exit(2);
      }
      process.exit(0);
      break;
    }
    case "coverage": {
      const ledger = opt("ledger", "./.custos/ledger.jsonl")!;
      const intervalS = parseFloat(opt("interval", "60")!);
      const tolerance = parseFloat(opt("tolerance", "2.0")!);
      const r = verifyCoverage(ledger, intervalS, tolerance);
      if (r.attestations === 0) {
        console.error("NO ATTESTATIONS in ledger — cannot compute coverage.");
        console.error(
          "Emit `new Gate(..., { attest: true })` (default) or " +
          "`ledger.appendAttestation({ reason: 'periodic', ... })` on your cadence.",
        );
        process.exit(2);
      }
      console.log(
        `COVERAGE  ${r.attestations} attestations across ${r.windowS.toFixed(1)}s` +
        ` (${r.firstTs} → ${r.lastTs})`,
      );
      for (const [reason, n] of Object.entries(r.byReason).sort()) {
        console.log(`  ${reason.padEnd(14)} ${n}`);
      }
      if (r.gaps.length > 0) {
        console.error(
          `GAPS  ${r.gaps.length} gap(s) > ${(intervalS * tolerance).toFixed(1)}s` +
          ` (max ${r.maxGapS.toFixed(1)}s, total ${r.totalGapS.toFixed(1)}s)`,
        );
        for (const g of r.gaps) {
          console.error(`  ${g.fromTs} → ${g.toTs}  (${g.durationS.toFixed(1)}s)`);
        }
        process.exit(2);
      }
      console.log(`OK   control observably operating for ${r.windowS.toFixed(1)}s with no gaps`);
      process.exit(0);
      break;
    }
    case "proxy": {
      const { runStdioProxy } = await import("./proxy.js");
      const policyPath = opt("policy");
      const ledgerPath = opt("ledger", "./.custos/ledger.jsonl")!;
      const keysDir = opt("keys", "./.custos")!;
      const actorId = opt("actor-id", "agent")!;
      const serverId = opt("server-id", "upstream")!;
      const dashIdx = argv.indexOf("--");
      if (!policyPath || dashIdx < 0) { console.error("usage: custos proxy --policy p.yaml -- upstream-cmd..."); process.exit(2); }
      const upstream = argv.slice(dashIdx + 1);
      const kp = loadKeypair(keysDir);
      const ledger = new Ledger(ledgerPath, kp);
      const policy = loadPolicy(policyPath);
      emit({ event: "proxy", cliVersion: await readVersion() });
      const code = await runStdioProxy({
        upstreamCmd: upstream,
        policy, ledger,
        actor: newActor(actorId),
        server: { id: serverId, pubkey: kp.publicB64() },
      });
      process.exit(code);
      break;
    }
    case "serve": {
      // NOTE: the dashboard has NO authentication by default. Do not expose it
      // to untrusted networks. Use --token or CUSTOS_DASHBOARD_TOKEN to require
      // a bearer token on /api/* endpoints.
      const { serve } = await import("./dashboard.js");
      const ledger = opt("ledger", "./.custos/ledger.jsonl")!;
      const host = opt("host", "127.0.0.1")!;
      const port = parseInt(opt("port", "8787")!, 10);
      const token = opt("token");
      emit({ event: "serve", cliVersion: await readVersion() });
      await serve(ledger, { host, port, token });
      break;
    }
    case "bundle": {
      const ledger = opt("ledger", "./.custos/ledger.jsonl")!;
      const keys = opt("keys", "./.custos")!;
      const output = argv.filter((a) => !a.startsWith("--") && !["./.custos", ledger, keys].includes(a)).pop();
      if (!output) { console.error("usage: custos bundle [--ledger p] [--keys d] output.tar.gz"); process.exit(2); }
      const kp = loadKeypair(keys);
      const pub = ledger.replace(/\.jsonl$/, ".pub");
      const out = await createBundle(ledger, pub, output, kp);
      console.log(`wrote ${out}`);
      break;
    }
    case "verify-bundle": {
      const path = argv.find((a) => !a.startsWith("--"));
      if (!path) { console.error("usage: custos verify-bundle <path>"); process.exit(2); }
      const r = await verifyBundle(path);
      if (r.ok) { console.log(`OK  ${r.records} records verified`); process.exit(0); }
      console.error(`FAIL ${r.errors.join(", ")}`);
      process.exit(1);
      break;
    }
    case "show-policy": {
      const path = argv.find((a) => !a.startsWith("--"));
      if (!path) { console.error("usage: custos show-policy <path>"); process.exit(2); }
      const p = loadPolicy(path);
      console.log(`id=${p.id} version=${p.version} default=${p.defaultDecision} rules=${p.rules.length}`);
      for (const r of p.rules) console.log(`  ${r.id}: when=${JSON.stringify(r.when)} decision=${r.decision} reason=${JSON.stringify(r.reason)}`);
      break;
    }
    case "--version":
    case "-V": {
      console.log(await readVersion());
      break;
    }
    default:
      console.log(
        "custos <command>\n\n" +
        "Commands:\n" +
        "  init           Scaffold .custos/ (keypair + starter policy)\n" +
        "  demo           Self-contained end-to-end run (30s)\n" +
        "  keygen         Generate ed25519 keypair\n" +
        "  verify         Verify a ledger\n" +
        "  proxy          Run stdio MCP proxy\n" +
        "  serve          Launch dashboard (NO auth by default; use --token or\n" +
        "                 CUSTOS_DASHBOARD_TOKEN to require a bearer token, and\n" +
        "                 do not expose to untrusted networks)\n" +
        "  bundle         Export evidence bundle\n" +
        "  verify-bundle  Verify evidence bundle\n" +
        "  show-policy    Print normalized policy",
      );
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
