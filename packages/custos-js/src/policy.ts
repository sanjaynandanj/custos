import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import yaml from "js-yaml";

import { canonicalBytes } from "./canonical.js";
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
  /**
   * sha256:<hex> of the exact policy source (raw file bytes when loaded
   * from a path, canonical JSON of the input for programmatic
   * construction). Recorded on every DecisionRecord so decisions can be
   * pinned to the exact policy text in effect at the time. See
   * spec/WIRE.md §6.1.
   */
  hash = "";
  /** Raw source bytes and extension — used by bundle snapshotting. */
  sourceBytes: Uint8Array = new Uint8Array(0);
  sourceExt = "";
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

  /**
   * Write this policy's raw source to `<directory>/<hex>.<ext>`.
   *
   * The filename is content-addressed (derived from `this.hash` with the
   * `sha256:` prefix stripped) so multiple policy versions co-exist under
   * the same directory and a verifier can look up the exact policy that
   * produced a given `record.policy.hash`.
   *
   * Idempotent: if the target file already exists it is NOT rewritten
   * (the hash guarantees the bytes match). Returns the target path, or
   * null if this Policy has no source bytes to snapshot (e.g. a
   * third-party adapter that never populated them).
   */
  snapshotTo(directory: string): string | null {
    if (!this.sourceBytes || this.sourceBytes.length === 0 || !this.hash) return null;
    mkdirSync(directory, { recursive: true });
    const hex = this.hash.includes(":") ? this.hash.split(":", 2)[1]! : this.hash;
    const ext = this.sourceExt || "bin";
    const target = join(directory, `${hex}.${ext}`);
    if (!existsSync(target)) writeFileSync(target, this.sourceBytes);
    return target;
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
      case "regex": {
        // ``arg`` may be a pre-compiled RegExp (see loadPolicy) or a raw
        // string (for callers that build rules programmatically). Pre-
        // compiling avoids re-parsing on every evaluation and surfaces bad
        // patterns at load time. NOTE: V8's RegExp is a backtracking engine
        // and can ReDoS on adversarial patterns; for untrusted-policy
        // deployments consider a linear-time engine (e.g. re2-wasm).
        const re: RegExp = arg instanceof RegExp ? arg : new RegExp(arg as string);
        if (!(typeof value === "string" && re.test(value))) return false;
        break;
      }
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

/**
 * Return a shallow copy of ``when`` where every ``regex`` operator's argument
 * is replaced with a pre-compiled RegExp. Throws on invalid patterns so bad
 * regexes are caught at load time rather than first evaluation. This also
 * reduces the ReDoS attack surface — see the note in matchOp.
 */
function precompileWhen(ruleId: string, when: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [path, expected] of Object.entries(when)) {
    if (expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
      const spec: Record<string, unknown> = {};
      for (const [op, arg] of Object.entries(expected as Record<string, unknown>)) {
        if (op === "regex" && typeof arg === "string") {
          try {
            spec[op] = new RegExp(arg);
          } catch (e: any) {
            throw new Error(`rule "${ruleId}": invalid regex for path "${path}": ${e.message ?? e}`);
          }
        } else {
          spec[op] = arg;
        }
      }
      out[path] = spec;
    } else {
      out[path] = expected;
    }
  }
  return out;
}

export function loadPolicy(pathOrData: string | object): Policy {
  // For file-backed policies we hash the raw file bytes — that is the
  // exact artifact the operator committed, and what an auditor will
  // diff. For dict inputs we hash canonical JSON of the parsed value.
  // Byte-level: CRLF vs LF policies are different policies.
  let data: any;
  let sourceBytes: Uint8Array;
  let sourceExt: string;
  if (typeof pathOrData === "string") {
    const raw = readFileSync(pathOrData);
    sourceBytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    data = yaml.load(raw.toString("utf8"));
    sourceExt = extname(pathOrData).replace(/^\./, "") || "yaml";
  } else {
    data = pathOrData;
    sourceBytes = canonicalBytes(data);
    sourceExt = "json";
  }
  const version = data.version ?? 1;
  if (version !== 1) throw new Error(`unsupported policy version: ${version}`);
  const rules: Rule[] = (data.rules ?? []).map((r: any) => ({
    id: r.id,
    when: precompileWhen(r.id, r.when ?? {}),
    decision: parseDecision(r.decision),
    reason: r.reason ?? "",
  }));
  const policy = new Policy(data.id ?? "default", parseDecision(data.default ?? "deny"), rules);
  policy.hash = "sha256:" + createHash("sha256").update(sourceBytes).digest("hex");
  policy.sourceBytes = sourceBytes;
  policy.sourceExt = sourceExt;
  return policy;
}

function parseDecision(s: string): Decision {
  if (s === "allow" || s === "deny" || s === "error") return s;
  throw new Error(`invalid decision: ${s}`);
}
