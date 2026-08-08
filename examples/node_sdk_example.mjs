// In-process Gate SDK example (Node).
//   node examples/node_sdk_example.mjs
import { existsSync, readFileSync, rmSync } from "node:fs";
import { Gate, Ledger, generateKeypair, loadPolicy, newActor, verifyLedger } from "custos-mcp";

if (existsSync(".custos-demo")) rmSync(".custos-demo", { recursive: true, force: true });
const kp = generateKeypair();
kp.save(".custos-demo");
const ledger = new Ledger(".custos-demo/ledger.jsonl", kp);
const policy = loadPolicy("examples/policy.yaml");

const gate = new Gate(policy, ledger, newActor("agent-1"), { id: "demo", pubkey: kp.publicB64() });

const readFile = ({ path }) => existsSync(path) ? readFileSync(path, "utf8") : `<missing:${path}>`;
const httpRequest = ({ method, url }) => ({ status: 200, url, method });

for (const path of ["/workspace/notes.md", "/etc/passwd", "/workspace/../secret"]) {
  const r = await gate.call("read_file", { path }, readFile);
  console.log(`  read_file(${JSON.stringify(path)}) -> ${r.decision}  reason=${JSON.stringify(r.reason)}`);
}

for (const [method, url] of [["GET", "https://api.example.com/"], ["POST", "https://api.example.com/"], ["GET", "http://x"]]) {
  const r = await gate.call("http_request", { method, url }, httpRequest);
  console.log(`  http_request(${method},${url}) -> ${r.decision}  reason=${JSON.stringify(r.reason)}`);
}

console.log(`\nledger head: ${ledger.head}`);
console.log(`records: ${ledger.seq}`);

const v = verifyLedger(".custos-demo/ledger.jsonl");
console.log(`verify: ok=${v.ok} records=${v.records}`);
