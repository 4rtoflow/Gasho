import { loadConfig } from "./config.ts";
import { Hub } from "./hub.ts";
import { createServer } from "./server.ts";
import { Store } from "./store.ts";

const cfg = loadConfig();
const store = new Store(cfg.dbFile);
store.prune();
setInterval(() => store.prune(), 3600_000).unref();

const hub = new Hub(store, cfg.token);
const server = createServer(hub, cfg.webDist);
server.listen(cfg.port, cfg.host, () => {
  console.log(`${new Date().toISOString()} [gasho-hub] listening on http://${cfg.host}:${cfg.port} (db: ${cfg.dbFile})`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close();
    store.close();
    process.exit(0);
  });
}
