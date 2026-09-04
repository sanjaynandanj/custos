# enterprise-data-access

Governs an agent's `db_query` tool with three rules that a data-platform team
would recognise:

1. **SELECT only.** INSERT/UPDATE/DELETE/DROP/TRUNCATE/ALTER/GRANT/REVOKE/CREATE
   are denied with a specific reason (not just a generic default-deny).
2. **Table whitelist.** The FROM clause must reference `orders`, `customers`,
   or `invoices` (with an optional `public.` schema prefix).
3. **LIMIT required.** SELECTs without a `LIMIT N` clause are denied so a
   runaway agent cannot pull the whole warehouse.

All checks are regex on `args.sql`. This is intentionally a **defence-in-depth
layer**, not a SQL firewall: a real deployment should also point the agent at
a role-scoped read-only DB user. Custos gives you the pre-execution veto plus
the tamper-evident audit trail.

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

Four queries execute: one SELECT with LIMIT is allowed; an INSERT, a DROP,
and a SELECT without LIMIT are denied — each with a specific rule id and
reason in the ledger.

## Related docs

- `AUDIT.md` — what the resulting ledger records look like, plus `custos verify` output.
- `INTEGRATION.md` — how to wire this Gate into a real app around sqlalchemy,
  pg8000, or knex.

## Roadmap

The policy's header comment calls out that per-actor row caps and multi-request
row-count budgets are not currently expressible in the DSL. Enforce those in
the tool implementation until Custos ships stateful `budget:` rules.
