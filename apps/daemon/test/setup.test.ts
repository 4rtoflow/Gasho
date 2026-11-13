import assert from "node:assert/strict";
import { test } from "node:test";
import { atLeast, formatChecks, launchdPlist, servicePath, systemdUnit, versionOf } from "../src/setup.ts";

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

const input = { node: "/opt/node 24/bin/node", repo: "/home/u/repos/Gasho 100%", path: "/opt/node 24/bin:/usr/bin", home: "/home/u" };

test("the systemd unit quotes its command and escapes % (WorkingDirectory takes no quotes)", () => {
  const unit = systemdUnit(input);
  assert.match(unit, /^WorkingDirectory=\/home\/u\/repos\/Gasho 100%%$/m);
  assert.match(unit, /^ExecStart="\/opt\/node 24\/bin\/node" "\/home\/u\/repos\/Gasho 100%%\/apps\/daemon\/src\/cli\.ts" run$/m);
  assert.match(unit, /^Environment="PATH=\/opt\/node 24\/bin:\/usr\/bin"$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
});

test("the launchd agent runs Node.js on the daemon directly, with its paths escaped for XML", () => {
  const plist = launchdPlist({ ...input, repo: "/Users/u/Gasho & <co>'s", home: "/Users/u" });
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
