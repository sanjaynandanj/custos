import { readFileSync } from "node:fs";
import yaml from "js-yaml";

import { Decision } from "./record.js";

const MISSING = Symbol("missing");

export interface PolicyDecisionOutput {
  decision: Decision;
  ruleId: string;
  reason: string;
}

export interface Rule {
  id: string;
  when: Record<string, unknown>;
  decision: Decision;
  reason: string;
}

export class Policy {
  version = 1;
  engine = "native";
  constructor(
    public id: string,
    public defaultDecision: Decision,
    public rules: Rule[],
  ) {}

  evaluate(ctx: Record<string, unknown>): PolicyDecisionOutput {
    for (const rule of this.rules) {
      if (matchesRule(rule, ctx)) {
        return { decision: rule.decision, ruleId: rule.id, reason: rule.reason };
      }
    }
    return { decision: this.defaultDecision, ruleId: "", reason: `default:${this.defaultDecision}` };
  }
}

function lookup(ctx: Record<string, unknown>, dotted: string): unknown | typeof MISSING {
  let cur: unknown = ctx;
  for (const part of dotted.split(".")) {
    if (cur && typeof cur === "object" && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return MISSING;
    }
  }
  return cur;
}

function matchScalar(value: unknown, expected: unknown): boolean {
  if (typeof expected === "string" && typeof value === "string" && (expected.includes("*") || expected.includes("?"))) {
    return globMatch(value, expected);
  }
  return value === expected;
}

function globMatch(s: string, pattern: string): boolean {
  const re = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
  return re.test(s);
}

function matchOp(value: unknown, opSpec: Record<string, unknown>, present: boolean): boolean {
  for (const [op, arg] of Object.entries(opSpec)) {
    if (op === "exists") {
      if (Boolean(arg) !== present) return false;
      continue;
    }
    if (!present) return false;
    switch (op) {
      case "prefix":  if (!(typeof value === "string" && value.startsWith(arg as string))) return false; break;
      case "suffix":  if (!(typeof value === "string" && value.endsWith(arg as string))) return false; break;
      case "contains":if (!(typeof value === "string" && value.includes(arg as string))) return false; break;
      case "regex":   if (!(typeof value === "string" && new RegExp(arg as string).test(value))) return false; break;
      case "in":      if (!(arg as unknown[]).includes(value)) return false; break;
      case "not_in":  if ((arg as unknown[]).includes(value)) return false; break;
      case "eq":      if (value !== arg) return false; break;
      case "ne":      if (value === arg) return false; break;
      case "gt":      if (!(typeof value === "number" && value > (arg as number))) return false; break;
      case "lt":      if (!(typeof value === "number" && value < (arg as number))) return false; break;
      case "gte":     if (!(typeof value === "number" && value >= (arg as number))) return false; break;
      case "lte":     if (!(typeof value === "number" && value <= (arg as number))) return false; break;
      default: throw new Error(`unknown match operator: ${op}`);
    }
  }
  return true;
}

function matchesRule(rule: Rule, ctx: Record<string, unknown>): boolean {
  for (const [path, expected] of Object.entries(rule.when)) {
    const value = lookup(ctx, path);
    const present = value !== MISSING;
    if (expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
      const real = present ? value : null;
      if (!matchOp(real, expected as Record<string, unknown>, present)) return false;
    } else {
      if (!present) return false;
      if (!matchScalar(value, expected)) return false;
    }
  }
  return true;
}

export function loadPolicy(pathOrData: string | object): Policy {
  let data: any;
  if (typeof pathOrData === "string") {
    data = yaml.load(readFileSync(pathOrData, "utf8"));
  } else {
    data = pathOrData;
  }
  const version = data.version ?? 1;
  if (version !== 1) throw new Error(`unsupported policy version: ${version}`);
  const rules: Rule[] = (data.rules ?? []).map((r: any) => ({
    id: r.id,
    when: r.when ?? {},
    decision: parseDecision(r.decision),
    reason: r.reason ?? "",
  }));
  return new Policy(data.id ?? "default", parseDecision(data.default ?? "deny"), rules);
}

function parseDecision(s: string): Decision {
  if (s === "allow" || s === "deny" || s === "error") return s;
  throw new Error(`invalid decision: ${s}`);
}
