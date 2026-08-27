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
import { gateTool, gateTools } from "../src/adapters/claude-agent.js";

function makeFakeTool(name: string) {
  return {
    name,
    description: `fake ${name}`,
    input_schema: { type: "object", properties: {} },
    async handler(args: Record<string, unknown>) {
      return { content: [{ type: "text", text: JSON.stringify(args) }] };
    },
  };
}

function makeGate() {
  const dir = mkdtempSync(join(tmpdir(), "custos-ca-"));
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

describe("claude-agent adapter", () => {
  it("allow passes through", async () => {
    const { gate } = makeGate();
    const tool = gateTool(makeFakeTool("read_file"), gate);
    const out: any = await tool.handler({ path: "/etc/hostname" });
    expect(out.content[0].text).toContain("/etc/hostname");
    expect(out.isError).toBeUndefined();
  });

  it("explicit deny returns MCP error result — does not throw", async () => {
    const { gate } = makeGate();
    const tool = gateTool(makeFakeTool("shell.exec"), gate);
    const out: any = await tool.handler({ cmd: "rm -rf /" });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("custos denied [deny-shell]");
    expect(out.content[0].text).toContain("no shell");
  });

  it("default deny returns error result", async () => {
    const { gate } = makeGate();
    const tool = gateTool(makeFakeTool("write_file"), gate);
    const out: any = await tool.handler({ path: "/x" });
    expect(out.isError).toBe(true);
  });

  it("ledger records both allow and deny", async () => {
    const { gate, dir } = makeGate();
    const allowTool = gateTool(makeFakeTool("read_file"), gate);
    const denyTool = gateTool(makeFakeTool("shell.exec"), gate);
    await allowTool.handler({ path: "/a" });
    await denyTool.handler({ cmd: "id" });
    const r = verifyLedger(join(dir, "ledger.jsonl"), join(dir, "ledger.pub"));
    expect(r.ok).toBe(true);
    expect(r.records).toBe(2);
  });

  it("preserves name/description/input_schema", async () => {
    const { gate } = makeGate();
    const t = makeFakeTool("read_file");
    const gated = gateTool(t, gate);
    expect(gated.name).toBe("read_file");
    expect(gated.description).toBe("fake read_file");
    expect(gated.input_schema).toBeDefined();
  });

  it("gateTools wraps every tool in the array", async () => {
    const { gate } = makeGate();
    const tools = gateTools([makeFakeTool("read_file"), makeFakeTool("shell.exec")], gate);
    expect(tools).toHaveLength(2);
    const first: any = await tools[0].handler({ path: "/x" });
    expect(first.isError).toBeUndefined();
    const second: any = await tools[1].handler({ cmd: "id" });
    expect(second.isError).toBe(true);
  });

  it("missing handler throws", () => {
    const { gate } = makeGate();
    expect(() => gateTool({ name: "x" } as any, gate)).toThrow(/no \.handler/);
  });
});
