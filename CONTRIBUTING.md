# Contributing to custos

Thanks for your interest! Custos is small on purpose — the whole thing fits in your head. Contributions welcome for bugs, docs, and DSL / adapter additions.

## Ground rules

1. **Wire spec is the contract.** Any change to what's on disk or on the wire must update `spec/WIRE.md` first, then both packages, then `tests/cross-lang/run.sh` must pass.
2. **Feature parity.** If it lands in one runtime, it should either land in the other in the same PR or open an issue for the follow-up.
3. **Determinism.** Canonical JSON must be byte-identical between Python and Node. If you touch `canonical.py` or `canonical.ts`, add a matching cross-lang assertion.

## Dev loop

```bash
# Python
cd packages/custos-py
pip install -e .[dev,web,otel]
python -m pytest

# Node
cd packages/custos-js
npm ci
npm test
npm run build

# Cross-lang
bash tests/cross-lang/run.sh
```

## Filing bugs

Include the ledger record (redacted) and the policy that produced the surprising decision. That's usually enough to reproduce.
