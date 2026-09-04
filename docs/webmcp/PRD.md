# PRD — Custos WebMCP

## 1. Product

**Name:** Custos WebMCP
**Tagline:** *The policy, human-approval and audit layer for the agent-native web.*

Custos WebMCP extends the existing Custos governance engine with a browser-side
adapter for the [WebMCP](https://webmachinelearning.github.io/webmcp/) standard,
so any website that exposes tools to AI agents can insert an explicit policy,
approval, and cryptographic audit boundary between the agent and the
authenticated application.

## 2. Problem

WebMCP lets an authenticated website register real, structured actions with an
in-browser AI agent via `document.modelContext.registerTool(...)`. That creates
a new trust boundary:

```
User → AI Agent → WebMCP Tool → Authenticated Web Application → Real action
```

Without governance the agent can:

- execute destructive actions under the user's session,
- misunderstand application state,
- follow prompt-injection from application data,
- call tools with dangerous or malformed arguments,
- make irreversible changes,
- act without pausing for human judgment,
- leave insufficient audit evidence.

Custos WebMCP adds a policy-first Gate + explicit human approval + signed
Custos ledger between the WebMCP registration and the domain operation.

## 3. Target users

**Primary**
- Developers building agent-native web applications.
- SaaS teams exposing authenticated actions to AI agents.
- Security / platform teams responsible for agent enablement.

**Secondary**
- Compliance and AI-governance teams.
- SRE / platform engineering teams that will operate agent-enabled apps.

## 4. Core user stories

**Developer.** *As a developer exposing WebMCP tools, I want sensitive actions
policy-gated so that an agent cannot directly perform unrestricted actions.*

**Human operator.** *As an authenticated human, I want high-risk actions to
pause for my approval while safe actions continue automatically.*

**Security engineer.** *As a security engineer, I want every executed or
denied action recorded in a signed ledger so I can reconstruct agent
behavior.*

**AI agent.** *As an agent, I want structured tools with clear semantics and
predictable results rather than guessing through UI interactions.*

## 5. Demo product — Custos Agent Operations Control Room

A realistic simulated SaaS operations console. Three environments:

```
development · staging · production
```

Seed services: `api-gateway`, `auth-service`, `payment-service`,
`notifications`, `analytics-worker`.

`payment-service` in production is seeded with a deterministic incident:

```
version 2.4.1
status  degraded
latency elevated
errors  elevated
```

Rolling back to `2.3.9` fixes the incident.

**All infrastructure is simulated.** No real cloud API is called.

## 6. Feature set

| Capability | Result |
|---|---|
| List services / health / deployments / logs | Auto-allow, read-only |
| Restart in dev/staging | Auto-allow, mutating |
| Rollback in dev/staging | Auto-allow, mutating |
| Set env var in dev | Auto-allow |
| Restart / rollback / set env in **production** | **Human approval required** |
| Delete production environment | **Hard deny** |
| Malicious log content | Rendered as untrusted data, never executed |
| All decisions | Written to signed Custos ledger |

## 7. Product success criteria

A judge must, within ≈30 seconds:

1. see this website exposes WebMCP capabilities,
2. see an AI agent calling them,
3. see Custos evaluating each action,
4. see low-risk actions execute automatically,
5. see production-sensitive actions pause for human approval,
6. see prohibited actions blocked,
7. see everything land in an auditable trail.

## 8. Non-goals

- No real infrastructure / cloud / Kubernetes integration.
- No custom LLM or agent runtime — WebMCP does that in the browser.
- No new policy DSL — Custos native policy is reused unchanged.
- No changes to the Custos wire format or Python parity.
- No RBAC, billing, or user management beyond a single simulated operator.
