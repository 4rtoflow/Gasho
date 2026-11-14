// Builds the npm package of gasho-daemon (@4rtoflow/gasho-daemon on GitHub Packages) in dist/package: the TypeScript
// compiled to JavaScript (Node.js does not run TypeScript inside node_modules), a package.json and a README. The
// version is DAEMON_VERSION, the one gasho-daemon tells the Gasho server. Publish with `npm publish dist/package`.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PACKAGE_NAME } from "../src/install.ts";

const daemon = path.resolve(import.meta.dirname, "..");
const out = path.join(daemon, "dist/package");
const version = /export const DAEMON_VERSION = "([^"]+)"/.exec(fs.readFileSync(path.join(daemon, "src/daemon.ts"), "utf8"))?.[1];
if (!version) throw new Error("DAEMON_VERSION not found in src/daemon.ts");

fs.rmSync(out, { recursive: true, force: true });
const tsc = path.resolve(daemon, "../../node_modules/.bin/tsc");
execFileSync(tsc, ["-p", path.join(daemon, "tsconfig.build.json"), "--outDir", path.join(out, "lib")], { stdio: "inherit" });
fs.chmodSync(path.join(out, "lib/cli.js"), 0o755);

// The daemon's own dependencies (the sessions' terminals: node-pty and xterm.js), at the versions it was tested with;
// the workspace's packages (@gasho/protocol) are only types, gone in the JavaScript.
const own = JSON.parse(fs.readFileSync(path.join(daemon, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
const dependencies = Object.fromEntries(Object.entries(own.dependencies ?? {}).filter(([name]) => !name.startsWith("@gasho/")));

const pkg = {
  name: PACKAGE_NAME,
  version,
  description: "gasho-daemon: Gasho の working server で動き、Claude Code のセッションを Gasho サーバーにつなぐ",
  type: "module",
  bin: { "gasho-daemon": "lib/cli.js" },
  files: ["lib"],
  dependencies,
  engines: { node: ">=24" },
  repository: { type: "git", url: "git+https://github.com/4rtoflow/Gasho.git", directory: "apps/daemon" },
  homepage: "https://github.com/4rtoflow/Gasho/blob/main/docs/daemon-setup.md",
  publishConfig: { registry: "https://npm.pkg.github.com" },
};
fs.writeFileSync(path.join(out, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
fs.writeFileSync(
  path.join(out, "README.md"),
  `# ${PACKAGE_NAME}

Gasho の gasho-daemon。Claude Code を動かすマシン（working server）で動かし、セッションの様子を Gasho サーバーに送る。

\`\`\`bash
npx ${PACKAGE_NAME} register --server http://<Gasho サーバー>:7740 --code <コード>
npx ${PACKAGE_NAME} doctor
\`\`\`

GitHub Packages から入れるための設定と、常駐のさせ方は [docs/daemon-setup.md](https://github.com/4rtoflow/Gasho/blob/main/docs/daemon-setup.md) を見る。
`,
);
console.log(`built ${PACKAGE_NAME}@${version} in ${path.relative(process.cwd(), out) || "."}`);
