import * as api from "./api.js";
import type { PolicySnapshot } from "./api.js";
import { planPrompt, runAgent, type AgentStep } from "./agent-sim.js";
import { h, replace } from "./dom.js";
import { tryRegisterAll, type WebMCPStatus } from "./webmcp-register.js";

interface UiState {
  tools: api.ToolSpec[];
  services: any[];
  approvals: api.ApprovalRequest[];
  audit: { ledger: any[]; approvalEvents: any[] };
  health: { ok: boolean; records: number; error: string | null };
  webmcp: WebMCPStatus;
  agentSteps: AgentStep[];
  currentDecision: null | {
    tool: string;
    decision: string;
    rule: string;
    reason: string;
    traceId: string;
    approvalId?: string;
    risk?: string;
    environment?: string;
  };
  envFilter: "all" | "development" | "staging" | "production";
  auditFilter: "all" | "allow" | "deny" | "approval";
  agentBusy: boolean;
  policyDrawerOpen: boolean;
  policySnapshot: PolicySnapshot | null;
}

const state: UiState = {
  tools: [],
  services: [],
  approvals: [],
  audit: { ledger: [], approvalEvents: [] },
  health: { ok: false, records: 0, error: null },
  webmcp: { supported: false, registeredCount: 0, message: "detecting…" },
  agentSteps: [],
  currentDecision: null,
  envFilter: "all",
  auditFilter: "all",
  agentBusy: false,
  policyDrawerOpen: false,
  policySnapshot: null,
};

let refreshTimer: number | undefined;
let currentAbort: AbortController | null = null;

async function bootstrap() {
  const tools = await api.getTools();
  state.tools = tools;
  state.webmcp = tryRegisterAll(tools);
  await refreshAll();
  render();
  refreshTimer = window.setInterval(refreshAll, 1500) as unknown as number;
}

async function refreshAll() {
  try {
    const [st, ap, au, he] = await Promise.all([
      api.getState(),
      api.getApprovals(),
      api.getAudit(),
      api.getHealth(),
    ]);
    state.services = st.services;
    state.approvals = ap;
    state.audit = au;
    state.health = he;
    render();
  } catch (err) {
    console.error("refresh failed", err);
  }
}

// ---------- render ----------

function render() {
  const root = document.getElementById("root")!;

  // Preserve the agent input's focus / caret / typed text across re-renders,
  // otherwise the 1.5s poll wipes what the user was typing.
  const active = document.activeElement as HTMLElement | null;
  const activeId = active?.id || null;
  const prevInput = document.getElementById("agent-prompt") as HTMLInputElement | null;
  const savedValue = prevInput?.value ?? "";
  const savedSelStart = prevInput?.selectionStart ?? null;
  const savedSelEnd = prevInput?.selectionEnd ?? null;

  const wrapper = h("div", {}, [
    h("div", { class: "app" }, [
      header(),
      hero(),
      leftColumn(),
      rightColumn(),
      footer(),
    ]),
    state.policyDrawerOpen ? policyDrawer() : null,
  ]);
  replace(root, wrapper);

  const nextInput = document.getElementById("agent-prompt") as HTMLInputElement | null;
  if (nextInput) {
    if (savedValue) nextInput.value = savedValue;
    if (activeId === "agent-prompt") {
      nextInput.focus();
      if (savedSelStart != null && savedSelEnd != null) {
        try { nextInput.setSelectionRange(savedSelStart, savedSelEnd); } catch { /* ignore */ }
      }
    }
  }
}

function header(): HTMLElement {
  const webmcp = state.webmcp;
  const pillClass = webmcp.supported ? "pill ok" : "pill warn";
  return h("div", { class: "header" }, [
    h("div", { class: "left" }, [
      h("span", { class: "brand" }, ["CUSTOS"]),
      h("span", { class: "title" }, ["Agent Operations Control Room"]),
    ]),
    h("div", { class: "right" }, [
      h("span", { class: pillClass }, [
        h("span", { class: "dot" }, []),
        webmcp.supported
          ? `WebMCP · ${webmcp.registeredCount} tools`
          : "LOCAL AGENT SIMULATOR",
      ]),
      h(
        "span",
        {
          class: `pill ${state.health.ok ? "ok" : "err"}`,
          title: state.health.error ?? "",
        },
        [
          h("span", { class: "dot" }, []),
          state.health.ok
            ? `Ledger verified · ${state.health.records} records`
            : "Ledger unverified",
        ],
      ),
      h(
        "button",
        {
          class: "btn ghost",
          title: "Show the loaded Custos policy and per-tool decision matrix",
          onclick: async () => {
            state.policyDrawerOpen = true;
            if (!state.policySnapshot) {
              state.policySnapshot = await api.getPolicy();
            }
            render();
          },
        },
        ["Policy"],
      ),
      h(
        "a",
        {
          class: "btn ghost",
          href: api.downloadBundleUrl(),
          title:
            "Download the signed Custos evidence bundle: manifest + Ed25519-signed ledger + policy files. Verify offline with verifyBundle().",
        },
        ["Export bundle"],
      ),
      h(
        "button",
        {
          class: "btn ghost",
          onclick: async () => {
            await api.reset();
            state.agentSteps = [];
            state.currentDecision = null;
            await refreshAll();
          },
        },
        ["Reset demo"],
      ),
    ]),
  ]);
}

function hero(): HTMLElement {
  return h("div", { class: "hero" }, [
    h("div", {}, [
      "Ask an agent to investigate the ",
      h("span", { class: "env" }, ["payment-service"]),
      " incident in production. Watch Custos evaluate every tool call before it touches the application.",
    ]),
    h("div", { class: "env-tabs" }, [
      envTabButton("all"),
      envTabButton("development"),
      envTabButton("staging"),
      envTabButton("production"),
    ]),
  ]);
}

function envTabButton(env: UiState["envFilter"]): HTMLElement {
  return h(
    "button",
    {
      class: state.envFilter === env ? "active" : "",
      onclick: () => {
        state.envFilter = env;
        render();
      },
    },
    [env],
  );
}

function leftColumn(): HTMLElement {
  return h("div", { class: "panel" }, [
    h("div", { class: "panel-header" }, [
      "Services",
      h("span", { class: "count" }, [String(filteredServices().length)]),
    ]),
    h("div", { class: "panel-body" }, [servicesGrid()]),
    h("div", { class: "panel-header" }, ["Agent session"]),
    h("div", { class: "panel-body" }, [agentTimeline()]),
    agentInput(),
  ]);
}

function servicesGrid(): HTMLElement {
  const svcs = filteredServices();
  return h(
    "div",
    { class: "grid-services" },
    svcs.map((s) => {
      const status = String(s.status);
      const pillCls =
        status === "healthy" ? "pill ok" : status === "degraded" ? "pill warn" : "pill err";
      return h("div", { class: "service" }, [
        h("div", { class: "row1" }, [
          h("span", {}, [
            h("span", { class: "name" }, [s.name]),
            " ",
            h("span", { class: "env" }, [s.env]),
          ]),
          h("span", { class: pillCls }, [
            h("span", { class: "dot" }, []),
            status,
          ]),
        ]),
        h("div", { class: "row2" }, [
          h("span", {}, ["v", h("b", {}, [s.version])]),
          h("span", {}, [
            "lat ",
            h("b", {}, [`${s.latencyMs}ms`]),
          ]),
          h("span", {}, [
            "err ",
            h("b", {}, [
              `${Math.round(Number(s.errorRate) * 1000) / 10}%`,
            ]),
          ]),
        ]),
      ]);
    }),
  );
}

function filteredServices() {
  if (state.envFilter === "all") return state.services;
  return state.services.filter((s) => s.env === state.envFilter);
}

function agentTimeline(): HTMLElement {
  if (state.agentSteps.length === 0 && !state.agentBusy) {
    return h(
      "div",
      { class: "empty-state" },
      [
        "No agent activity yet. Try one of the demo prompts below, or open this page in the ChatGPT in-app browser and ask the model to investigate the payment incident.",
      ],
    );
  }
  return h(
    "div",
    { class: "timeline" },
    state.agentSteps.map((step) => {
      const dec = step.outcome.decision;
      const cls = dec === "allow" ? "allow" : dec === "deny" ? "deny" : "approval";
      const time = new Date().toLocaleTimeString();
      return h("div", { class: `timeline-row ${cls}` }, [
        h("span", {}, [time]),
        h("span", { class: "tool" }, [step.action.tool]),
        h("span", {}, [
          argSummary(step.action.tool, step.action.input),
          " · ",
          step.outcome.decision === "deny"
            ? `${(step.outcome as any).rule}: ${(step.outcome as any).reason}`
            : step.outcome.decision === "approval"
              ? "awaiting human approval"
              : (step.outcome as any).reason,
        ]),
        h("span", { class: `decision ${cls}` }, [dec]),
      ]);
    }),
  );
}

function argSummary(tool: string, input: any): string {
  if (!input || typeof input !== "object") return "";
  const parts: string[] = [];
  for (const k of ["service", "environment", "version", "key", "severity", "limit"]) {
    if (input[k] !== undefined) parts.push(`${k}=${input[k]}`);
  }
  return parts.join(" ");
}

function agentInput(): HTMLElement {
  const input = h("input", {
    id: "agent-prompt",
    type: "text",
    autocomplete: "off",
    placeholder:
      state.webmcp.supported
        ? 'e.g. "Investigate why checkout is degraded"'
        : 'Local agent simulator — try: "Investigate why checkout is degraded"',
  }) as HTMLInputElement;
  const submit = async () => {
    if (state.agentBusy) return;
    const prompt = input.value.trim();
    if (!prompt) return;
    const actions = planPrompt(prompt);
    if (actions.length === 0) {
      state.agentSteps = [
        ...state.agentSteps,
        {
          action: { tool: "chat", input: {} },
          outcome: {
            decision: "deny",
            rule: "sim.unknown",
            reason: "the local simulator doesn't understand that prompt yet — try one of the demo prompts",
            traceId: "sim",
          },
        },
      ];
      render();
      return;
    }
    state.agentBusy = true;
    currentAbort?.abort();
    currentAbort = new AbortController();
    render();
    try {
      await runAgent(actions, {
        signal: currentAbort.signal,
        onStep: (step) => {
          state.agentSteps = [...state.agentSteps, step];
          state.currentDecision = {
            tool: step.action.tool,
            decision: step.outcome.decision,
            rule: (step.outcome as any).rule ?? "",
            reason: (step.outcome as any).reason ?? "",
            traceId: (step.outcome as any).traceId ?? "",
            approvalId: (step.outcome as any).approvalId,
            risk: (step.outcome as any).request?.risk,
            environment: (step.action.input as any)?.environment,
          };
          render();
          refreshAll();
        },
      });
    } finally {
      state.agentBusy = false;
      input.value = "";
      refreshAll();
      render();
    }
  };
  input.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") submit();
  });
  return h("div", { class: "agent-input" }, [
    input,
    h("button", { class: "btn primary", onclick: submit, disabled: state.agentBusy }, [
      state.agentBusy ? "Running…" : "Run",
    ]),
    h(
      "button",
      {
        class: "btn ghost",
        title: "Cancel current agent run",
        onclick: () => currentAbort?.abort(),
      },
      ["Stop"],
    ),
  ]);
}

function rightColumn(): HTMLElement {
  return h("div", { class: "panel" }, [
    h("div", { class: "panel-header" }, ["Current policy decision"]),
    h("div", { class: "panel-body" }, [currentDecisionCard()]),
    h("div", { class: "panel-header" }, [
      "Human approval queue",
      h("span", { class: "count" }, [
        String(state.approvals.filter((a) => a.status === "pending").length),
      ]),
    ]),
    h("div", { class: "panel-body" }, [approvalQueue()]),
    h("div", { class: "panel-header" }, [
      "Audit trail",
      h("div", { class: "filters" }, [
        auditFilterButton("all"),
        auditFilterButton("allow"),
        auditFilterButton("deny"),
        auditFilterButton("approval"),
      ]),
    ]),
    h("div", { class: "panel-body" }, [auditTimeline()]),
  ]);
}

function auditFilterButton(f: UiState["auditFilter"]): HTMLElement {
  return h(
    "button",
    {
      class: `btn ${state.auditFilter === f ? "active" : ""}`,
      onclick: () => {
        state.auditFilter = f;
        render();
      },
    },
    [f],
  );
}

function currentDecisionCard(): HTMLElement {
  const c = state.currentDecision;
  if (!c) {
    return h(
      "div",
      { class: "empty-state" },
      ["No decision yet."],
    );
  }
  const cls = c.decision === "allow" ? "allow" : c.decision === "deny" ? "deny" : "approval";
  return h("div", { class: `decision-card ${cls}` }, [
    h("div", {}, [
      h("span", { class: `pill ${cls === "allow" ? "ok" : cls === "deny" ? "err" : "warn"}` }, [
        h("span", { class: "dot" }, []),
        c.decision.toUpperCase(),
      ]),
      " ",
      h("span", { style: { fontFamily: "var(--mono)", color: "var(--text)" } }, [c.tool]),
    ]),
    h("div", { class: "kv" }, [
      h("span", {}, ["risk"]),
      h("b", {}, [c.risk ?? riskFromRule(c.rule)]),
      h("span", {}, ["environment"]),
      h("b", {}, [c.environment ?? "—"]),
      h("span", {}, ["rule"]),
      h("b", {}, [c.rule || "—"]),
      h("span", {}, ["reason"]),
      h("b", {}, [c.reason || "—"]),
      h("span", {}, ["trace"]),
      h("b", {}, [c.traceId]),
    ]),
  ]);
}

function riskFromRule(rule: string): string {
  if (!rule) return "—";
  if (rule.includes("prohibited")) return "prohibited";
  if (rule.includes("high")) return "high";
  if (rule.includes("medium")) return "medium";
  if (rule.includes("low")) return "low";
  if (rule.includes("read")) return "read";
  return "—";
}

function approvalQueue(): HTMLElement {
  const pending = state.approvals.filter((a) => a.status === "pending");
  if (pending.length === 0) {
    return h(
      "div",
      { class: "empty-state" },
      ["No pending approvals."],
    );
  }
  return h(
    "div",
    {},
    pending.map((a) =>
      h("div", { class: "approval-card approval" }, [
        h("div", {}, [
          h("span", { class: "badge high" }, [a.risk]),
          h("span", { style: { fontFamily: "var(--mono)", color: "var(--text)" } }, [a.toolName]),
        ]),
        h("div", { class: "kv" }, [
          h("span", {}, ["environment"]),
          h("b", {}, [a.environment ?? "—"]),
          h("span", {}, ["service"]),
          h("b", {}, [a.service ?? "—"]),
          h("span", {}, ["reason"]),
          h("b", {}, [a.reason]),
          h("span", {}, ["args"]),
          h("b", {}, [JSON.stringify(a.input)]),
          h("span", {}, ["trace"]),
          h("b", {}, [a.traceId]),
        ]),
        h("div", { style: { display: "flex", gap: "8px", marginTop: "6px" } }, [
          h(
            "button",
            {
              class: "btn deny",
              onclick: async () => {
                await api.denyApproval(a.approvalId);
                await refreshAll();
              },
            },
            ["Deny"],
          ),
          h(
            "button",
            {
              class: "btn approve",
              onclick: async () => {
                await api.approveApproval(a.approvalId);
                await refreshAll();
              },
            },
            ["Approve"],
          ),
        ]),
      ]),
    ),
  );
}

function auditTimeline(): HTMLElement {
  const rows = mergedAuditRows();
  if (rows.length === 0) {
    return h(
      "div",
      { class: "empty-state" },
      ["Audit trail is empty."],
    );
  }
  return h(
    "div",
    { class: "timeline" },
    rows.map((r) => {
      const cls =
        r.kind === "control"
          ? "control"
          : r.decision === "allow"
            ? "allow"
            : r.decision === "deny"
              ? "deny"
              : "approval";
      const decision =
        r.kind === "control" ? r.status.toUpperCase() : (r.decision ?? "").toUpperCase();
      return h("div", { class: `timeline-row ${cls}` }, [
        h("span", {}, [new Date(r.ts).toLocaleTimeString()]),
        h("span", { class: "tool" }, [r.tool]),
        h("span", {}, [
          r.kind === "control"
            ? `CONTROL · ${r.status} (${r.detail ?? ""})`
            : `SIGNED · ${r.rule ?? ""}: ${r.reason ?? ""}`,
          " · trace ",
          r.traceId,
        ]),
        h("span", { class: `decision ${cls}` }, [decision]),
      ]);
    }),
  );
}

interface AuditRow {
  ts: string | number;
  kind: "signed" | "control";
  tool: string;
  decision?: string;
  status?: string;
  rule?: string;
  reason?: string;
  detail?: string;
  traceId: string;
}

function mergedAuditRows(): AuditRow[] {
  const signed: AuditRow[] = state.audit.ledger.map((r: any) => ({
    ts: r.ts,
    kind: "signed",
    tool: r.tool,
    decision: r.decision,
    rule: r.policy?.rule,
    reason: r.policy?.reason,
    traceId: r.trace_id,
  }));
  const control: AuditRow[] = state.audit.approvalEvents.map((e: any) => ({
    ts: typeof e.ts === "number" ? new Date(e.ts).toISOString() : e.ts,
    kind: "control",
    tool: e.toolName,
    status: e.status,
    detail: e.detail,
    traceId: e.traceId,
  }));
  let rows = [...signed, ...control].sort(
    (a, b) => String(a.ts).localeCompare(String(b.ts)),
  );
  if (state.auditFilter === "allow") rows = rows.filter((r) => r.decision === "allow");
  else if (state.auditFilter === "deny")
    rows = rows.filter((r) => r.decision === "deny");
  else if (state.auditFilter === "approval")
    rows = rows.filter(
      (r) => r.kind === "control" || r.status === "pending" || r.status === "approved",
    );
  return rows.slice(-40).reverse();
}

function policyDrawer(): HTMLElement {
  const snapshot = state.policySnapshot;
  return h(
    "div",
    {
      class: "drawer-backdrop",
      onclick: (e: Event) => {
        if ((e.target as HTMLElement).classList.contains("drawer-backdrop")) {
          state.policyDrawerOpen = false;
          render();
        }
      },
    },
    [
      h("div", { class: "drawer" }, [
        h("div", { class: "drawer-header" }, [
          h("span", { class: "title" }, [
            snapshot ? snapshot.policy.id : "policy",
            " · v",
            snapshot ? String(snapshot.policy.version) : "?",
            " · default: ",
            snapshot ? snapshot.policy.default : "?",
          ]),
          h(
            "button",
            {
              class: "btn ghost",
              onclick: () => {
                state.policyDrawerOpen = false;
                render();
              },
            },
            ["Close"],
          ),
        ]),
        h("div", { class: "drawer-body" }, [
          h("div", { class: "subtle-note" }, [
            "This is the policy the Custos Gate actually loaded. Every WebMCP tool call is evaluated against these rules — first match wins. The tool matrix below is generated by running the classifier + policy for every tool × environment.",
          ]),
          h("h3", {}, ["Rules"]),
          snapshot ? rulesTable(snapshot) : loadingRow(),
          h("h3", {}, ["Tool decision matrix"]),
          snapshot ? toolsTable(snapshot) : loadingRow(),
        ]),
      ]),
    ],
  );
}

function loadingRow(): HTMLElement {
  return h("div", { class: "subtle-note" }, ["Loading…"]);
}

function rulesTable(s: PolicySnapshot): HTMLElement {
  return h("table", { class: "rules-table" }, [
    h("thead", {}, [
      h("tr", {}, [
        h("th", {}, ["#"]),
        h("th", {}, ["Rule id"]),
        h("th", {}, ["Decision"]),
        h("th", {}, ["When"]),
        h("th", {}, ["Reason"]),
      ]),
    ]),
    h(
      "tbody",
      {},
      s.policy.rules.map((r, i) =>
        h("tr", {}, [
          h("td", {}, [String(i + 1)]),
          h("td", {}, [h("b", {}, [r.id])]),
          h("td", {}, [
            h("span", { class: `decision-tag ${r.decision}` }, [r.decision]),
          ]),
          h("td", { class: "rule-when" }, [formatWhen(r.when)]),
          h("td", {}, [r.reason]),
        ]),
      ),
    ),
  ]);
}

function formatWhen(when: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(when)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      parts.push(`${k} ${Object.entries(v as Record<string, unknown>).map(([op, arg]) => `${op}=${JSON.stringify(arg)}`).join(" ")}`);
    } else {
      parts.push(`${k}=${JSON.stringify(v)}`);
    }
  }
  return parts.join("\n");
}

function toolsTable(s: PolicySnapshot): HTMLElement {
  const decisionTag = (d: string, ruleId: string) => {
    const label = d === "allow" ? "ALLOW" : d === "deny" && ruleId === ""
      ? "APPROVAL"
      : d === "deny" && !ruleId.includes("hard-deny") && !ruleId.includes("prohibited")
        ? "APPROVAL"
        : d.toUpperCase();
    const cls =
      d === "allow" ? "allow"
      : label === "APPROVAL" ? "approval"
      : "deny";
    return h("span", { class: `decision-tag ${cls}` }, [label]);
  };
  return h("table", { class: "tools-table" }, [
    h("thead", {}, [
      h("tr", {}, [
        h("th", {}, ["Tool"]),
        h("th", {}, ["Env"]),
        h("th", {}, ["Risk"]),
        h("th", {}, ["Without approval"]),
        h("th", {}, ["With approval"]),
        h("th", {}, ["Rule"]),
      ]),
    ]),
    h(
      "tbody",
      {},
      s.tools.map((t) =>
        h("tr", {}, [
          h("td", {}, [h("b", {}, [t.tool])]),
          h("td", {}, [t.environment]),
          h("td", {}, [
            h("span", { class: `badge ${riskBadgeCls(t.risk)}` }, [t.risk]),
          ]),
          h("td", {}, [decisionTag(t.withoutApproval.decision, t.withoutApproval.ruleId)]),
          h("td", {}, [decisionTag(t.withApproval.decision, t.withApproval.ruleId)]),
          h("td", {}, [t.withApproval.ruleId || t.withoutApproval.ruleId || "—"]),
        ]),
      ),
    ),
  ]);
}

function riskBadgeCls(risk: string): string {
  if (risk === "prohibited") return "prohibited";
  if (risk === "high") return "high";
  if (risk === "medium") return "med";
  if (risk === "low") return "low";
  return "read";
}

function footer(): HTMLElement {
  return h("div", { class: "footer-note" }, [
    state.webmcp.supported
      ? "This site is exposing 8 tools via WebMCP. Every call routes through Custos policy + approval + signed ledger."
      : state.webmcp.message,
  ]);
}

// ---------- boot ----------

bootstrap().catch((err) => {
  const root = document.getElementById("root")!;
  root.textContent = "Failed to start: " + (err instanceof Error ? err.message : String(err));
});
