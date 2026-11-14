import assert from "node:assert/strict";
import { test } from "node:test";
import { commandOf, installOf, layoutOf, serviceCommand } from "../src/install.ts";
import { activateCommands, atLeast, formatChecks, launchdPlist, serviceFile, servicePath, systemdUnit, versionOf } from "../src/setup.ts";

test("versions are read from what the tools print, and compared", () => {
  assert.deepEqual(versionOf("v24.22.2"), [24, 22, 2]);
  assert.deepEqual(versionOf("zellij 0.45.1"), [0, 45, 1]);
  assert.deepEqual(versionOf("2.1.323 (Claude Code)"), [2, 1, 323]);
  assert.equal(versionOf("no version"), undefined);
  assert.ok(atLeast([0, 45, 1], [0, 45]));
  assert.ok(!atLeast([0, 44, 9], [0, 45]));
  assert.ok(atLeast([25, 0, 0], [24]));
});

test("the service gets Node.js's folder first, then the shell's PATH, each once", () => {
  assert.equal(servicePath("/opt/node/bin/node", "/usr/bin:/opt/node/bin:/home/u/.local/bin"), "/opt/node/bin:/usr/bin:/home/u/.local/bin");
  assert.equal(servicePath("/usr/bin/node", undefined), "/usr/bin");
});

test("the folders npm puts on PATH while npx runs are left out of the service's PATH", () => {
  const npxPath = [
    "/home/u/.npm/_npx/24d82d1acaca0cc6/node_modules/.bin",
    "/home/u/node_modules/.bin",
    "/home/node_modules/.bin",
    "/node_modules/.bin",
    "/opt/node/lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin",
    "/opt/node/bin",
    "/home/u/.local/bin",
    "/usr/bin",
  ].join(":");
  assert.equal(servicePath("/opt/node/bin/node", npxPath), "/opt/node/bin:/home/u/.local/bin:/usr/bin");
});

const repo = "/home/u/repos/Gasho 100%";
const input = {
  node: "/opt/node 24/bin/node",
  argv: ["/opt/node 24/bin/node", `${repo}/apps/daemon/src/cli.ts`],
  cwd: repo,
  path: "/opt/node 24/bin:/usr/bin",
  home: "/home/u",
};

test("the systemd unit quotes its command and escapes % (WorkingDirectory takes no quotes)", () => {
  const unit = systemdUnit(input);
  assert.match(unit, /^WorkingDirectory=\/home\/u\/repos\/Gasho 100%%$/m);
  assert.match(unit, /^ExecStart="\/opt\/node 24\/bin\/node" "\/home\/u\/repos\/Gasho 100%%\/apps\/daemon\/src\/cli\.ts" run$/m);
  assert.match(unit, /^Environment="PATH=\/opt\/node 24\/bin:\/usr\/bin"$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
});

test("the launchd agent runs Node.js on the daemon directly, with its paths escaped for XML", () => {
  const mac = "/Users/u/Gasho & <co>'s";
  const plist = launchdPlist({ ...input, argv: [input.node, `${mac}/apps/daemon/src/cli.ts`], cwd: mac, home: "/Users/u" });
  assert.match(plist, /<string>local\.gasho\.daemon<\/string>/);
  assert.ok(plist.includes("<string>/opt/node 24/bin/node</string>"));
  assert.ok(plist.includes("<string>/Users/u/Gasho &amp; &lt;co&gt;'s/apps/daemon/src/cli.ts</string>"));
  assert.ok(!plist.includes("& <co>"));
  assert.ok(plist.includes("<string>/Users/u/Library/Logs/gasho-daemon.log</string>"));
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
});

test("the checks are listed with their marks, the names lined up, and a summary", () => {
  const text = formatChecks(
    [
      { level: "ok", name: "Node.js", detail: "24.22.2" },
      { level: "warn", name: "GitHub CLI", detail: "ログインしていません", hint: "gh auth login" },
      { level: "fail", name: "登録", detail: "ありません", hint: "register" },
    ],
    "0.9.0",
  );
  const lines = text.split("\n");
  assert.equal(lines[0], "gasho-daemon 0.9.0 のセットアップの確認");
  assert.equal(lines[2], "✓ Node.js     24.22.2");
  assert.equal(lines[3], "! GitHub CLI  ログインしていません");
  assert.equal(lines[4], "    → gh auth login");
  assert.equal(lines[5], "✗ 登録        ありません");
  assert.match(text, /✗ が 1 件あります/);
});

test("how gasho-daemon was installed decides the command to suggest and what its service runs", () => {
  const node = "/opt/node/bin/node";
  const layout = layoutOf({ GASHO_DAEMON_HOME: "/home/u/.local/share/gasho/daemon" });
  const repo = installOf("/home/u/repos/Gasho/apps/daemon/src/cli.ts");
  assert.deepEqual(repo, { kind: "repo", repo: "/home/u/repos/Gasho" });
  assert.equal(commandOf(repo), "node apps/daemon/src/cli.ts");
  assert.deepEqual(serviceCommand(repo, node, "1.2.3", "/home/u", layout), {
    argv: [node, "/home/u/repos/Gasho/apps/daemon/src/cli.ts"],
    cwd: "/home/u/repos/Gasho",
  });

  // npx keeps the package in a cache npm may clear: the service runs npx again, for the same version.
  const npx = installOf("/home/u/.npm/_npx/0123abcd/node_modules/@4rtoflow/gasho-daemon/lib/cli.js");
  assert.equal(commandOf(npx), "npx @4rtoflow/gasho-daemon");
  assert.deepEqual(serviceCommand(npx, node, "1.2.3", "/home/u", layout), {
    argv: ["/opt/node/bin/npx", "--yes", "--prefer-offline", "@4rtoflow/gasho-daemon@1.2.3"],
    cwd: "/home/u",
  });

  const global = installOf("/opt/node/lib/node_modules/@4rtoflow/gasho-daemon/lib/cli.js");
  assert.equal(commandOf(global), "gasho-daemon");
  assert.deepEqual(serviceCommand(global, node, "1.2.3", "/home/u", layout).argv, [node, "/opt/node/lib/node_modules/@4rtoflow/gasho-daemon/lib/cli.js"]);

  // Installed by `service install`: Node.js runs it through its real path, in its own folder of versions; the service
  // runs the version that `current` links to, so that an update changes the link alone.
  const managed = installOf("/home/u/.local/share/gasho/daemon/versions/0.15.2/node_modules/@4rtoflow/gasho-daemon/lib/cli.js", [layout.versions]);
  assert.deepEqual(managed, { kind: "managed", version: "0.15.2" });
  assert.equal(commandOf(managed), "npx @4rtoflow/gasho-daemon");
  assert.deepEqual(serviceCommand(managed, node, "0.15.2", "/home/u", layout), {
    argv: [node, "/home/u/.local/share/gasho/daemon/current/node_modules/@4rtoflow/gasho-daemon/lib/cli.js"],
    cwd: "/home/u",
  });
  // Not a folder of a version: an ordinary package.
  assert.equal(installOf("/home/u/.local/share/gasho/daemon/versions/.0.15.2-1-x/node_modules/@4rtoflow/gasho-daemon/lib/cli.js", [layout.versions]).kind, "package");
});

test("service install writes the unit where systemd or launchd reads it, and restarts the daemon with it", () => {
  assert.equal(serviceFile("linux", "/home/u", {}), "/home/u/.config/systemd/user/gasho-daemon.service");
  assert.equal(serviceFile("linux", "/home/u", { XDG_CONFIG_HOME: "/cfg" }), "/cfg/systemd/user/gasho-daemon.service");
  assert.equal(serviceFile("darwin", "/Users/u", {}), "/Users/u/Library/LaunchAgents/local.gasho.daemon.plist");
  assert.equal(serviceFile("win32", "C:/u", {}), undefined);
  assert.deepEqual(
    activateCommands("linux", "/x", 1000).map((c) => c.argv.join(" ")),
    ["systemctl --user daemon-reload", "systemctl --user enable gasho-daemon", "systemctl --user restart gasho-daemon"],
  );
  assert.deepEqual(activateCommands("darwin", "/Users/u/Library/LaunchAgents/local.gasho.daemon.plist", 501), [
    { argv: ["launchctl", "bootout", "gui/501/local.gasho.daemon"], mayFail: true },
    { argv: ["launchctl", "bootstrap", "gui/501", "/Users/u/Library/LaunchAgents/local.gasho.daemon.plist"] },
  ]);
});
