// Node writes a signed ledger for Python to verify.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { generateKeypair, Ledger, loadPolicy, Gate, newActor } from "../../packages/custos-js/dist/index.js";

const out = process.argv[2];
mkdirSync(out, { recursive: true });
const kp = generateKeypair();
kp.save(out);
const ledger = new Ledger(join(out, "ledger.jsonl"), kp);
const policy = loadPolicy({
  version: 1, default: "deny",
  rules: [
    { id: "allow-read", when: { tool: "read" }, decision: "allow", reason: "ok" },
    { id: "needs-approval", when: { tool: "restart_prod" },
      decision: "approval", reason: "prod restart needs a human" },
  ],
});
const gate = new Gate(policy, ledger, newActor("js-agent"), { id: "js-srv", pubkey: kp.publicB64() });
for (let i = 0; i < 5; i++) {
  await gate.call("read", { i, note: "café" }, ({ i, note }) => ({ got: i, n: note }));
}
await gate.call("write", { i: 99 }, ({ i }) => i);
// Approval + resolution pair (WIRE §2.4). Cross-lang parity: the Python
// verifier must accept both records — decides_ref survives on the wire
// and points back at the approval's record_hash.
const pending = await gate.call(
  "restart_prod", { host: "web-01" },
  ({ host }) => `restarted ${host}`,  // never runs — approval blocks
);
gate.resolveApproval({
  approvalRecordHash: pending.record.record_hash,
  resolution: "allow",
  reason: "approved by oncall via pagerduty",
  tool: "restart_prod",
  args: { host: "web-01" },
  traceId: pending.record.trace_id,
});
console.log(`wrote ${join(out, "ledger.jsonl")}`);
