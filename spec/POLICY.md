# Custos Policy Cookbook

Practical patterns for the native policy DSL. See `WIRE.md` §6 for the full grammar.

## Deny by default, allow one tool

```yaml
version: 1
id: read-only-fs
default: deny
rules:
  - id: allow-read
    when: {tool: read_file}
    decision: allow
    reason: read-only workspace
```

## Path allowlist

```yaml
- id: workspace-only
  when:
    tool: read_file
    args.path: {prefix: "/workspace/"}
  decision: allow
```

## Deny path traversal

```yaml
- id: no-traversal
  when:
    args.path: {contains: ".."}
  decision: deny
  reason: path traversal attempt
```

## HTTP: GET-only, HTTPS-only, host allowlist

```yaml
- id: safe-http
  when:
    tool: http_request
    args.method: {in: ["GET", "HEAD"]}
    args.url: {regex: "^https://(api\\.example\\.com|docs\\.example\\.com)/"}
  decision: allow
```

## Actor-scoped rules

```yaml
- id: admin-shell
  when:
    tool: {regex: "^shell\\."}
    actor.id: "admin-*"
  decision: allow

- id: deny-shell
  when: {tool: {regex: "^shell\\."}}
  decision: deny
```

## Rate limiting (out of DSL scope)

Rate limiting lives in a separate middleware layer; the policy DSL is intentionally pure. See `custos.middleware.RateLimiter`.
