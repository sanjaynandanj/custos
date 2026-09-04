// Simulate coding-agent tool calls under a Custos policy.
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
const gate = new Gate(policy, ledger, newActor("coding-agent"), { id: "dev-tools", pubkey: kp.publicB64() });

const fns = {
  read_file:   ({ path }) => `<read ${path}>`,
  write_file:  ({ path, content }) => ({ written: path, bytes: content.length }),
  run_shell:   ({ cmd }) => ({ stdout: `ran: ${cmd}`, exit: 0 }),
  git_commit:  ({ branch }) => ({ branch, sha: "deadbeef" }),
  delete_file: ({ path }) => ({ deleted: path }),
};

const calls = [
  ["read_file",   { path: "src/app.py" }],
  ["write_file",  { path: "../etc/hosts", content: "evil" }],
  ["write_file",  { path: "src/main.ts", content: "ok" }],
  ["run_shell",   { cmd: "pytest" }],
  ["run_shell",   { cmd: "rm -rf /" }],
  ["git_commit",  { branch: "main", message: "bypass" }],
  ["delete_file", { path: "src/app.py" }],
];

for (const [tool, args] of calls) {
  const r = await gate.call(tool, args, fns[tool]);
  const tag = r.decision === "allow" ? "ALLOW" : "DENY ";
  console.log(`${tag} ${tool.padEnd(12)} rule=${(r.rule || "-").padEnd(30)} reason=${r.reason}`);
}
console.log(`\nledger records: ${ledger.seq}   head: ${ledger.head}`);
