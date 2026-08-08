"""Python verifies a ledger written by Node."""
import json
import sys

from custos.verify import verify_ledger

r = verify_ledger(sys.argv[1])
print(json.dumps({"ok": r.ok, "records": r.records, "errors": r.errors}))
sys.exit(0 if r.ok else 1)
