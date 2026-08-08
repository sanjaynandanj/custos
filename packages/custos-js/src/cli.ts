#!/usr/bin/env node
import { generateKeypair, loadKeypair } from "./keys.js";
import { Ledger } from "./ledger.js";
import { loadPolicy } from "./policy.js";
import { newActor } from "./record.js";
import { verifyLedger } from "./verify.js";
import { createBundle, verifyBundle } from "./bundle.js";

const argv = process.argv.slice(2);
const cmd = argv.shift();

function opt(name: string, def?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return def;
}

async function main() {
  switch (cmd) {
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
      if (r.ok) { console.log(`OK  ${r.records} records verified`); process.exit(0); }
      for (const e of r.errors) console.error(`ERR ${e}`);
      process.exit(1);
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
      const { serve } = await import("./dashboard.js");
      const ledger = opt("ledger", "./.custos/ledger.jsonl")!;
      const host = opt("host", "127.0.0.1")!;
      const port = parseInt(opt("port", "8787")!, 10);
      await serve(ledger, { host, port });
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
      const { readFileSync } = await import("node:fs");
      const { fileURLToPath } = await import("node:url");
      const { dirname, join } = await import("node:path");
      const here = dirname(fileURLToPath(import.meta.url));
      const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
      console.log(pkg.version);
      break;
    }
    default:
      console.log("custos <command>\n\nCommands:\n  keygen         Generate ed25519 keypair\n  verify         Verify a ledger\n  proxy          Run stdio MCP proxy\n  serve          Launch dashboard\n  bundle         Export evidence bundle\n  verify-bundle  Verify evidence bundle\n  show-policy    Print normalized policy");
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
