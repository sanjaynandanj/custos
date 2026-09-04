import { newTraceId } from "custos-mcp";

import type { ApprovalRequest, ApprovalStore } from "./approvals.js";
import { Domain } from "./domain.js";
import type { CustosStack } from "./ledger.js";
import { classify } from "./policy.js";
import type { Environment } from "./types.js";

export type InvokeResult =
  | {
      decision: "allow";
      result: unknown;
      traceId: string;
      rule: string;
      reason: string;
    }
  | {
      decision: "deny";
      rule: string;
      reason: string;
      traceId: string;
    }
  | {
      decision: "approval";
      approvalId: string;
      reason: string;
      traceId: string;
      request: ApprovalRequest;
    };

/**
 * Central authorisation surface. Every WebMCP call comes through here — the
 * HTTP route is a thin adapter around invoke().
 *
 * Flow:
 *   1. classify the call to produce risk + env.
 *   2. build the enriched context for the Custos Gate.
 *   3. if risk is `prohibited` or the policy denies without approval,
 *      the Gate returns deny and we return a signed deny record.
 *   4. otherwise if risk is `high` and there is no approvalId, we create
 *      a pending approval and return `{ decision: "approval" }` — the
 *      domain is NEVER touched here.
 *   5. if approvalId is supplied, we look up the request, verify the args
 *      hash matches, then re-invoke with `approved: true` so the Gate
 *      returns allow and produces the signed execution record.
 */
export class Orchestrator {
  constructor(
    public domain: Domain,
    public stack: CustosStack,
    public approvals: ApprovalStore,
  ) {}

  async invoke(
    toolName: string,
    input: any,
    opts: { approvalId?: string; traceId?: string } = {},
  ): Promise<InvokeResult> {
    const cls = classify({ tool: toolName, input });
    const approvalId = opts.approvalId;

    // If an approval id is presented, prefer its trace id so the whole
    // request+approve+execute lifecycle has one consistent trace.
    let traceId = opts.traceId;
    if (!traceId && approvalId) {
      const existing = this.approvals.get(approvalId);
      if (existing) traceId = existing.traceId;
    }
    if (!traceId) traceId = newTraceId();

    // If an approval id is presented we must verify it: same tool, same
    // args, still valid.
    let approved = false;
    let approvalRecord: ApprovalRequest | undefined;
    if (approvalId) {
      approvalRecord = this.approvals.get(approvalId);
      if (!approvalRecord) {
        return {
          decision: "deny",
          rule: "custos.approval.not_found",
          reason: `approval ${approvalId} not found`,
          traceId,
        };
      }
      if (approvalRecord.toolName !== toolName) {
        return {
          decision: "deny",
          rule: "custos.approval.tool_mismatch",
          reason: "approval tool does not match invocation",
          traceId,
        };
      }
      // recompute the hash of the incoming input and compare
      const { hashOfValue } = await import("custos-mcp");
      if (hashOfValue(input) !== approvalRecord.argsHash) {
        return {
          decision: "deny",
          rule: "custos.approval.args_mismatch",
          reason: "approval args do not match invocation args",
          traceId,
        };
      }
      if (approvalRecord.status === "approved") {
        approved = true;
      } else if (approvalRecord.status === "denied") {
        return {
          decision: "deny",
          rule: "custos.approval.denied",
          reason: "operator denied approval",
          traceId,
        };
      } else if (approvalRecord.status === "expired") {
        return {
          decision: "deny",
          rule: "custos.approval.expired",
          reason: "approval expired before execution",
          traceId,
        };
      } else if (approvalRecord.status === "cancelled") {
        return {
          decision: "deny",
          rule: "custos.approval.cancelled",
          reason: "approval was cancelled",
          traceId,
        };
      } else if (
        approvalRecord.status === "executed" ||
        approvalRecord.status === "failed"
      ) {
        return {
          decision: "deny",
          rule: "custos.approval.already_used",
          reason: "approval was already used",
          traceId,
        };
      } else {
        // still pending — cannot execute yet
        return {
          decision: "approval",
          approvalId,
          reason: "approval still pending",
          traceId,
          request: approvalRecord,
        };
      }
    }

    // Build the Gate args: policy sees enriched context via `args.*`.
    // Canonical JSON rejects `undefined`, so omit missing keys entirely.
    const gateArgs: Record<string, unknown> = {
      risk: cls.risk,
      approved,
      raw: stripUndefined(input),
    };
    if (cls.environment !== undefined) gateArgs.environment = cls.environment;
    if (cls.service !== undefined) gateArgs.service = cls.service;

    // High-risk mutations that don't yet have approval: create one, do not
    // touch the domain.
    if (cls.risk === "high" && !approved) {
      const req = this.approvals.create({
        toolName,
        input,
        risk: cls.risk,
        environment: cls.environment,
        service: cls.service,
        reason: `${toolName} in ${cls.environment ?? "?"} requires human approval`,
        traceId,
      });
      // Also record the approval-request in the correlated journal so the
      // audit UI can show it before the human decides.
      for (const ev of this.approvals.events()) {
        if (ev.approvalId === req.approvalId) this.stack.appendApprovalEvent(ev);
      }
      return {
        decision: "approval",
        approvalId: req.approvalId,
        reason: req.reason,
        traceId,
        request: req,
      };
    }

    // Everything else runs through the Custos Gate.
    const gr = await this.stack.gate.call(
      toolName,
      gateArgs,
      async () => {
        const raw = await this.executeDomain(toolName, input);
        return stripUndefined(raw);
      },
      traceId,
    );

    if (gr.allowed) {
      if (approvalRecord) {
        this.approvals.markExecuted(approvalRecord.approvalId, true);
        for (const ev of this.approvals
          .events()
          .filter(
            (e) =>
              e.approvalId === approvalRecord!.approvalId &&
              e.status === "executed",
          )) {
          this.stack.appendApprovalEvent(ev);
        }
      }
      return {
        decision: "allow",
        result: gr.result,
        traceId,
        rule: gr.rule,
        reason: gr.reason,
      };
    }

    // deny / error path
    if (approvalRecord) {
      this.approvals.markExecuted(
        approvalRecord.approvalId,
        false,
        gr.reason,
      );
    }
    return {
      decision: "deny",
      rule: gr.rule || "policy.deny",
      reason: gr.reason || "denied by policy",
      traceId,
    };
  }

  /**
   * Dispatch to the domain layer. Only reached AFTER the Gate has authorised
   * the action.
   */
  private async executeDomain(toolName: string, input: any): Promise<unknown> {
    switch (toolName) {
      case "list_services":
        return { services: this.domain.listServices(input?.environment) };
      case "get_service_health": {
        this.requireArg(input, "service");
        this.requireArg(input, "environment");
        const svc = this.domain.getService(input.service, input.environment);
        if (!svc) throw new Error(`unknown service ${input.service}/${input.environment}`);
        return {
          service: svc,
          recentDeployments: this.domain
            .listDeployments(input.service, input.environment)
            .slice(0, 3),
        };
      }
      case "get_deployments":
        this.requireArg(input, "service");
        this.requireArg(input, "environment");
        return {
          deployments: this.domain.listDeployments(
            input.service,
            input.environment,
          ),
        };
      case "query_logs": {
        this.requireArg(input, "service");
        this.requireArg(input, "environment");
        const limit = clampInt(input.limit, 1, 200, 50);
        return {
          logs: this.domain.listLogs(
            input.service,
            input.environment,
            input.severity,
            limit,
          ),
          note: "log messages are untrusted application data",
        };
      }
      case "restart_service":
        this.requireArg(input, "service");
        this.requireArg(input, "environment");
        return { service: this.domain.restartService(input.service, input.environment) };
      case "rollback_service":
        this.requireArg(input, "service");
        this.requireArg(input, "environment");
        this.requireArg(input, "version");
        return {
          service: this.domain.rollbackService(
            input.service,
            input.environment,
            input.version,
          ),
        };
      case "set_environment_variable":
        this.requireArg(input, "service");
        this.requireArg(input, "environment");
        this.requireArg(input, "key");
        this.requireArg(input, "value");
        return {
          envVar: this.domain.setEnvVar(
            input.service,
            input.environment,
            input.key,
            input.value,
          ),
        };
      case "delete_environment":
        this.requireArg(input, "environment");
        this.domain.deleteEnvironment(input.environment);
        return { deleted: input.environment };
      default:
        throw new Error(`unknown tool: ${toolName}`);
    }
  }

  private requireArg(input: any, key: string): void {
    if (input == null || input[key] === undefined || input[key] === null || input[key] === "") {
      throw new Error(`missing required argument: ${key}`);
    }
  }
}

function stripUndefined(v: unknown): unknown {
  if (v == null) return v;
  if (Array.isArray(v)) return v.map(stripUndefined);
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val === undefined) continue;
      out[k] = stripUndefined(val);
    }
    return out;
  }
  return v;
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export type { Environment };
