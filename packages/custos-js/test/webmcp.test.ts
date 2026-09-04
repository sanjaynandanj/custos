import { describe, it, expect, vi } from "vitest";

import {
  type CustosDecider,
  type CustosOutcome,
  type ModelContext,
  type ModelContextTool,
  getModelContext,
  makeHttpDecider,
  registerCustosWebTool,
  registerCustosWebTools,
} from "../src/adapters/webmcp.js";

class FakeModelContext implements ModelContext {
  public registered = new Map<string, ModelContextTool>();
  public registerCalls = 0;

  registerTool(tool: ModelContextTool) {
    this.registerCalls += 1;
    this.registered.set(tool.name, tool);
    return {
      unregister: () => {
        this.registered.delete(tool.name);
      },
    };
  }
}

function allowDecider(result: unknown): CustosDecider {
  return async () => ({
    decision: "allow",
    result,
    traceId: "trace-allow",
  });
}

function denyDecider(rule: string, reason: string): CustosDecider {
  return async () => ({
    decision: "deny",
    rule,
    reason,
    traceId: "trace-deny",
  });
}

describe("webmcp adapter — registration", () => {
  it("forwards name/title/description/inputSchema verbatim", () => {
    const mc = new FakeModelContext();
    registerCustosWebTool(mc, {
      name: "list_services",
      title: "List services",
      description: "Return the list of services in an environment",
      inputSchema: {
        type: "object",
        properties: { environment: { type: "string" } },
      },
      decide: allowDecider([]),
    });
    const tool = mc.registered.get("list_services")!;
    expect(tool.name).toBe("list_services");
    expect(tool.title).toBe("List services");
    expect(tool.description).toContain("environment");
    expect(tool.inputSchema).toEqual({
      type: "object",
      properties: { environment: { type: "string" } },
    });
  });

  it("preserves readOnlyHint annotation", () => {
    const mc = new FakeModelContext();
    registerCustosWebTool(mc, {
      name: "get_service_health",
      annotations: { readOnlyHint: true },
      decide: allowDecider({}),
    });
    expect(mc.registered.get("get_service_health")?.annotations).toEqual({
      readOnlyHint: true,
    });
  });

  it("preserves untrustedContentHint annotation", () => {
    const mc = new FakeModelContext();
    registerCustosWebTool(mc, {
      name: "query_logs",
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      decide: allowDecider([]),
    });
    expect(
      mc.registered.get("query_logs")?.annotations?.untrustedContentHint,
    ).toBe(true);
  });

  it("rejects missing name / decide", () => {
    const mc = new FakeModelContext();
    // @ts-expect-error missing name
    expect(() => registerCustosWebTool(mc, { decide: allowDecider(1) })).toThrow(
      /name/,
    );
    // @ts-expect-error missing decide
    expect(() => registerCustosWebTool(mc, { name: "x" })).toThrow(/decide/);
  });

  it("registerCustosWebTools returns a bulk unregister", () => {
    const mc = new FakeModelContext();
    const { unregisterAll } = registerCustosWebTools(mc, [
      { name: "a", decide: allowDecider(1) },
      { name: "b", decide: allowDecider(2) },
    ]);
    expect(mc.registered.size).toBe(2);
    unregisterAll();
    expect(mc.registered.size).toBe(0);
  });
});

describe("webmcp adapter — execution", () => {
  it("allow returns the underlying result", async () => {
    const mc = new FakeModelContext();
    registerCustosWebTool(mc, {
      name: "t",
      decide: allowDecider({ items: [1, 2, 3] }),
    });
    const tool = mc.registered.get("t")!;
    const out = await tool.execute({}, {});
    expect(out).toEqual({ items: [1, 2, 3] });
  });

  it("deny returns MCP-shaped error result", async () => {
    const mc = new FakeModelContext();
    registerCustosWebTool(mc, {
      name: "t",
      decide: denyDecider("policy.prod_delete", "cannot delete production"),
    });
    const tool = mc.registered.get("t")!;
    const out = (await tool.execute({}, {})) as {
      isError: true;
      content: { text: string }[];
    };
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("custos denied");
    expect(out.content[0].text).toContain("policy.prod_delete");
    expect(out.content[0].text).toContain("cannot delete production");
    expect(out.content[0].text).toContain("trace-deny");
  });

  it("thrown decider error surfaces as normalised MCP error", async () => {
    const mc = new FakeModelContext();
    registerCustosWebTool(mc, {
      name: "t",
      decide: async () => {
        throw new Error("kaboom");
      },
    });
    const tool = mc.registered.get("t")!;
    const out = (await tool.execute({}, {})) as {
      isError: true;
      content: { text: string }[];
    };
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("custos error");
    expect(out.content[0].text).toContain("kaboom");
  });

  it("AbortSignal is forwarded to the decider", async () => {
    const mc = new FakeModelContext();
    const seen: AbortSignal[] = [];
    registerCustosWebTool(mc, {
      name: "t",
      decide: async (_input, ctx) => {
        seen.push(ctx.signal!);
        return { decision: "allow", result: null };
      },
    });
    const ctrl = new AbortController();
    await mc.registered.get("t")!.execute({}, { signal: ctrl.signal });
    expect(seen[0]).toBe(ctrl.signal);
  });

  it("approval outcome waits then resolves with the underlying result", async () => {
    const mc = new FakeModelContext();
    let resolveApproval!: (o: CustosOutcome) => void;
    const approvalPromise = new Promise<CustosOutcome>((r) => {
      resolveApproval = r;
    });

    registerCustosWebTool(mc, {
      name: "rollback",
      decide: async () => ({
        decision: "approval",
        approvalId: "ap-1",
        reason: "prod mutation",
        traceId: "trace-appr",
        wait: () => approvalPromise,
      }),
    });

    const tool = mc.registered.get("rollback")!;
    const inflight = tool.execute({ version: "2.3.9" }, {});
    // resolve out-of-band, as if a human clicked APPROVE
    resolveApproval({
      decision: "allow",
      result: { rolledBackTo: "2.3.9" },
      traceId: "trace-appr",
    });
    const out = await inflight;
    expect(out).toEqual({ rolledBackTo: "2.3.9" });
  });

  it("approval → human deny surfaces a MCP error", async () => {
    const mc = new FakeModelContext();
    const approvalPromise: Promise<CustosOutcome> = Promise.resolve({
      decision: "deny",
      rule: "human.denied",
      reason: "operator declined",
      traceId: "trace-appr",
    });
    registerCustosWebTool(mc, {
      name: "rollback",
      decide: async () => ({
        decision: "approval",
        approvalId: "ap-2",
        reason: "prod mutation",
        traceId: "trace-appr",
        wait: () => approvalPromise,
      }),
    });
    const out = (await mc.registered.get("rollback")!.execute({}, {})) as {
      isError: true;
      content: { text: string }[];
    };
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("human.denied");
  });

  it("unregister removes the tool from the model context", () => {
    const mc = new FakeModelContext();
    const reg = registerCustosWebTool(mc, {
      name: "temp",
      decide: allowDecider(1),
    });
    expect(mc.registered.has("temp")).toBe(true);
    reg.unregister();
    expect(mc.registered.has("temp")).toBe(false);
  });
});

describe("getModelContext", () => {
  it("returns null when document is undefined", () => {
    expect(getModelContext()).toBeNull();
  });

  it("returns null when document has no modelContext", () => {
    expect(getModelContext({} as unknown)).toBeNull();
  });

  it("returns the ModelContext when present", () => {
    const mc = new FakeModelContext();
    const doc = { modelContext: mc };
    expect(getModelContext(doc)).toBe(mc);
  });
});

describe("makeHttpDecider", () => {
  it("posts { name, input } and returns allow outcome", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          decision: "allow",
          result: { ok: true },
          traceId: "t-1",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const decide = makeHttpDecider("list_services", {
      invokeUrl: "http://x/api/tools/list_services",
      pollUrlBase: "http://x/api/approvals",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const outcome = await decide({ environment: "production" }, {});
    expect(outcome.decision).toBe("allow");
    expect(fetchImpl).toHaveBeenCalledOnce();
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as any).body);
    expect(body).toEqual({
      name: "list_services",
      input: { environment: "production" },
    });
  });

  it("non-2xx backend response becomes a deny outcome", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 }));
    const decide = makeHttpDecider("t", {
      invokeUrl: "http://x/api/tools/t",
      pollUrlBase: "http://x/api/approvals",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const outcome = await decide({}, {});
    expect(outcome.decision).toBe("deny");
    expect((outcome as any).rule).toBe("custos.backend_error");
  });

  it("approval outcome carries a wait() that polls until resolved", async () => {
    let polls = 0;
    const fetchImpl = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.endsWith("/tool")) {
        return new Response(
          JSON.stringify({
            decision: "approval",
            approvalId: "ap-9",
            reason: "prod",
            traceId: "t-9",
          }),
          { status: 200 },
        );
      }
      polls += 1;
      if (polls < 2) return new Response("", { status: 202 });
      return new Response(
        JSON.stringify({
          decision: "allow",
          result: { done: true },
          traceId: "t-9",
        }),
        { status: 200 },
      );
    });
    const decide = makeHttpDecider("t", {
      invokeUrl: "http://x/tool",
      pollUrlBase: "http://x/approvals",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      pollIntervalMs: 1,
    });
    const outcome = await decide({}, {});
    expect(outcome.decision).toBe("approval");
    if (outcome.decision !== "approval") throw new Error("unreachable");
    const final = await outcome.wait();
    expect(final.decision).toBe("allow");
  });
});
