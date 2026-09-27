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

# Cross-language parity of policy.hash: both writers load the identical
# policy dict, so they MUST produce the identical sha256 over canonical
# JSON. If these ever diverge, the canonicaliser has drifted between
# languages and every record's signed body will disagree.
echo "--- policy.hash parity ---"
# NOTE: pass paths as argv so MSYS (git-bash on Windows) translates POSIX
# paths into Windows paths at the argument boundary. Inline string literals
# inside `-c` are NOT translated, so hard-coding "$WORK/..." into the code
# breaks on Windows.
# Skip attestation records (Gate emits a startup attestation before the
# first decision — WIRE §2.3); scan for the first record whose `type` is
# absent or "decision", then read its policy.hash.
PY_HASH=$(python -c "
import json, sys
for line in open(sys.argv[1]):
    rec = json.loads(line)
    if rec.get('type', 'decision') == 'decision':
        print(rec['policy']['hash']); break
" "$WORK/py/ledger.jsonl")
JS_HASH=$(python -c "
import json, sys
for line in open(sys.argv[1]):
    rec = json.loads(line)
    if rec.get('type', 'decision') == 'decision':
        print(rec['policy']['hash']); break
" "$WORK/js/ledger.jsonl")
echo "py: $PY_HASH"
echo "js: $JS_HASH"
if [ "$PY_HASH" != "$JS_HASH" ]; then
  echo "FAIL: policy.hash mismatch across languages" >&2
  exit 1
fi

# Enforcement label parity: WIRE §2.2 requires both writers to emit the
# same canonical `enforcement` sub-object on SDK-produced records. If this
# drifts, `custos verify --replay` will still pass (signature covers the
# whole body) but downstream tools reading `enforcement.point` /
# `enforcement.effect` will disagree about what happened.
echo "--- enforcement label parity ---"
PY_ENF=$(python -c "
import json, sys
for line in open(sys.argv[1]):
    rec = json.loads(line)
    if rec.get('type', 'decision') == 'decision' and 'enforcement' in rec:
        print(json.dumps(rec['enforcement'], sort_keys=True)); break
" "$WORK/py/ledger.jsonl")
JS_ENF=$(python -c "
import json, sys
for line in open(sys.argv[1]):
    rec = json.loads(line)
    if rec.get('type', 'decision') == 'decision' and 'enforcement' in rec:
        print(json.dumps(rec['enforcement'], sort_keys=True)); break
" "$WORK/js/ledger.jsonl")
echo "py: $PY_ENF"
echo "js: $JS_ENF"
if [ "$PY_ENF" != "$JS_ENF" ]; then
  echo "FAIL: enforcement label mismatch across languages" >&2
  exit 1
fi

# Attestation record shape parity: WIRE §2.3 requires attestation records
# to have identical shape (fields + types) in both languages. Byte-value
# parity on `reason`, `policy_hash`, and the field set is the strongest
# deterministic assertion — ts/trace_id/span_id are per-invocation random
# and `active_actors` differs because the two writers use distinct actor
# IDs on purpose (they represent independent Custos instances).
echo "--- attestation record shape parity ---"
PY_ATT=$(python -c "
import json, sys
for line in open(sys.argv[1]):
    rec = json.loads(line)
    if rec.get('type') == 'attestation':
        att = rec['attestation']
        print(json.dumps({
            'reason': att['reason'],
            'policy_hash': att['policy_hash'],
            'fields': sorted(att.keys()),
        }, sort_keys=True))
        break
" "$WORK/py/ledger.jsonl")
JS_ATT=$(python -c "
import json, sys
for line in open(sys.argv[1]):
    rec = json.loads(line)
    if rec.get('type') == 'attestation':
        att = rec['attestation']
        print(json.dumps({
            'reason': att['reason'],
            'policy_hash': att['policy_hash'],
            'fields': sorted(att.keys()),
        }, sort_keys=True))
        break
" "$WORK/js/ledger.jsonl")
echo "py: $PY_ATT"
echo "js: $JS_ATT"
if [ "$PY_ATT" != "$JS_ATT" ]; then
  echo "FAIL: attestation record shape mismatch across languages" >&2
  exit 1
fi

# Approval + resolution pair parity (WIRE §2.4). Both writers emit an
# `approval` record for `restart_prod` and a follow-up with
# `decides_ref` set to the approval's record_hash. The parity assertion
# is not on byte-value equality (record_hash and ts differ across the
# two ledgers by construction) — it's that BOTH writers produce the
# same shape: an approval record with decides_ref absent, and a
# resolution record with decides_ref present and matching an earlier
# record_hash in the same ledger.
echo "--- approval + resolution pair parity ---"
for LABEL in py js; do
  LEDGER="$WORK/$LABEL/ledger.jsonl"
  SHAPE=$(python -c "
import json, sys
approval, resolution = None, None
by_hash = {}
for line in open(sys.argv[1]):
    rec = json.loads(line)
    if rec.get('type', 'decision') != 'decision':
        continue
    by_hash[rec['record_hash']] = rec
    if rec.get('decision') == 'approval' and not rec.get('decides_ref'):
        approval = rec
    if rec.get('decides_ref'):
        resolution = rec
assert approval is not None, 'no approval record found'
assert resolution is not None, 'no resolution record found'
assert 'decides_ref' not in approval, 'approval must not have decides_ref'
assert resolution['decides_ref'] in by_hash, 'decides_ref does not name a prior record'
assert by_hash[resolution['decides_ref']]['decision'] == 'approval', \
    'decides_ref points at a non-approval record'
assert resolution['tool'] == approval['tool'], 'tool mismatch on resolution'
assert resolution['args_hash'] == approval['args_hash'], 'args_hash mismatch on resolution'
assert resolution['trace_id'] == approval['trace_id'], 'trace_id mismatch on resolution'
assert resolution['policy']['rule'] == 'human-approval', 'rule must be human-approval'
print('OK')
" "$LEDGER")
  echo "$LABEL: $SHAPE"
done

echo "cross-language OK"
