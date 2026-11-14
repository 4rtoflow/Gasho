#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { loadConfig } from "./config.ts";
import { credentialsPath, loadCredentials, register, saveCredentials } from "./credentials.ts";
import { DAEMON_VERSION, Daemon } from "./daemon.ts";
import { hooksConfig, installHooks, SECRET_ENV } from "./hooks.ts";
import { commandOf, installOf, serviceCommand } from "./install.ts";
import { doctor, formatChecks, launchdPlist, servicePath, systemdUnit } from "./setup.ts";
import { attach, listTerminals } from "./terminal.ts";

// How this copy was installed (a clone, npx, or npm install -g): the command to suggest and what a service runs.
const install = installOf(import.meta.filename);
const command = commandOf(install);

const usage = `usage: ${command} <command>
  register --server URL --code CODE [--name NAME]  register this working server with the Gasho server
  run                                              start the daemon
  doctor                                           check what the daemon needs on this machine
  service print                                    print the file that keeps the daemon running
                                                   (a systemd user service on Linux, a launchd agent on macOS)
  hooks print                                      print the hooks to add to Claude Code settings
  hooks install [--settings FILE]                  merge the hooks into FILE (default ~/.claude/settings.json)
  attach [NAME]                                    show the terminal of a session Gasho started, and type into it
                                                   (Ctrl+] leaves it running); without NAME, list the terminals
  version                                          print the version

The registration is stored in ${credentialsPath()} (GASHO_DAEMON_CONFIG to change).
Settings such as ${SECRET_ENV} can go in daemon.env beside it (NAME=value per line); every command reads it.
The hooks carry ${SECRET_ENV} (if set) as a header; the daemon checks it.`;

// The daemon's own settings (GASHO_HOOK_SECRET and the like) in daemon.env next to the registration, read by every
// command; a value set in the shell wins.
const envFile = path.join(path.dirname(credentialsPath()), "daemon.env");
try {
  process.loadEnvFile(envFile);
} catch (e) {
  if ((e as { code?: unknown }).code !== "ENOENT") console.error(`could not read ${envFile}:`, e instanceof Error ? e.message : e);
}

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const port = Number(process.env.GASHO_HOOK_PORT ?? 7741);
const secret = process.env[SECRET_ENV] || undefined;

try {
  switch (args[0] ?? "run") {
    case "register": {
      const server = opt("--server");
      const code = opt("--code");
      if (!server || !code) throw new Error(usage);
      const name = opt("--name") ?? process.env.GASHO_MACHINE ?? os.hostname();
      const creds = await register(server, code, name);
      const file = credentialsPath();
      await saveCredentials(file, creds);
      console.log(`registered "${creds.name}" (${creds.machineId}) with ${creds.server}`);
      console.log(`saved to ${file}`);
      break;
    }
    case "run": {
      const creds = await loadCredentials(credentialsPath());
      await new Daemon(loadConfig(creds)).start();
      break;
    }
    case "doctor": {
      const checks = await doctor({
        claudeBin: process.env.GASHO_CLAUDE_BIN ?? "claude",
        ghBin: process.env.GASHO_GH_BIN ?? "gh",
        hookPort: port,
        settingsFile: path.join(process.env.GASHO_CLAUDE_DIR ?? path.join(os.homedir(), ".claude"), "settings.json"),
        command,
      });
      console.log(formatChecks(checks, DAEMON_VERSION));
      if (checks.some((c) => c.level === "fail")) process.exitCode = 1;
      break;
    }
    case "service": {
      if (args[1] !== "print") throw new Error(usage);
      const home = os.homedir();
      const input = {
        node: process.execPath,
        ...serviceCommand(install, process.execPath, DAEMON_VERSION, home),
        path: servicePath(process.execPath, process.env.PATH),
        home,
      };
      if (process.platform === "linux") process.stdout.write(systemdUnit(input));
      else if (process.platform === "darwin") process.stdout.write(launchdPlist(input));
      else throw new Error(`no service file for ${process.platform}; run the daemon with: ${command} run`);
      break;
    }
    case "attach": {
      const stateDir = path.dirname(credentialsPath());
      if (args[1]) {
        await attach(stateDir, args[1]);
        break;
      }
      const list = await listTerminals(stateDir);
      if (list.length === 0) console.log("no session terminals are running");
      for (const t of list) console.log(`${t.name}\t${t.cwd}${t.exited ? "\t(ended)" : ""}`);
      break;
    }
    case "hooks": {
      if (args[1] === "print") {
        console.log(JSON.stringify({ hooks: hooksConfig(port, secret) }, null, 2));
      } else if (args[1] === "install") {
        const target = opt("--settings");
        const file = target ? path.resolve(target) : path.join(os.homedir(), ".claude", "settings.json");
        const backup = await installHooks(file, port, secret);
        console.log(`installed Gasho hooks into ${file}${backup ? ` (backup: ${backup})` : ""}`);
        if (!secret) console.log(`note: ${SECRET_ENV} is not set, so the hooks carry no secret header`);
      } else {
        throw new Error(usage);
      }
      break;
    }
    case "version":
    case "--version":
      console.log(DAEMON_VERSION);
      break;
    default:
      throw new Error(usage);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
