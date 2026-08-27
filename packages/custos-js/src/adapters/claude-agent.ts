/**
 * Claude Agent SDK adapter.
 *
 * Wraps tools produced by `tool(...)` / `createSdkMcpServer` from
 * `@anthropic-ai/claude-agent-sdk` so every invocation is policy-checked and
 * recorded in the ledger. Denies are returned as MCP-shaped error results the
 * model can react to on its next turn — no exception surfaces to the runtime.
 *
 * Duck-typed on `.name` and `.handler(args) -> Promise<result>`. No SDK import
 * at module load — safe to import in any environment.
 *
 * @example
 *   import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
 *   import { gateTool } from "custos-mcp/adapters/claude-agent";
 *
 *   const readFile = tool("read_file", "Read a file",
 *     { path: z.string() },
 *     async ({ path }) => ({ content: [{ type: "text", text: fs.readFileSync(path, "utf8") }] })
 *   );
 *   gateTool(readFile, gate);
 *   const server = createSdkMcpServer({ name: "fs", version: "0.1", tools: [readFile] });
 */
import type { Gate } from "../sdk.js";

interface ClaudeAgentTool {
  name?: string;
  handler?: (args: Record<string, unknown>, extra?: unknown) => unknown | Promise<unknown>;
}

export interface GateToolOptions {
  toolName?: string;
}

function deniedResult(rule: string, reason: string, traceId: string): {
  content: { type: "text"; text: string }[];
  isError: true;
} {
  return {
    content: [
      {
        type: "text",
        text: `custos denied [${rule}]: ${reason} (trace ${traceId})`,
      },
    ],
    isError: true,
  };
}

export function gateTool<T extends ClaudeAgentTool>(
  tool: T,
  gate: Gate,
  opts: GateToolOptions = {},
): T {
  const name = opts.toolName ?? tool.name;
  if (!name) {
    throw new Error("tool has no .name; pass toolName explicitly");
  }
  const originalHandler = tool.handler;
  if (typeof originalHandler !== "function") {
    throw new Error(
      "tool has no .handler — is this a claude-agent-sdk tool() result?",
    );
  }
  const bound = originalHandler.bind(tool);

  tool.handler = async (args: Record<string, unknown>, extra?: unknown) => {
    const result = await gate.call(name, args, () =>
      extra !== undefined ? bound(args, extra) : bound(args),
    );
    if (!result.allowed) {
      return deniedResult(result.rule, result.reason, result.record.trace_id);
    }
    return result.result;
  };
  return tool;
}

export function gateTools<T extends ClaudeAgentTool>(tools: T[], gate: Gate): T[] {
  return tools.map((t) => gateTool(t, gate));
}
