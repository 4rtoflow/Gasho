import os from "node:os";
import { dbFileOf, loadConfig } from "./config.ts";
import { Hub } from "./hub.ts";
import { buildAllowList } from "./netallow.ts";
import { createServer } from "./server.ts";
import { Store } from "./store.ts";

const usage = `usage:
  node src/cli.ts start            start the Gasho server
  node src/cli.ts pair             issue a registration code (valid for 10 minutes, single use)
  node src/cli.ts devices          list registered browsers and working servers
  node src/cli.ts revoke <id>      revoke a registration (the server disconnects it within 30 s)`;

function lanAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i?.address ?? "");
}

function start(): void {
  const cfg = loadConfig();
  const store = new Store(cfg.dbFile);
  store.prune();
  setInterval(() => store.prune(), 3600_000).unref();
  const hub = new Hub(store);
  const server = createServer({ hub, store, webDist: cfg.webDist, allow: buildAllowList(cfg.allowNets) });
  server.listen(cfg.port, cfg.host, () => {
    const log = (s: string) => console.log(`${new Date().toISOString()} [gasho-hub] ${s}`);
    log(`listening on ${cfg.host}:${cfg.port} (db: ${cfg.dbFile})`);
    log(`allowed networks: ${cfg.allowNets.join(", ")}`);
    if (cfg.host === "0.0.0.0") for (const a of lanAddresses()) log(`open http://${a}:${cfg.port} from the LAN`);
    if (store.listDevices().length === 0) log('no devices are registered yet; run "npm run hub:pair" to get a code');
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      server.close();
      store.close();
      process.exit(0);
    });
  }
}

const args = process.argv.slice(2);
switch (args[0] ?? "start") {
  case "start":
    start();
    break;
  case "pair": {
    const store = new Store(dbFileOf());
    const { code, expiresAt } = store.createPairingCode("cli");
    store.close();
    console.log(`registration code: ${code}`);
    console.log(`valid until ${new Date(expiresAt).toLocaleString()} (single use)`);
    console.log("- browser: open the Gasho server and enter the code");
    console.log("- working server: node apps/daemon/src/cli.ts register --server http://<this server>:7740 --code <code>");
    break;
  }
  case "devices": {
    const store = new Store(dbFileOf());
    for (const d of store.listDevices()) {
      const seen = d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : "never";
      console.log(`${d.id}  ${d.kind.padEnd(7)}  ${d.name}  (last seen: ${seen})`);
    }
    store.close();
    break;
  }
  case "revoke": {
    const id = args[1];
    if (!id) {
      console.error(usage);
      process.exitCode = 2;
      break;
    }
    const store = new Store(dbFileOf());
    console.log(store.revokeDevice(id) ? `revoked ${id}` : `no active device ${id}`);
    store.close();
    break;
  }
  default:
    console.error(usage);
    process.exitCode = 2;
}
