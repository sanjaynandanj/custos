import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { createApp, startServer } from "./server.js";

const port = Number(process.env.PORT ?? 4173);
const host = process.env.HOST ?? "0.0.0.0";

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(here, "..");
const staticDir = resolve(rootDir, "public");
const ledgerDir = resolve(rootDir, ".custos");

const app = createApp({ ledgerDir, staticDir });
const boot = await startServer(app, port, host);
console.log(`[custos-webmcp] control room listening at ${boot.address}`);
console.log(`[custos-webmcp] static: ${staticDir}`);
console.log(`[custos-webmcp] ledger: ${ledgerDir}`);

process.on("SIGINT", async () => {
  console.log("[custos-webmcp] shutting down…");
  await boot.close();
  process.exit(0);
});
