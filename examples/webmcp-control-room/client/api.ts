export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint?: boolean;
    untrustedContentHint?: boolean;
  };
}

export interface ApprovalRequest {
  approvalId: string;
  toolName: string;
  input: unknown;
  argsHash: string;
  risk: string;
  environment?: string;
  service?: string;
  reason: string;
  createdAt: number;
  expiresAt: number;
  status: string;
  traceId: string;
}

export type InvokeResult =
  | { decision: "allow"; result: unknown; traceId: string; rule: string; reason: string }
  | { decision: "deny"; rule: string; reason: string; traceId: string }
  | { decision: "approval"; approvalId: string; reason: string; traceId: string; request: ApprovalRequest };

const BASE = "";

export async function getTools(): Promise<ToolSpec[]> {
  const r = await fetch(`${BASE}/api/tools`);
  const j = await r.json();
  return j.tools;
}

export async function getState(): Promise<any> {
  const r = await fetch(`${BASE}/api/state`);
  return r.json();
}

export async function getApprovals(): Promise<ApprovalRequest[]> {
  const r = await fetch(`${BASE}/api/approvals`);
  const j = await r.json();
  return j.approvals;
}

export async function getAudit(): Promise<{ ledger: any[]; approvalEvents: any[] }> {
  const r = await fetch(`${BASE}/api/audit`);
  return r.json();
}

export async function getHealth(): Promise<{ ok: boolean; records: number; error: string | null }> {
  const r = await fetch(`${BASE}/api/health`);
  return r.json();
}

export async function invokeTool(
  name: string,
  input: unknown,
  opts: { approvalId?: string; signal?: AbortSignal } = {},
): Promise<InvokeResult> {
  const r = await fetch(`${BASE}/api/tools/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input, approvalId: opts.approvalId }),
    signal: opts.signal,
  });
  return r.json();
}

export async function approveApproval(id: string): Promise<ApprovalRequest> {
  const r = await fetch(`${BASE}/api/approvals/${encodeURIComponent(id)}/approve`, {
    method: "POST",
  });
  const j = await r.json();
  return j.approval;
}
export async function denyApproval(id: string): Promise<ApprovalRequest> {
  const r = await fetch(`${BASE}/api/approvals/${encodeURIComponent(id)}/deny`, {
    method: "POST",
  });
  const j = await r.json();
  return j.approval;
}
export async function cancelApproval(id: string): Promise<ApprovalRequest> {
  const r = await fetch(`${BASE}/api/approvals/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
  });
  const j = await r.json();
  return j.approval;
}
export async function pollApproval(id: string): Promise<ApprovalRequest | null> {
  const r = await fetch(`${BASE}/api/approvals/${encodeURIComponent(id)}`);
  if (r.status === 404) return null;
  const j = await r.json();
  return j.approval;
}

export async function reset(): Promise<void> {
  await fetch(`${BASE}/api/reset`, { method: "POST" });
}

export interface PolicySnapshot {
  policy: {
    version: number;
    id: string;
    default: string;
    rules: Array<{
      id: string;
      when: Record<string, unknown>;
      decision: string;
      reason: string;
    }>;
  };
  tools: Array<{
    tool: string;
    environment: string;
    risk: string;
    withoutApproval: { decision: string; ruleId: string; reason: string };
    withApproval: { decision: string; ruleId: string; reason: string };
  }>;
}
export async function getPolicy(): Promise<PolicySnapshot> {
  const r = await fetch(`${BASE}/api/policy`);
  return r.json();
}

export function downloadBundleUrl(): string {
  return `${BASE}/api/bundle`;
}
