# basic-mcp-policy

The smallest useful Custos example: a single `read_file` tool guarded by one
allow rule (paths under `/workspace/`) with an implicit `deny` fallback for
everything else. No proxy, no server — just the in-process SDK Gate.

## Prereqs

```bash
pip install -e ../../packages/custos-py
npm install --prefix ../../packages/custos-js
```

## Run

```bash
python run.py
# or
node run.mjs
```

## What you should see

`/workspace/notes.txt` is allowed by rule `allow-workspace-reads`.
`/etc/passwd` is denied by the policy default. Both decisions are appended
to `.custos/ledger.jsonl` — see `expected-output.txt` for the exact shape.
