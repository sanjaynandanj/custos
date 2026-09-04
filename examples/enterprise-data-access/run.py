"""Mock `db_query` tool guarded by a Custos SELECT-only policy."""
import shutil
from pathlib import Path
from custos import Actor, Gate, Ledger, Server, generate_keypair, load_policy

here = Path(__file__).parent
workdir = here / ".custos"
if workdir.exists():
    shutil.rmtree(workdir)
kp = generate_keypair()
kp.save(workdir)
ledger = Ledger(workdir / "ledger.jsonl", kp)
policy = load_policy(here / "policy.yaml")
gate = Gate(policy, ledger, Actor("analyst-42"), Server("warehouse", pubkey=kp.public_b64()))


def db_query(sql: str):
    """A real impl would hand this to sqlalchemy/pg8000. Here we just echo."""
    return {"rows": [], "sql_ran": sql}


queries = [
    "SELECT id, total FROM orders WHERE ts > now() - interval '1 day' LIMIT 100",  # allow
    "INSERT INTO orders (id, total) VALUES (1, 9.99)",                             # deny (write verb)
    "DROP TABLE customers",                                                        # deny (DDL)
    "SELECT * FROM invoices",                                                      # deny (no LIMIT)
]

for sql in queries:
    r = gate.call("db_query", {"sql": sql}, fn=db_query)
    tag = "ALLOW" if r.allowed else "DENY "
    short = sql if len(sql) < 60 else sql[:57] + "..."
    print(f"{tag}  {short}\n        rule={r.rule or '-'}  reason={r.reason}\n")

print(f"ledger records: {ledger.seq}   head: {ledger.head}")
