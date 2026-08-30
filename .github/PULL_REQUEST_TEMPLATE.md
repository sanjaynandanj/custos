<!--
Thanks for the PR! Please fill out each section. Keep it concise —
"why" matters more than "what" (the diff shows what).
-->

## Summary

<!-- 1-3 sentences: what changed and why. -->

## Type

- [ ] Bug fix
- [ ] Feature
- [ ] Docs
- [ ] Refactor
- [ ] Test
- [ ] Chore / build / CI

## Breaking changes?

- [ ] No
- [ ] Yes — described below

<!--
If yes: describe the breakage and the migration path.

Reminder: wire-format changes (anything on disk or on the wire —
ledger records, bundle layout, canonical JSON) and public-API changes
(exported symbols, CLI commands, CLI flags, config file locations)
require an RFC in `docs/rfcs/` and both packages updated in the same PR.
See CONTRIBUTING.md.
-->

## How was this tested?

- [ ] `pytest` (Python package)
- [ ] `npm test` (Node package)
- [ ] `bash tests/cross-lang/run.sh` (cross-language parity)
- [ ] Manual (describe below)
- [ ] Not applicable (docs-only, etc.)

<!-- Notes on test coverage, edge cases, or manual steps if any. -->

## Docs updated?

- [ ] README
- [ ] `spec/WIRE.md`
- [ ] `CHANGELOG.md`
- [ ] Not applicable

## Related issues

<!-- e.g. Closes #123, Refs #456 -->
