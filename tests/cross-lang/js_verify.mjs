// Node verifies a ledger written by Python.
import { verifyLedger } from "../../packages/custos-js/dist/index.js";
const r = verifyLedger(process.argv[2]);
console.log(JSON.stringify(r));
process.exit(r.ok ? 0 : 1);
