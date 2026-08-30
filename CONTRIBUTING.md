# Contributing to Custos

Thanks for your interest. Custos is small on purpose — the whole thing fits in
your head. Bug fixes, docs improvements, new adapters, and policy DSL work are
all welcome.

Please read [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) and, for anything
security-adjacent, [SECURITY.md](SECURITY.md) first.

## Quickstart

```bash
# 1. Fork + clone
git clone https://github.com/<you>/custos.git
cd custos

# 2. Python package
cd packages/custos-py
pip install -e ".[dev,web,otel]"
python -m pytest
cd ../..

# 3. Node package
cd packages/custos-js
npm ci
npm test
npm run build
cd ../..

# 4. Cross-language parity harness (must be green before you push)
bash tests/cross-lang/run.sh
```

If cross-lang is red on `main`, that is a blocker — please file an issue.

## Project layout

```
packages/custos-py/    Python SDK + CLI (published as `custos-mcp` on PyPI)
packages/custos-js/    Node SDK + CLI  (published as `@custos/mcp` on npm)
spec/WIRE.md           Source of truth for the on-disk / on-the-wire format
tests/cross-lang/      Language-parity harness — proves both runtimes agree
docs/                  Long-form docs, RFCs
examples/              End-to-end demos
services/              Optional sidecars (dashboard, proxy)
```

**`spec/WIRE.md` is the contract.** Both packages implement it. If you are ever
unsure which behavior is correct, the spec wins.

## Ground rules

### Wire compatibility

Any change to what is written to disk or sent on the wire (ledger records,
bundle layout, canonical JSON, adapter envelope) requires:

1. `spec/WIRE.md` updated **first**, in the same PR or an earlier one.
2. Both `custos-py` and `custos-js` updated in the same PR.
3. `bash tests/cross-lang/run.sh` passing.

Bumping the wire schema version without going through this checklist will be
sent back.

### Backwards compatibility

Don't rename or remove without a deprecation path:

- Public exports (`custos.<symbol>` in Python, top-level exports in Node)
- CLI commands and flags
- Config file locations (`.custos/`, `custos.yaml`, etc.)
- Environment variable names

If you need to break one of these, deprecate it for one minor release first
(warn at runtime, document in `CHANGELOG.md`) and remove in the next.

### Feature parity

If a feature lands in one runtime, it should land in the other in the same PR
or open a tracking issue for the follow-up. Silent drift between the two
packages is the failure mode we care most about avoiding.

### Determinism

Canonical JSON must be byte-identical between Python and Node. If you touch
`canonical.py` or `canonical.ts`, add a matching cross-lang assertion in
`tests/cross-lang/`.

## Code style

- **Python:** `ruff` for lint and format. Type hints required on public API.
- **TypeScript:** strict mode. No `any` on public API without a comment saying
  why.
- **No new runtime dependencies without justification.** Custos has a small
  dependency footprint on purpose — every extra dep is a supply-chain surface.
  Dev-only deps are fine.

## Tests

- Add a test for every new public method or CLI command.
- Security-sensitive code (policy evaluation, ledger writes, signature
  verification) needs a **negative** test as well as a positive one: assert
  that the deny path denies, that the tamper path is detected.
- Cross-lang parity tests live in `tests/cross-lang/`. Add one whenever you
  touch the wire format.

## Commit style

Conventional commits, please:

- `feat: ...` — new capability
- `fix: ...` — bug fix
- `docs: ...` — README, SPEC, RFCs
- `test: ...` — tests only
- `chore: ...` / `chore(deps): ...` — build, CI, dependency bumps
- `refactor: ...` — no behavior change

Scope is optional but helpful for monorepo work: `feat(py): ...`,
`fix(js): ...`, `docs(spec): ...`.

## Proposing a wire-format change

Wire changes are the highest-risk changes in the repo. Please:

1. Open a discussion issue describing the problem and the sketch.
2. Once the shape is agreed, land an RFC as `docs/rfcs/NNNN-title.md`
   (next unused number). The RFC captures rationale, alternatives considered,
   and a migration plan.
3. Update `spec/WIRE.md`.
4. Ship the PR — both packages, cross-lang harness green, `CHANGELOG.md`
   entry.

Small clarifications to `spec/WIRE.md` (typos, tightened wording that does
not change behavior) do not need an RFC.

## Filing bugs

See the issue templates. The single most useful thing you can include is the
ledger record (redacted where needed) and the policy that produced the
surprising decision — that is usually enough to reproduce.
