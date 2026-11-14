import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { dbFileOf, loadConfig, pluginsDirOf } from "./config.ts";
import { Hub } from "./hub.ts";
import { LatestCheck, npmLatest } from "./latest.ts";
import { buildAllowList } from "./netallow.ts";
import { PluginRegistry, readPluginFolder } from "./plugins.ts";
import { createServer } from "./server.ts";
import { Store } from "./store.ts";

const usage = `usage:
  node src/cli.ts start            start the Gasho server
  node src/cli.ts pair             issue a registration code (valid for 10 minutes, single use)
  node src/cli.ts devices          list registered browsers and working servers
  node src/cli.ts revoke <id>      revoke a registration (the server disconnects it within 30 s)
  node src/cli.ts plugin add <folder>          install a plugin (a built dist/ folder), replacing one with its id
  node src/cli.ts plugin add --link <folder>   install it as a link, for a plugin being developed (hot reload)
  node src/cli.ts plugin list                  list the installed plugins
  node src/cli.ts plugin remove <id>           remove a plugin, and the settings the Gasho server keeps for it
The running Gasho server picks up added, changed and removed plugins at once (GASHO_PLUGINS_DIR).`;

function lanAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i?.address ?? "");
}

async function start(): Promise<void> {
  const cfg = loadConfig();
  const store = new Store(cfg.dbFile);
  store.prune();
  setInterval(() => store.prune(), 3600_000).unref();
  const plugins = new PluginRegistry({
    dir: cfg.pluginsDir,
    cacheDir: cfg.pluginCacheDir,
    log: (s) => console.log(`${new Date().toISOString()} [gasho-hub] ${s}`),
  });
  await plugins.start().catch((e: unknown) => console.error(`[gasho-hub] cannot read the plugins in ${cfg.pluginsDir}`, e));
  // The latest published versions, with npm and the user's .npmrc (GASHO_LATEST_CHECK=off: not looked up).
  const npm = process.env.GASHO_NPM_BIN || (fs.existsSync(path.join(path.dirname(process.execPath), "npm")) ? path.join(path.dirname(process.execPath), "npm") : "npm");
  const latest = process.env.GASHO_LATEST_CHECK === "off" ? undefined : new LatestCheck({ lookup: (name) => npmLatest(npm, name) });
  const hub = new Hub(store, { plugins, latest });
  latest?.start();
  const server = createServer({ hub, store, webDist: cfg.webDist, allow: buildAllowList(cfg.allowNets), plugins });
  server.listen(cfg.port, cfg.host, () => {
    const log = (s: string) => console.log(`${new Date().toISOString()} [gasho-hub] ${s}`);
    log(`listening on ${cfg.host}:${cfg.port} (db: ${cfg.dbFile})`);
    log(`allowed networks: ${cfg.allowNets.join(", ")}`);
    log(`plugins: ${cfg.pluginsDir}`);
    if (cfg.host === "0.0.0.0") for (const a of lanAddresses()) log(`open http://${a}:${cfg.port} from the LAN`);
    if (store.listDevices().length === 0) log('no devices are registered yet; run "npm run hub:pair" to get a code');
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      plugins.close();
      latest?.close();
      server.close();
      store.close();
      process.exit(0);
    });
  }
}

/** hub:plugin add|list|remove: changes the plugins folder; a running Gasho server notices at once. */
async function plugin(argv: string[]): Promise<void> {
  const dir = pluginsDirOf();
  const [sub, ...rest] = argv;
  const fail = (message: string) => {
    console.error(message);
    process.exitCode = 1;
  };
  if (sub === "add") {
    const link = rest.includes("--link");
    const source = rest.find((a) => !a.startsWith("--"));
    if (!source) return fail(usage);
    const from = path.resolve(source);
    const read = await readPluginFolder(from, undefined);
    if ("error" in read) return fail(`${from}: ${read.error}`);
    const { id, name, version } = read.manifest;
    await fsp.mkdir(dir, { recursive: true });
    const target = path.join(dir, id);
    // Built aside and then swapped in, so that the Gasho server never reads a half-copied plugin.
    const tmp = path.join(dir, `.${id}-${process.pid}`);
    await fsp.rm(tmp, { recursive: true, force: true });
    if (link) await fsp.symlink(await fsp.realpath(from), tmp);
    else await fsp.cp(from, tmp, { recursive: true, dereference: true });
    const old = path.join(dir, `.${id}-old-${process.pid}`);
    if (fs.existsSync(target) || (await fsp.lstat(target).catch(() => undefined))) await fsp.rename(target, old);
    await fsp.rename(tmp, target);
    await fsp.rm(old, { recursive: true, force: true });
    console.log(`${link ? "linked" : "installed"} ${name} ${version} (${id}) in ${target}${link ? ` -> ${await fsp.realpath(from)}` : ""}`);
    return;
  }
  if (sub === "list") {
    const names = await fsp.readdir(dir).catch(() => [] as string[]);
    if (names.filter((n) => !n.startsWith(".")).length === 0) console.log(`no plugins in ${dir}`);
    for (const n of names.filter((x) => !x.startsWith(".")).sort()) {
      const folder = path.join(dir, n);
      const linked = (await fsp.lstat(folder)).isSymbolicLink();
      const real = await fsp.realpath(folder).catch(() => undefined);
      const read = real ? await readPluginFolder(real, n) : { error: "the link points nowhere" };
      const what = "error" in read ? `error: ${read.error}` : `${read.manifest.name} ${read.manifest.version} (${read.hash})`;
      console.log(`${n.padEnd(20)} ${what}${linked ? `  [link -> ${real ?? "?"}]` : ""}`);
    }
    return;
  }
  if (sub === "remove") {
    const id = rest[0];
    if (!id || id.includes("/") || id.startsWith(".")) return fail(usage);
    const target = path.join(dir, id);
    if (!(await fsp.lstat(target).catch(() => undefined))) return fail(`no plugin ${id} in ${dir}`);
    await fsp.rm(target, { recursive: true, force: true });
    const store = new Store(dbFileOf());
    store.forgetPlugin(id);
    store.close();
    console.log(`removed ${id}`);
    return;
  }
  fail(usage);
}

const args = process.argv.slice(2);
switch (args[0] ?? "start") {
  case "start":
    void start();
    break;
  case "plugin":
    await plugin(args.slice(1));
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
