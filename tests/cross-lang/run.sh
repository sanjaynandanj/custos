#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
WORK="$(mktemp -d 2>/dev/null || mktemp -d -t custos-x)"
echo "workdir: $WORK"

echo "--- Python writes ledger ---"
python "$DIR/py_write.py" "$WORK/py"

echo "--- Node verifies Python ledger ---"
node "$DIR/js_verify.mjs" "$WORK/py/ledger.jsonl"

echo "--- Node writes ledger ---"
node "$DIR/js_write.mjs" "$WORK/js"

echo "--- Python verifies Node ledger ---"
python "$DIR/py_verify.py" "$WORK/js/ledger.jsonl"

echo "cross-language OK"
