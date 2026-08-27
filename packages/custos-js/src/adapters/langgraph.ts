/**
 * LangGraph / LangChain-JS adapter.
 *
 * gateTool(tool, gate) mutates a LangChain-shaped tool so every `.invoke`
 * goes through the Custos Gate first. Denies throw CustosDenied, which
 * LangGraph's ToolNode surfaces as a ToolMessage the LLM can react to.
 *
 * Duck-typed on `.name` and `.invoke(input, config?)`. No @langchain/*
 * import at module load — safe to import in any environment.
 */
import type { Gate } from "../sdk.js";

export class CustosDenied extends Error {
  readonly rule: string;
  readonly reason: string;
  readonly traceId: string;
  constructor(rule: string, reason: string, traceId: string) {
    super(`custos denied [${rule}]: ${reason}`);
    this.name = "CustosDenied";
    this.rule = rule;
    this.reason = reason;
    this.traceId = traceId;
  }
}

export interface GateToolOptions {
  toolName?: string;
}

interface LangChainToolShape {
  name?: string;
  invoke?: (input: unknown, config?: unknown) => unknown | Promise<unknown>;
}

function coerceArgs(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return { input };
}

export function gateTool<T extends LangChainToolShape>(
  tool: T,
  gate: Gate,
  opts: GateToolOptions = {},
): T {
  const name = opts.toolName ?? tool.name;
  if (!name) {
    throw new Error("tool has no .name; pass toolName explicitly");
  }
  const originalInvoke = tool.invoke;
  if (typeof originalInvoke !== "function") {
    throw new Error("tool has no .invoke");
  }
  const boundInvoke = originalInvoke.bind(tool);

  tool.invoke = async (input: unknown, config?: unknown) => {
    const args = coerceArgs(input);
    const result = await gate.call(name, args, () =>
      config !== undefined ? boundInvoke(input, config) : boundInvoke(input),
    );
    if (!result.allowed) {
      throw new CustosDenied(result.rule, result.reason, result.record.trace_id);
    }
    return result.result;
  };
  return tool;
}

/**
 * Convenience wrapper: gate an array of tools and return a LangGraph ToolNode
 * with them all wired up. Lazy imports @langchain/langgraph so this file stays
 * safe to load without the peer dep.
 */
export async function makeToolNode<T extends LangChainToolShape>(
  tools: T[],
  gate: Gate,
): Promise<unknown> {
  let ToolNode: any;
  try {
    ({ ToolNode } = await import("@langchain/langgraph/prebuilt" as string));
  } catch {
    throw new Error(
      "makeToolNode requires @langchain/langgraph. Install with: npm i @langchain/langgraph",
    );
  }
  const gated = tools.map((t) => gateTool(t, gate));
  return new ToolNode(gated);
}
