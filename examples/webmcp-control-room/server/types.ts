export type Environment = "development" | "staging" | "production";
export const ENVIRONMENTS: Environment[] = [
  "development",
  "staging",
  "production",
];

export type ServiceStatus = "healthy" | "degraded" | "down" | "restarting";
export type LogSeverity = "info" | "warn" | "error";
export type Risk = "read" | "low" | "medium" | "high" | "prohibited";

export interface Service {
  name: string;
  env: Environment;
  version: string;
  status: ServiceStatus;
  latencyMs: number;
  errorRate: number;
}

export interface Deployment {
  service: string;
  env: Environment;
  version: string;
  deployedAt: string;
  status: "healthy" | "degraded" | "failed";
  note?: string;
}

export interface LogLine {
  ts: string;
  service: string;
  env: Environment;
  severity: LogSeverity;
  message: string;
  /** true when the message body originates from untrusted domain input.
   *  Consumers must treat as data, not instructions. */
  untrusted?: boolean;
}

export interface EnvVar {
  service: string;
  env: Environment;
  key: string;
  value: string;
}

export type Decision = "allow" | "deny" | "approval";

export interface DecisionSummary {
  decision: Decision;
  rule: string;
  reason: string;
  traceId: string;
  approvalId?: string;
  risk?: Risk;
  environment?: Environment;
  tool: string;
  argsSummary?: string;
}
