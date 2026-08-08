# Changelog

## 0.1.0 — 2026-08-08

Initial release. Both `custos-mcp` (Python) and `custos-mcp` (npm) at 0.1.0.

- Native policy DSL (`prefix`, `suffix`, `contains`, `regex`, `in`, `not_in`, `eq/ne/gt/lt/gte/lte`, `exists`, glob wildcards)
- Ed25519-signed, hash-chained JSONL ledger with tamper detection
- In-process `Gate` SDK — enforce and audit without running as a proxy
- Transparent stdio MCP proxy
- Dashboard on `:8787` in both runtimes
- Portable evidence bundles (`.tar.gz` with signed manifest)
- CLI: `keygen`, `proxy`, `verify`, `bundle`, `verify-bundle`, `serve`, `show-policy`
- Optional Cedar + OPA policy adapters (Python)
- Optional OpenTelemetry span emission (Python)
- Wire compatibility: Python-signed ledgers verify in Node and vice versa
