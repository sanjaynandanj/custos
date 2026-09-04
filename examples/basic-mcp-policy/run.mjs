// Smallest possible Custos example: one tool, one allow rule, one fallback deny.
import { existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Gate, Ledger, generateKeypair, loadPolicy, newActor } from "custos-mcp";

const here = dirname(fileURLToPath(import.meta.url));
const workdir = resolve(here, ".custos");
if (existsSync(workdir)) rmSync(workdir, { recursive: true, force: true });
const kp = generateKeypair();
kp.save(workdir);
const ledger = new Ledger(resolve(workdir, "ledger.jsonl"), kp);
const policy = loadPolicy(resolve(here, "policy.yaml"));

const gate = new Gate(policy, ledger, newActor("agent-1"), { id: "demo", pubkey: kp.publicB64() });

const readFile = ({ path }) => `<contents of ${path}>`;

for (const path of ["/workspace/notes.txt", "/etc/passwd"]) {
  const r = await gate.call("read_file", { path }, readFile);
  console.log(`read_file(${JSON.stringify(path)}) -> ${r.decision}  reason=${JSON.stringify(r.reason)}`);
}
console.log(`\nledger head: ${ledger.head}   records: ${ledger.seq}`);
