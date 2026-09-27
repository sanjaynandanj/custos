import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateKeypair } from "../src/keys.js";
import { Ledger } from "../src/ledger.js";
import { loadPolicy } from "../src/policy.js";
import { Gate } from "../src/sdk.js";
import { newActor } from "../src/record.js";
import { verifyLedger } from "../src/verify.js";
import { APPROVAL_CODE, DENY_CODE } from "../src/proxy.js";

function freshGate(policyDict: any) {
  const dir = mkdtempSync(join(tmpdir(), "custos-approval-"));
  const kp = generateKeypair();
  kp.save(dir);
  const ledger = new Ledger(join(dir, "ledger.jsonl"), kp);
  const policy = loadPolicy(policyDict);
  const gate = new Gate(policy, ledger, newActor("agent-1"), { id: "test-server" }, {
    // keep the ledger surface small so tests read tightly
    attest: false,
  });
  return { dir, ledger, gate };
}

describe("approval (WIRE §2.4)", () => {
  it("records and does not execute", async () => {
    const { dir, gate } = freshGate({
      version: 1,
      id: "test",
      default: "deny",
      rules: [
        { id: "needs-approval", when: { tool: "restart_prod" },
          decision: "approval", reason: "prod restart needs a human" },
      ],
    });
    let ran = 0;
    const result = await gate.call("restart_prod", {}, () => { ran++; return "restarted"; });

    expect(result.decision).toBe("approval");
    expect(result.rule).toBe("needs-approval");
    expect(result.allowed).toBe(false);
    expect(ran).toBe(0);
    expect(result.result).toBeUndefined();
    expect(result.record.result_hash).toBe("");
    expect(result.record.latency_ms).toBe(0);
    expect(result.record.decides_ref).toBeUndefined();

    const v = verifyLedger(join(dir, "ledger.jsonl"), join(dir, "ledger.pub"));
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.records).toBe(1);
  });

  it("advisory mode does not downgrade approval", async () => {
    const dir = mkdtempSync(join(tmpdir(), "custos-approval-adv-"));
    const kp = generateKeypair();
    kp.save(dir);
    const ledger = new Ledger(join(dir, "ledger.jsonl"), kp);
    const policy = loadPolicy({
      version: 1, id: "test", default: "deny",
      rules: [{ id: "r", when: { tool: "restart_prod" }, decision: "approval" }],
    });
    const gate = new Gate(policy, ledger, newActor("agent-1"), { id: "s" }, {
      advisory: true, attest: false,
    });
    let ran = 0;
    const result = await gate.call("restart_prod", {}, () => { ran++; return "x"; });
    expect(result.decision).toBe("approval");
    expect(ran).toBe(0);
  });

  it("resolveApproval writes follow-up record with decides_ref", async () => {
    const { dir, ledger, gate } = freshGate({
      version: 1, id: "test", default: "deny",
      rules: [{ id: "r", when: { tool: "restart_prod" }, decision: "approval",
                reason: "prod restart needs a human" }],
    });
    const pending = await gate.call("restart_prod", { host: "web-01" }, () => "no-run");
    expect(pending.decision).toBe("approval");
    const approvalHash = pending.record.record_hash!;
    expect(approvalHash).toMatch(/^sha256:/);

    const resolution = gate.resolveApproval({
      approvalRecordHash: approvalHash,
      resolution: "allow",
      reason: "approved by oncall via pagerduty",
      tool: "restart_prod",
      args: { host: "web-01" },
      traceId: pending.record.trace_id,
    });
    expect(resolution.decision).toBe("allow");
    expect(resolution.decides_ref).toBe(approvalHash);
    expect(resolution.policy.rule).toBe("human-approval");
    expect(resolution.trace_id).toBe(pending.record.trace_id);

    const v = verifyLedger(join(dir, "ledger.jsonl"), join(dir, "ledger.pub"));
    expect(v.errors).toEqual([]);
    expect(v.records).toBe(2);

    // Confirm decides_ref survives on the wire.
    const lines = readFileSync(join(dir, "ledger.jsonl"), "utf8").trim().split("\n");
    const parsed = JSON.parse(lines[1]);
    expect(parsed.decides_ref).toBe(approvalHash);
    expect(parsed.decision).toBe("allow");
  });

  it("resolveApproval rejects invalid resolutions", async () => {
    const { gate } = freshGate({
      version: 1, id: "test", default: "deny",
      rules: [{ id: "r", when: { tool: "x" }, decision: "approval" }],
    });
    const pending = await gate.call("x", {}, () => null);
    expect(() => gate.resolveApproval({
      approvalRecordHash: pending.record.record_hash!,
      // @ts-expect-error: intentionally invalid
      resolution: "approval",
      reason: "bad",
      tool: "x", args: {}, traceId: pending.record.trace_id,
    })).toThrow(/allow.*deny/);
    expect(() => gate.resolveApproval({
      approvalRecordHash: "",
      resolution: "allow",
      reason: "missing ref",
      tool: "x", args: {}, traceId: pending.record.trace_id,
    })).toThrow(/approvalRecordHash/);
  });

  it("decides_ref omitted on wire when empty", async () => {
    const { dir, gate } = freshGate({
      version: 1, id: "test", default: "allow", rules: [],
    });
    await gate.call("read_file", { path: "/a" }, () => "ok");
    const line = readFileSync(join(dir, "ledger.jsonl"), "utf8").trim().split("\n")[0];
    const parsed = JSON.parse(line);
    expect("decides_ref" in parsed).toBe(false);
  });

  it("proxy exports distinct APPROVAL_CODE", () => {
    expect(APPROVAL_CODE).toBe(-32002);
    expect(DENY_CODE).toBe(-32001);
    expect(APPROVAL_CODE).not.toBe(DENY_CODE);
  });
});
