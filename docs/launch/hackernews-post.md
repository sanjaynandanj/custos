# Hacker News — Show HN

## Title

Show HN: Custos — policy enforcement + audit ledger for AI agent tool calls

## Body

I have been shipping agents that read files, hit APIs, and run shell commands. There is no obvious authorization layer in that stack — the agent has whatever tools the framework binds, called with whatever arguments the model produces, and no signed record of what actually ran. Custos is what I ended up building to close that gap.

It is a Policy Enforcement Point with a native Policy Decision Point and a cryptographic audit ledger. Every tool call goes through a small YAML policy (`prefix` / `regex` / `in` / `exists` / etc, deny-by-default, first-match-wins) before it executes. Every decision — allow, deny, error — is appended to an Ed25519-signed, SHA-256 hash-chained JSONL file that can be verified offline with just the file and the public key.

Integration surfaces are the interesting bit: a stdio MCP proxy (drop in front of any MCP server), an in-process Gate SDK, a LangGraph adapter, and a Claude Agent SDK adapter. Python and Node packages share one wire format — sign in Python, verify in Node.

What Custos is not: not a runtime sandbox, not a network firewall, not a model guardrail. It is authorization + audit, specifically for the tool-call step. On an allow, the tool still runs whatever it wants; Custos records the fact that it ran.

Apache-2.0. Tests cross-verify Python and Node ledgers against each other.

v0.3.0 shipped today. Would love feedback — particularly on the policy DSL and on which framework adapters people actually need next.

https://github.com/sanjaynandanj/custos
