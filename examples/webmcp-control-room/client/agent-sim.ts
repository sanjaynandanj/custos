import * as api from "./api.js";
import type { InvokeResult, ToolSpec } from "./api.js";

/**
 * Local agent simulator. When WebMCP is unavailable in the current browser
 * (i.e. any browser that is not the ChatGPT in-app one) this is the fallback
 * used to drive the demo end-to-end. It is intentionally labelled
 * "LOCAL AGENT SIMULATOR" in the UI so nobody mistakes it for real WebMCP.
 *
 * It works by pattern-matching a small canned prompt vocabulary against tool
 * names + arguments. It is NOT an LLM.
 */
export interface AgentAction {
  tool: string;
  input: Record<string, unknown>;
}

export function planPrompt(prompt: string): AgentAction[] {
  const p = prompt.toLowerCase();

  if (/investigate|debug|why.*(payment|checkout)|payment.*(degraded|latency)/.test(p)) {
    return [
      { tool: "list_services", input: { environment: "production" } },
      { tool: "get_service_health", input: { service: "payment-service", environment: "production" } },
      { tool: "query_logs", input: { service: "payment-service", environment: "production", limit: 20 } },
      { tool: "get_deployments", input: { service: "payment-service", environment: "production" } },
      { tool: "rollback_service", input: { service: "payment-service", environment: "production", version: "2.3.9" } },
    ];
  }
  if (/rollback.*payment/.test(p)) {
    return [
      { tool: "rollback_service", input: { service: "payment-service", environment: "production", version: "2.3.9" } },
    ];
  }
  if (/restart.*notification.*staging|restart.*staging.*notification/.test(p)) {
    return [
      { tool: "restart_service", input: { service: "notifications", environment: "staging" } },
    ];
  }
  if (/delete.*production|drop.*production|nuke.*production/.test(p)) {
    return [
      { tool: "delete_environment", input: { environment: "production" } },
    ];
  }
  if (/list.*services/.test(p)) {
    return [{ tool: "list_services", input: {} }];
  }
  if (/health.*(payment|checkout)/.test(p)) {
    return [
      { tool: "get_service_health", input: { service: "payment-service", environment: "production" } },
    ];
  }
  if (/logs.*payment/.test(p)) {
    return [
      { tool: "query_logs", input: { service: "payment-service", environment: "production", limit: 20 } },
    ];
  }
  return [];
}

export interface AgentStep {
  action: AgentAction;
  outcome: InvokeResult;
}

/**
 * Run a plan through the backend, waiting for approvals via polling.
 * Emits progress via onStep so the UI can render actions as they happen.
 */
export async function runAgent(
  actions: AgentAction[],
  hooks: {
    onStep?: (step: AgentStep) => void;
    signal?: AbortSignal;
  } = {},
  _tools?: ToolSpec[],
): Promise<AgentStep[]> {
  const steps: AgentStep[] = [];
  for (const action of actions) {
    if (hooks.signal?.aborted) break;
    const first = await api.invokeTool(action.tool, action.input, { signal: hooks.signal });
    if (first.decision !== "approval") {
      const step = { action, outcome: first };
      steps.push(step);
      hooks.onStep?.(step);
      // If a hard deny lands, the agent should stop escalating.
      if (first.decision === "deny") break;
      continue;
    }
    const approvalId = first.approvalId;
    let final: InvokeResult = first;
    while (true) {
      if (hooks.signal?.aborted) break;
      const cur = await api.pollApproval(approvalId);
      if (!cur) {
        final = {
          decision: "deny",
          rule: "custos.approval.not_found",
          reason: "approval vanished",
          traceId: first.traceId,
        };
        break;
      }
      if (cur.status === "approved" || cur.status === "executed") {
        final = await api.invokeTool(action.tool, action.input, {
          approvalId,
          signal: hooks.signal,
        });
        break;
      }
      if (cur.status === "denied") {
        final = {
          decision: "deny",
          rule: "human.denied",
          reason: "operator declined the request",
          traceId: first.traceId,
        };
        break;
      }
      if (cur.status === "cancelled" || cur.status === "expired" || cur.status === "failed") {
        final = {
          decision: "deny",
          rule: `custos.approval.${cur.status}`,
          reason: `approval ${cur.status}`,
          traceId: first.traceId,
        };
        break;
      }
      await sleep(600, hooks.signal);
    }
    const step = { action, outcome: final };
    steps.push(step);
    hooks.onStep?.(step);
    if (final.decision === "deny") break;
  }
  return steps;
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
