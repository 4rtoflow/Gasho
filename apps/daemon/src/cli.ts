import os from "node:os";
import path from "node:path";
import { loadConfig } from "./config.ts";
import { Daemon } from "./daemon.ts";
import { hooksConfig, installHooks, SECRET_ENV } from "./hooks.ts";

const usage = `usage:
  node src/cli.ts run                              start the daemon
  node src/cli.ts hooks print                      print the hooks to add to Claude Code settings
  node src/cli.ts hooks install [--settings FILE]  merge the hooks into FILE (default ~/.claude/settings.json)

The hooks carry ${SECRET_ENV} (if set) as a header; set the same value for the daemon.`;

const args = process.argv.slice(2);
const port = Number(process.env.GASHO_HOOK_PORT ?? 7741);
const secret = process.env[SECRET_ENV] || undefined;

switch (args[0] ?? "run") {
  case "run":
    new Daemon(loadConfig()).start();
    break;
  case "hooks": {
    if (args[1] === "print") {
      console.log(JSON.stringify({ hooks: hooksConfig(port, secret) }, null, 2));
    } else if (args[1] === "install") {
      const i = args.indexOf("--settings");
      const file = i >= 0 && args[i + 1] ? path.resolve(args[i + 1] as string) : path.join(os.homedir(), ".claude", "settings.json");
      const backup = await installHooks(file, port, secret);
      console.log(`installed Gasho hooks into ${file}${backup ? ` (backup: ${backup})` : ""}`);
      if (!secret) console.log(`note: ${SECRET_ENV} is not set, so the hooks carry no secret header`);
    } else {
      console.error(usage);
      process.exitCode = 2;
    }
    break;
  }
  default:
    console.error(usage);
    process.exitCode = 2;
}
