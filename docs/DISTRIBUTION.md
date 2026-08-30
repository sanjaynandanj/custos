# Distribution plan

Strategic list of places to submit Custos to over time. **Not to be actioned automatically.** Every submission requires a personalized note and adherence to that community's posted guidelines. Spam kills.

## MCP directories and registries

- Official MCP servers repo — <https://github.com/modelcontextprotocol/servers> (Custos is a proxy, not a server per se; check if a `middleware` or `tools` section fits)
- `awesome-mcp` (community-maintained) — <https://github.com/punkpeye/awesome-mcp-servers> and similar forks
- TBD — search "MCP registry" / "MCP directory" quarterly; new ones show up regularly

## Awesome-lists on GitHub

- `awesome-mcp` — see above
- `awesome-ai-agents` — <https://github.com/e2b-dev/awesome-ai-agents>
- `awesome-ai-security` — <https://github.com/DeepSpaceHarbor/Awesome-AI-Security> and similar
- `awesome-llm-security` — GitHub search
- `awesome-authorization` / `awesome-policy-as-code` — GitHub search

Each list has its own PR guidelines. Read `CONTRIBUTING.md` before opening a PR.

## Policy engine communities

- **CNCF Slack** — `#cedar-policy`, `#opa`, `#security` channels; introduce Custos as a downstream consumer that ships Cedar / OPA adapters (currently experimental)
- **cedar-policy** — GitHub Discussions on <https://github.com/cedar-policy/cedar>
- **OPA** — Envoy / Kubernetes / conftest communities where OPA is already integrated
- **XACML / NIST ABAC** working groups — long-form fit; consider only after Custos has real deployments

## Blog / social

- **Hacker News** — Show HN post template at `docs/launch/hackernews-post.md`. Ship on a weekday morning US time. One shot; don't repost.
- **Reddit** — templates at `docs/launch/reddit-post.md`. Target r/LocalLLaMA, r/mcp, r/programming (careful — read subreddit rules), r/devops (only if angle is CI / audit), r/netsec (only if angle is authorization / audit).
- **Dev.to** — long-form technical write-up of the architecture doc + a "why we built this" piece
- **LinkedIn** — template at `docs/launch/linkedin-post.md`. Founder voice.
- **X / Twitter** — templates at `docs/launch/x-post.md`

## GitHub topics to add to the repo

Paste into the repo Topics field:

`mcp`, `authorization`, `policy-as-code`, `ai-agents`, `agent-security`, `governance`, `audit-trail`, `ed25519`, `opa`, `cedar`, `langgraph`, `claude-agent-sdk`, `pep`, `pdp`

## Conferences and talks

- **KubeCon + CloudNativeCon** — CFP fits if we frame Custos as authorization infra for AI workloads on k8s. TBD which cycle.
- **RSA Conference** — long lead time; only realistic after real production deployments.
- **DEF CON AI Village** — good fit for the threat-model angle. TBD.
- **MCP DevDay / MCP-focused meetups** — TBD if these exist as recurring events; check <https://modelcontextprotocol.io> for announcements.
- **PromptCon / LLM Ops meetups** — smaller venues, higher signal for early feedback.
- **QCon / Strange Loop / GOTO** — architecture-track fit for the wire-compatible ledger design.

## Rules

1. **Do not spam.** One submission per venue. If it doesn't land, wait for a real update.
2. **Personalize each submission.** Every awesome-list PR should show that you read the list. Every subreddit post should follow that sub's flair / format rules.
3. **Follow each community's guidelines.** Read `CONTRIBUTING.md`, sidebar rules, and posted PR conventions before opening anything.
4. **No fake accounts, no vote manipulation, no comment brigading.** Ever.
5. **Lead with the technical claim, not the marketing pitch.** The audience for Custos knows what a PEP is; talk to them like adults.
