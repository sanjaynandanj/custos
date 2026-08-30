# Integrating Custos with Claude Code

Claude Code is an MCP client. Any MCP server it uses can be wrapped by the Custos stdio proxy, giving you policy enforcement and a signed audit ledger for every tool call the agent makes — without modifying the server or Claude Code itself.

This walkthrough uses `@modelcontextprotocol/server-filesystem` as a concrete example. The same pattern works for any stdio-transport MCP server.

## Prerequisites

- Node 18+
- Claude Code CLI installed (`claude` on PATH)
- An MCP server to protect — we use `@modelcontextprotocol/server-filesystem`

> Custos supports **stdio** MCP transport today. HTTP/SSE transport is on the roadmap.

## Step 1 — Install Custos

```bash
npm install -g custos-mcp
```

## Step 2 — Scaffold `.custos/`

```bash
npx custos init
```

This creates `.custos/` with an Ed25519 keypair (`ledger.key`, `ledger.pub`), a starter `policy.yaml`, and a `.gitignore` that keeps the private key out of git.

## Step 3 — Write a filesystem policy

Save the following as `policy.yaml` (or edit the scaffolded `.custos/policy.yaml`):

```yaml
version: 1
id: fs-policy
default: deny
rules:
  - id: no-traversal
    when:
      args.path: {contains: ".."}
    decision: deny
    reason: path traversal blocked

  - id: deny-etc
    when:
      args.path: {prefix: "/etc/"}
    decision: deny
    reason: /etc is off-limits

  - id: allow-workspace-read
    when:
      tool: {in: ["read_file", "read_text_file", "list_directory"]}
      args.path: {prefix: "/Users/you/workspace/"}
    decision: allow
    reason: workspace reads OK

  - id: deny-writes-outside-workspace
    when:
      tool: {regex: "^(write|edit|move|create).*"}
      args.path: {not_in: ["/Users/you/workspace/scratch"]}
    decision: deny
    reason: writes only allowed in /workspace/scratch
```

Sanity-check the policy:

```bash
npx custos show-policy policy.yaml
```

## Step 4 — Wrap the MCP server in `.mcp.json`

Claude Code reads MCP servers from `.mcp.json` (project-local) or `~/.claude.json` (user-wide). Point the `command` at Custos and pass the real server after `--`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "custos-mcp", "proxy",
        "--policy", "policy.yaml",
        "--actor-id", "claude-code",
        "--",
        "npx", "-y", "@modelcontextprotocol/server-filesystem", "/Users/you/workspace"
      ]
    }
  }
}
```

What Claude Code sees: an MCP server called `filesystem`. What actually runs: Custos speaks MCP on stdio to Claude Code, forwards each `tools/call` through the policy, and (if allowed) forwards it downstream to the real filesystem server. All decisions land in `.custos/ledger.jsonl`.

## Step 5 — Restart Claude Code and try it

Restart the Claude Code session so it re-reads `.mcp.json`. Then:

- **Allowed:** ask Claude to read `/Users/you/workspace/README.md`. Succeeds. Ledger gets an ALLOW record.
- **Denied:** ask Claude to write to `/etc/hosts`. Claude Code surfaces an MCP error like `-32001: custos denied [deny-etc]: /etc is off-limits`. The model sees the error text and typically explains it back to you rather than crashing.

## Step 6 — Inspect the ledger live

In another terminal:

```bash
TOKEN=$(openssl rand -hex 16)
npx custos serve --ledger .custos/ledger.jsonl --token "$TOKEN"
```

Open `http://127.0.0.1:8787` and pass the bearer token. You'll see a real-time allow / deny / error breakdown, per-tool counts, and a decision stream. Bearer-token auth landed in v0.3.0 — if the token is set, unauthenticated requests get `401`.

## Step 7 — Verify the chain

```bash
npx custos verify --ledger .custos/ledger.jsonl
```

Prints `OK N records verified` if every signature and every `prev_hash` link is intact. Tamper with any byte in `ledger.jsonl` and this fails.

For a portable evidence bundle to hand to auditors:

```bash
npx custos bundle --ledger .custos/ledger.jsonl --policies . evidence.tar.gz
npx custos verify-bundle evidence.tar.gz
```

The bundle contains the ledger, the public key, the policy snapshot, and a signed manifest. `verify-bundle` runs the full chain check plus verifies the manifest signature. In v0.3.0 the manifest records a `policies_hash` so tampering with the bundled policy is detectable too.

## Troubleshooting

**"Server disconnected" in Claude Code**
Claude Code launched the wrapper but the wrapper died. Common causes:
- `npx custos-mcp` isn't on PATH in the environment Claude Code sees. Try `command: "/usr/local/bin/npx"` with an absolute path, or install `custos-mcp` globally.
- The downstream MCP command fails on startup. Run the full command manually — `npx custos-mcp proxy --policy policy.yaml -- npx -y @modelcontextprotocol/server-filesystem /Users/you/workspace` — and read the stderr.

**Every tool call gets denied**
The policy `default: deny` is doing what it says and no rule matched. Run `npx custos show-policy policy.yaml` to see how each rule normalizes, then tail `.custos/ledger.jsonl` — each deny record includes the rule that matched (or `default` if nothing did). Add an allow rule that matches the tool + args the agent is actually calling.

**Dashboard returns 401**
You started `custos serve --token <T>` — the dashboard now requires `Authorization: Bearer <T>` on every request. Either pass the header, or omit `--token` for local trusted use.
