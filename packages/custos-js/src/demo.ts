import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateKeypair } from "./keys.js";
import { Ledger } from "./ledger.js";
import { loadPolicy } from "./policy.js";
import { newActor } from "./record.js";
import { Gate, GateResult } from "./sdk.js";
import { verifyLedger } from "./verify.js";

export interface DemoOptions {
  dir?: string;
  keep?: boolean;
  quiet?: boolean;
}

export interface DemoResult {
  dir: string;
  results: GateResult[];
  verified: boolean;
  records: number;
}

const DEMO_POLICY = {
  version: 1,
  id: "demo",
  default: "deny",
  rules: [
    { id: "no-traversal", when: { "args.path": { contains: ".." } }, decision: "deny", reason: "path traversal blocked" },
    { id: "allow-workspace-read", when: { tool: "read_file", "args.path": { prefix: "/workspace/" } }, decision: "allow", reason: "workspace-only reads" },
    { id: "deny-shell", when: { tool: { regex: "^shell\\." } }, decision: "deny", reason: "shell tools disabled" },
  ],
};

const CALLS: { tool: string; args: Record<string, unknown>; label: string; expect: "allow" | "deny" }[] = [
  { tool: "read_file", args: { path: "/workspace/README.md" }, label: "read a workspace file", expect: "allow" },
  { tool: "read_file", args: { path: "/workspace/../etc/passwd" }, label: "path traversal", expect: "deny" },
  { tool: "shell.exec", args: { cmd: "rm -rf /" }, label: "shell command", expect: "deny" },
];

export async function runDemo(opts: DemoOptions = {}): Promise<DemoResult> {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "custos-demo-"));
  const log = opts.quiet ? () => {} : (s: string) => console.log(s);

  const kp = generateKeypair();
  kp.save(dir);
  const ledgerPath = join(dir, "ledger.jsonl");
  const ledger = new Ledger(ledgerPath, kp);
  const policy = loadPolicy(DEMO_POLICY);
  const gate = new Gate(policy, ledger, newActor("demo-agent"), { id: "mock-mcp", pubkey: kp.publicB64() });

  log(`custos demo — ledger dir: ${dir}\n`);

  const results: GateResult[] = [];
  for (const c of CALLS) {
    const r = await gate.call(c.tool, c.args, async () => ({ ok: true }));
    results.push(r);
    const mark = r.decision === c.expect ? "OK " : "!! ";
    log(`  ${mark}${c.label.padEnd(24)} tool=${c.tool.padEnd(12)} -> ${r.decision.padEnd(5)} rule=${r.rule || "default"}  reason=${r.reason}`);
  }

  const v = verifyLedger(ledgerPath, join(dir, "ledger.pub"));
  log(`\n  ledger: ${v.records} record(s), signature chain ${v.ok ? "verified" : "FAILED"}`);
  if (!opts.quiet && !opts.keep) {
    const tail = readFileSync(ledgerPath, "utf8").trim().split("\n").slice(-1)[0];
    log(`  last record: ${tail}`);
  }

  if (!opts.keep) {
    rmSync(dir, { recursive: true, force: true });
    log(`\n  cleaned up ${dir} (pass --keep to inspect)`);
  } else {
    log(`\n  kept ${dir} — inspect with: custos verify --ledger ${ledgerPath}`);
  }

  return { dir, results, verified: v.ok, records: v.records };
}
