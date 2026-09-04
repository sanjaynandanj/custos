import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateKeypair } from "../src/keys.js";
import { Ledger } from "../src/ledger.js";
import { loadPolicy } from "../src/policy.js";
import { Gate } from "../src/sdk.js";
import { newActor } from "../src/record.js";
import { verifyLedger } from "../src/verify.js";
import { CustosDenied, gateTool } from "../src/adapters/langgraph.js";

class FakeTool {
  name: string;
  description: string;
  calls: unknown[] = [];
  constructor(name: string) {
    this.name = name;
    this.description = `fake ${name}`;
  }
  async invoke(input: any, _config?: unknown) {
    this.calls.push(input);
    return { echo: input };
  }
}

function makeGate() {
  const dir = mkdtempSync(join(tmpdir(), "custos-lg-"));
  const kp = generateKeypair();
  kp.save(dir);
  const ledger = new Ledger(join(dir, "ledger.jsonl"), kp);
  const policy = loadPolicy({
    version: 1,
    id: "test",
    default: "deny",
    rules: [
      { id: "allow-read", when: { tool: "read_file" }, decision: "allow", reason: "reads ok" },
      { id: "deny-shell", when: { tool: { regex: "^shell\\." } }, decision: "deny", reason: "no shell" },
    ],
  });
  const gate = new Gate(policy, ledger, newActor("agent"), { id: "srv" });
  return { gate, dir };
}

describe("langgraph adapter", () => {
  it("allow passes through", async () => {
    const { gate } = makeGate();
    const tool = gateTool(new FakeTool("read_file"), gate);
    const out = await tool.invoke({ path: "/etc/hostname" });
    expect(out).toEqual({ echo: { path: "/etc/hostname" } });
  });

  it("explicit deny raises CustosDenied", async () => {
    const { gate } = makeGate();
    const tool = gateTool(new FakeTool("shell.exec"), gate);
    await expect(tool.invoke({ cmd: "rm -rf /" })).rejects.toBeInstanceOf(CustosDenied);
    try {
      await tool.invoke({ cmd: "id" });
    } catch (e) {
      const err = e as CustosDenied;
      expect(err.rule).toBe("deny-shell");
      expect(err.reason).toContain("no shell");
    }
  });

  it("default deny raises", async () => {
    const { gate } = makeGate();
    const tool = gateTool(new FakeTool("write_file"), gate);
    await expect(tool.invoke({ path: "/x" })).rejects.toBeInstanceOf(CustosDenied);
  });

  it("ledger records allow and deny", async () => {
    const { gate, dir } = makeGate();
    const allowTool = gateTool(new FakeTool("read_file"), gate);
    const denyTool = gateTool(new FakeTool("shell.exec"), gate);
    await allowTool.invoke({ path: "/a" });
    await expect(denyTool.invoke({ cmd: "id" })).rejects.toBeInstanceOf(CustosDenied);
    const r = verifyLedger(join(dir, "ledger.jsonl"), join(dir, "ledger.pub"));
    expect(r.ok).toBe(true);
    // 1 startup attestation + 1 allow + 1 deny.
    expect(r.records).toBe(3);
  });

  it("missing name throws", async () => {
    const { gate } = makeGate();
    const nameless: any = { invoke: (a: any) => a };
    expect(() => gateTool(nameless, gate)).toThrow(/no \.name/);
  });

  it("scalar input is coerced to { input }", async () => {
    const { gate } = makeGate();
    const tool = gateTool(new FakeTool("read_file"), gate);
    const out = await tool.invoke("just-a-string");
    expect(out).toEqual({ echo: "just-a-string" });
  });
});
