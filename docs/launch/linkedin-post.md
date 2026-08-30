# LinkedIn — Custos v0.3.0

AI agents are getting scary powerful. They read files, hit APIs, run shell commands, query production databases. In most stacks today, there is no policy check before a tool runs and no signed record after. If an agent goes off the rails, you cannot prove what happened.

I have been building Custos to close that gap. It is a policy enforcement layer and cryptographic audit ledger for AI agent tool calls — deny-by-default policy evaluated before every call, plus an Ed25519-signed, hash-chained ledger you can hand to an auditor.

v0.3.0 is out today. Highlights:

- Bearer-token auth for the live dashboard
- Tamper-evident policy snapshots inside evidence bundles
- Repositioned around any tool-calling agent framework, not just MCP — first-class adapters for LangGraph and the Claude Agent SDK, in-process SDK for custom loops
- New threat-model doc and integration walkthroughs

Open source, Apache-2.0, Python + Node in the same wire format. Would love feedback from anyone shipping agents into environments where "trust me, it was fine" is not an acceptable audit trail.

https://github.com/sanjaynandanj/custos
