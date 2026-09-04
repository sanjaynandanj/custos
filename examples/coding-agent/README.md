# coding-agent

Protects the tool surface an AI coding agent has: `read_file`, `write_file`,
`run_shell`, `git_commit`, `delete_file`. Custos allows normal iteration
(reading and writing common source-file extensions, running the test suite,
committing to a feature branch) and denies the destructive ops that a
misbehaving or prompt-injected agent might try.

## What the policy enforces

- Reads and writes restricted to `.py`, `.ts`, `.md`, `.json` files
- Path-traversal guard on writes (any `..` in the path)
- `run_shell` limited to an explicit whitelist: `pytest`, `npm test`, `ruff`,
  `tsc`, `git status`, `git diff`, `git log`
- `delete_file` always denied
- `git_commit` denied when `args.branch` is `main`, `master`, or `production`
- Everything else falls through to `default: deny`

See `NOTES.md` for the security discussion (what this does and does not stop).

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

Seven tool calls run; two allowed, five denied. Every decision is recorded
to `.custos/ledger.jsonl`.
