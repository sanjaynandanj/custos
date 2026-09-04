import { loadPolicy, Policy } from "custos-mcp";

import type { Environment, Risk } from "./types.js";

export interface ClassifierInput {
  tool: string;
  input: any;
}

export interface Classification {
  risk: Risk;
  environment?: Environment;
  service?: string;
}

/**
 * Pure function: given a tool + args produce the operational risk class and
 * pull out the environment/service so the Custos policy can key on them.
 */
export function classify(x: ClassifierInput): Classification {
  const env = (x.input?.environment ?? undefined) as Environment | undefined;
  const service = (x.input?.service ?? undefined) as string | undefined;

  switch (x.tool) {
    case "list_services":
    case "get_service_health":
    case "get_deployments":
    case "query_logs":
      return { risk: "read", environment: env, service };

    case "restart_service":
      return {
        risk: env === "production" ? "high" : "low",
        environment: env,
        service,
      };

    case "rollback_service":
      return {
        risk: env === "production" ? "high" : "low",
        environment: env,
        service,
      };

    case "set_environment_variable":
      if (env === "production") return { risk: "high", environment: env, service };
      if (env === "staging") return { risk: "medium", environment: env, service };
      return { risk: "medium", environment: env, service };

    case "delete_environment":
      if (env === "production") return { risk: "prohibited", environment: env };
      return { risk: "high", environment: env };

    default:
      // unknown tool → hard fail via policy default deny
      return { risk: "prohibited", environment: env, service };
  }
}

/**
 * Build the Custos native policy that governs the Control Room. Rules are
 * ordered — first match wins.
 */
/**
 * Canonical policy definition. The Control Room loads this into a Custos
 * `Policy`, and also serialises it to YAML so it can be bundled into signed
 * evidence bundles alongside the ledger.
 */
export const POLICY_DEFINITION = {
  version: 1,
  id: "custos.webmcp.control-room",
  default: "deny" as const,
  rules: [
    {
      id: "hard-deny-prohibited",
      when: { "args.risk": "prohibited" },
      decision: "deny" as const,
      reason:
        "operation is prohibited by policy (production destructive action)",
    },
    {
      id: "hard-deny-prod-delete",
      when: {
        tool: "delete_environment",
        "args.environment": "production",
      },
      decision: "deny" as const,
      reason: "production environments cannot be deleted by agents",
    },
    {
      id: "allow-read",
      when: { "args.risk": "read" },
      decision: "allow" as const,
      reason: "read-only tool",
    },
    {
      id: "allow-low",
      when: { "args.risk": "low" },
      decision: "allow" as const,
      reason: "low-risk mutation (non-production)",
    },
    {
      id: "allow-medium-nonprod",
      when: {
        "args.risk": "medium",
        "args.environment": { not_in: ["production"] },
      },
      decision: "allow" as const,
      reason: "medium-risk mutation outside production",
    },
    {
      id: "allow-high-approved",
      when: { "args.risk": "high", "args.approved": true },
      decision: "allow" as const,
      reason: "high-risk mutation with human approval",
    },
    // No rule for "high" without "approved" → falls through to default deny,
    // which the app layer converts into an approval request BEFORE calling
    // the Gate the second time.
  ],
};

export function buildPolicy(): Policy {
  return loadPolicy(POLICY_DEFINITION);
}

/**
 * Serialise the policy to YAML for inclusion in signed evidence bundles.
 * Deliberately hand-rolled to avoid adding js-yaml as a dep here; the Custos
 * policy loader accepts either JSON or YAML on the receiving side.
 */
export function policyAsYaml(): string {
  const lines: string[] = [];
  lines.push(`version: ${POLICY_DEFINITION.version}`);
  lines.push(`id: ${POLICY_DEFINITION.id}`);
  lines.push(`default: ${POLICY_DEFINITION.default}`);
  lines.push(`rules:`);
  for (const r of POLICY_DEFINITION.rules) {
    lines.push(`  - id: ${r.id}`);
    lines.push(`    when:`);
    for (const [k, v] of Object.entries(r.when)) {
      const kk = /[.:]/.test(k) ? JSON.stringify(k) : k;
      if (v && typeof v === "object" && !Array.isArray(v)) {
        lines.push(`      ${kk}:`);
        for (const [op, arg] of Object.entries(v as Record<string, unknown>)) {
          lines.push(`        ${op}: ${JSON.stringify(arg)}`);
        }
      } else {
        lines.push(`      ${kk}: ${JSON.stringify(v)}`);
      }
    }
    lines.push(`    decision: ${r.decision}`);
    lines.push(`    reason: ${JSON.stringify(r.reason)}`);
  }
  return lines.join("\n") + "\n";
}
