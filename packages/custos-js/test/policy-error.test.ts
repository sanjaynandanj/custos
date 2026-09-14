import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateKeypair } from "../src/keys.js";
import { Ledger } from "../src/ledger.js";
import { Policy } from "../src/policy.js";
import { Gate } from "../src/sdk.js";
import { newActor } from "../src/record.js";
import { verifyLedger } from "../src/verify.js";

// WIRE §7: policy engine errors deny by default and record a reason.
// A throwing policy must NOT bubble out of the enforcement path with no
// record — that reproduces the exact silent-down failure mode Custos
// exists to detect.

class ThrowingPolicy extends Policy {
  constructor() {
    super("throwing", "deny", []);
  }
  override evaluate(): never {
    throw new Error("simulated engine failure");
  }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "custos-poerr-"));
  const kp = generateKeypair();
  kp.save(dir);
  const ledger = new Ledger(join(dir, "ledger.jsonl"), kp);
  const policy = new ThrowingPolicy();
  const gate = new Gate(policy, ledger, newActor("agent-1"), { id: "srv" }, { attest: false });
  return { dir, kp, ledger, gate };
}

describe("policy engine error handling (WIRE §7)", () => {
  it("Gate.call records an error decision and does not execute the tool", async () => {
    const { gate, ledger } = setup();
    let ran = false;
    const r = await gate.call("read", { path: "/tmp/x" }, () => { ran = true; return "nope"; });
    expect(ran).toBe(false);
    expect(r.allowed).toBe(false);
    expect(r.decision).toBe("error");
    expect(r.reason).toContain("policy engine error");
    expect(r.record.decision).toBe("error");
    expect(r.record.enforcement?.effect).toBe("blocked");
    // Ledger still verifies (record was signed and hash-chained).
    const v = verifyLedger(ledger.path);
    expect(v.ok).toBe(true);
    expect(v.records).toBeGreaterThanOrEqual(1);
  });

  it("advisory mode does NOT downgrade a policy-engine error to allow", async () => {
    const dir = mkdtempSync(join(tmpdir(), "custos-poerr-adv-"));
    const kp = generateKeypair();
    kp.save(dir);
    const ledger = new Ledger(join(dir, "ledger.jsonl"), kp);
    const gate = new Gate(new ThrowingPolicy(), ledger, newActor("a"), { id: "s" }, { advisory: true, attest: false });
    let ran = false;
    const r = await gate.call("t", {}, () => { ran = true; return 1; });
    expect(ran).toBe(false);
    expect(r.decision).toBe("error");
    expect(r.allowed).toBe(false);
  });

  it("Gate.check surfaces the error without writing to the ledger", async () => {
    const { gate, ledger } = setup();
    const before = verifyLedger(ledger.path).records;
    const r = gate.check("read", { path: "/tmp/x" });
    expect(r.decision).toBe("error");
    expect(r.reason).toContain("policy engine error");
    const after = verifyLedger(ledger.path).records;
    expect(after).toBe(before);
  });
});
