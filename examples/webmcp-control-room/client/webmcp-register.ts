import {
  getModelContext,
  registerCustosWebTools,
  type CustosOutcome,
  type CustosWebToolSpec,
  type ModelContext,
} from "custos-mcp/adapters/webmcp";

import * as api from "./api.js";
import type { ToolSpec } from "./api.js";

export interface WebMCPStatus {
  supported: boolean;
  registeredCount: number;
  message: string;
}

/**
 * Build a decider that talks to the Control Room backend. Approvals resolve
 * via long-polling `/api/approvals/:id`.
 */
function buildDecider(toolName: string) {
  return async (input: unknown, ctx: { signal?: AbortSignal }): Promise<CustosOutcome> => {
    const outcome = await api.invokeTool(toolName, input, { signal: ctx.signal });
    if (outcome.decision !== "approval") return outcome as CustosOutcome;
    const approvalId = outcome.approvalId;
    return {
      decision: "approval",
      approvalId,
      reason: outcome.reason,
      traceId: outcome.traceId,
      wait: async (signal?: AbortSignal): Promise<CustosOutcome> => {
        while (true) {
          if (signal?.aborted) {
            try {
              await api.cancelApproval(approvalId);
            } catch { /* ignore */ }
            return {
              decision: "deny",
              rule: "custos.cancelled",
              reason: "call cancelled",
              traceId: outcome.traceId,
            };
          }
          const req = await api.pollApproval(approvalId);
          if (!req) {
            return {
              decision: "deny",
              rule: "custos.approval.not_found",
              reason: "approval vanished",
              traceId: outcome.traceId,
            };
          }
          if (req.status === "approved" || req.status === "executed") {
            // Re-invoke with approvalId to trigger the signed execution record
            // and return the underlying result.
            const final = await api.invokeTool(toolName, input, {
              approvalId,
              signal,
            });
            return final as CustosOutcome;
          }
          if (req.status === "denied") {
            return {
              decision: "deny",
              rule: "human.denied",
              reason: "operator declined the request",
              traceId: outcome.traceId,
            };
          }
          if (req.status === "cancelled") {
            return {
              decision: "deny",
              rule: "custos.approval.cancelled",
              reason: "approval was cancelled",
              traceId: outcome.traceId,
            };
          }
          if (req.status === "expired") {
            return {
              decision: "deny",
              rule: "custos.approval.expired",
              reason: "approval expired before decision",
              traceId: outcome.traceId,
            };
          }
          await sleep(600, signal);
        }
      },
    };
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

export function tryRegisterAll(tools: ToolSpec[]): WebMCPStatus {
  const mc: ModelContext | null = getModelContext();
  if (!mc) {
    return {
      supported: false,
      registeredCount: 0,
      message:
        "WebMCP unavailable in this browser. Open in the ChatGPT in-app browser or a Chrome build with WebMCP enabled. The LOCAL AGENT SIMULATOR still lets you exercise the flow.",
    };
  }
  const specs: CustosWebToolSpec[] = tools.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: t.annotations,
    decide: buildDecider(t.name),
  }));
  registerCustosWebTools(mc, specs);
  return {
    supported: true,
    registeredCount: specs.length,
    message: `Registered ${specs.length} WebMCP tools.`,
  };
}
