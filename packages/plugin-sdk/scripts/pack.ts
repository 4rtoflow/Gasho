// Builds the npm package of the plugin SDK (@4rtoflow/gasho-plugin-sdk on GitHub Packages) in dist/package: the types
// and the daemon part's helpers compiled to JavaScript (Node.js does not run TypeScript inside node_modules), Gasho's
// protocol types put inside it (the protocol is not published), the build command (gasho-plugin) and the stylesheets.
// Plugins install it under the name the SDK has in Gasho: "@gasho/plugin-sdk": "npm:@4rtoflow/gasho-plugin-sdk@^1".
// The version is the one in packages/plugin-sdk/package.json. Publish with `npm publish dist/package`.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const sdk = path.resolve(import.meta.dirname, "..");
const root = path.resolve(sdk, "../..");
const out = path.join(sdk, "dist/package");
const lib = path.join(out, "lib");
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, any>;
const own = read(path.join(sdk, "package.json"));

fs.rmSync(out, { recursive: true, force: true });
const tsc = path.join(root, "node_modules/.bin/tsc");
execFileSync(tsc, ["-p", path.join(sdk, "tsconfig.build.json"), "--outDir", lib], { stdio: "inherit" });

// The protocol holds types only, so its source is its declaration file. The SDK's types read it from next to them.
fs.copyFileSync(path.join(root, "packages/protocol/src/index.ts"), path.join(lib, "protocol.d.ts"));
for (const name of fs.readdirSync(lib)) {
  if (!/\.(d\.ts|js)$/.test(name)) continue;
  const file = path.join(lib, name);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll('from "@gasho/protocol"', 'from "./protocol.js"'));
}

// The build command reads ../src/exports.js, as it does in Gasho's repository.
fs.mkdirSync(path.join(out, "src"));
for (const f of ["src/exports.js", "src/exports.d.ts", "theme.css", "plugin.css", "bin/gasho-plugin.mjs"]) {
  fs.mkdirSync(path.dirname(path.join(out, f)), { recursive: true });
  fs.copyFileSync(path.join(sdk, f), path.join(out, f));
}
fs.chmodSync(path.join(out, "bin/gasho-plugin.mjs"), 0o755);

// The build command's tools, at the versions Gasho's screen is built with.
const web = read(path.join(root, "apps/web/package.json"));
const tools = { ...web.dependencies, ...web.devDependencies } as Record<string, string>;
const dependencies = Object.fromEntries(["vite", "@vitejs/plugin-react", "@tailwindcss/vite", "tailwindcss"].map((n) => [n, tools[n]]));
if (Object.values(dependencies).some((v) => !v)) throw new Error("a build tool is missing from apps/web/package.json");

const pkg = {
  name: "@4rtoflow/gasho-plugin-sdk",
  version: own.version,
  description: "Gasho のプラグインを書くための SDK：型、daemon の部分の関数、ビルドのコマンド（gasho-plugin build）、テーマ",
  type: "module",
  exports: {
    ".": { types: "./lib/index.d.ts", default: "./lib/index.js" },
    "./daemon": { types: "./lib/daemon.d.ts", default: "./lib/daemon.js" },
    "./exports": { types: "./src/exports.d.ts", default: "./src/exports.js" },
    "./theme.css": "./theme.css",
    "./plugin.css": "./plugin.css",
  },
  bin: { "gasho-plugin": "bin/gasho-plugin.mjs" },
  files: ["lib", "src", "bin", "theme.css", "plugin.css"],
  dependencies,
  peerDependencies: { react: tools.react },
  engines: { node: ">=24" },
  repository: { type: "git", url: "git+https://github.com/4rtoflow/Gasho.git", directory: "packages/plugin-sdk" },
  homepage: "https://github.com/4rtoflow/Gasho/blob/main/docs/plugins.md",
  publishConfig: { registry: "https://npm.pkg.github.com" },
};
fs.writeFileSync(path.join(out, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
fs.writeFileSync(
  path.join(out, "README.md"),
  `# ${pkg.name}

Gasho のプラグインを書くための SDK。プラグインは [GashoPlugins](https://github.com/4rtoflow/GashoPlugins) に置き、この SDK を \`@gasho/plugin-sdk\` の名前で使う。

\`\`\`json
"devDependencies": { "@gasho/plugin-sdk": "npm:${pkg.name}@^${own.version.split(".")[0]}" }
\`\`\`

\`\`\`bash
npx gasho-plugin build           # dist/ に gasho-plugin.json、web.js、web.css、daemon.js を書く
npx gasho-plugin build --watch   # 保存するたびにビルドし直す
\`\`\`

仕組みと API は [docs/plugins.md](https://github.com/4rtoflow/Gasho/blob/main/docs/plugins.md) にまとめた。GitHub Packages から入れる設定は [docs/daemon-setup.md](https://github.com/4rtoflow/Gasho/blob/main/docs/daemon-setup.md) と同じ。
`,
);
console.log(`built ${pkg.name}@${pkg.version} in ${path.relative(process.cwd(), out) || "."}`);
