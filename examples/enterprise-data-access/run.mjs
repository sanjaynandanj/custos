// Mock `db_query` tool guarded by a Custos SELECT-only policy.
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
const gate = new Gate(policy, ledger, newActor("analyst-42"), { id: "warehouse", pubkey: kp.publicB64() });

const dbQuery = ({ sql }) => ({ rows: [], sql_ran: sql });

const queries = [
  "SELECT id, total FROM orders WHERE ts > now() - interval '1 day' LIMIT 100",
  "INSERT INTO orders (id, total) VALUES (1, 9.99)",
  "DROP TABLE customers",
  "SELECT * FROM invoices",
];

for (const sql of queries) {
  const r = await gate.call("db_query", { sql }, dbQuery);
  const tag = r.decision === "allow" ? "ALLOW" : "DENY ";
  const short = sql.length < 60 ? sql : sql.slice(0, 57) + "...";
  console.log(`${tag}  ${short}\n        rule=${r.rule || "-"}  reason=${r.reason}\n`);
}
console.log(`ledger records: ${ledger.seq}   head: ${ledger.head}`);
