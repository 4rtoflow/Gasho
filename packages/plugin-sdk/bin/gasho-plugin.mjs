#!/usr/bin/env node
// gasho-plugin: builds a Gasho plugin into dist/ (docs/plugins.md of Gasho).
//
//   gasho-plugin build [--watch] [<plugin folder>]
//
// The folder holds gasho-plugin.json and the sources: src/web/index.tsx (the web part) and src/daemon/index.ts (the
// daemon part), as gasho-plugin.json says which there are. dist/ gets the manifest, web.js and web.css (an ES module for
// the browser) and daemon.js (an ES module for Node.js), each with what it uses inside it, except the modules the web
// part shares with Gasho's screen (react, react-dom, @gasho/plugin-sdk): their imports read what Gasho puts on
// globalThis.__gasho, so that one React runs the whole page. With --watch, it builds again whenever a source changes,
// and the Gasho server reloads the plugin (hot reload) once it has linked the folder (hub:plugin add --link).
//
// Plain JavaScript: Node.js runs it from node_modules, where it strips no TypeScript.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { SDK_EXPORTS } from "../src/exports.js";

/** The modules a plugin shares with Gasho's screen (GashoGlobal.modules). */
const SHARED = ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom", "react-dom/client", "@gasho/plugin-sdk"];
const SHARED_PREFIX = "\0gasho-shared:";
const IDENT = /^[A-Za-z_$][\w$]*$/;

function fail(message) {
  console.error(`gasho-plugin: ${message}`);
  process.exit(1);
}

/** The plugin's gasho-plugin.json; throws when it cannot be used. */
function readManifest(root) {
  const file = path.join(root, "gasho-plugin.json");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof manifest?.id !== "string" || !/^[a-z][a-z0-9-]{1,31}$/.test(manifest.id)) {
    throw new Error("gasho-plugin.json: id must be 2-32 of a-z, 0-9 and -, starting with a letter");
  }
  if (!manifest.web && !manifest.daemon) throw new Error("gasho-plugin.json: give web, daemon, or both");
  return manifest;
}

function firstExisting(root, candidates) {
  return candidates.map((c) => path.join(root, c)).find((f) => fs.existsSync(f));
}

/** Imports of the shared modules read what Gasho's screen put on globalThis.__gasho.modules. */
function sharedModules(root) {
  const requireHere = createRequire(path.join(root, "package.json"));
  const exportsOf = (id) => {
    if (id === "@gasho/plugin-sdk") return [...SDK_EXPORTS];
    try {
      return Object.keys(requireHere(id)).filter((k) => k !== "default" && IDENT.test(k));
    } catch {
      return [];
    }
  };
  return {
    name: "gasho-shared-modules",
    enforce: "pre",
    resolveId(id) {
      return SHARED.includes(id) ? SHARED_PREFIX + id : undefined;
    },
    load(id) {
      if (!id.startsWith(SHARED_PREFIX)) return undefined;
      const name = id.slice(SHARED_PREFIX.length);
      const names = exportsOf(name);
      return [
        `const m = globalThis.__gasho?.modules?.[${JSON.stringify(name)}];`,
        `if (!m) throw new Error(${JSON.stringify(`${name}: this plugin runs only in Gasho's screen`)});`,
        "export default m.default ?? m;",
        names.length > 0 ? `export const { ${names.join(", ")} } = m;` : "",
      ].join("\n");
    },
  };
}

async function buildWeb(root, manifest, watch) {
  const entry = firstExisting(root, ["src/web/index.tsx", "src/web/index.ts", "src/web/index.jsx", "src/web/index.js"]);
  if (!entry) fail("gasho-plugin.json has web, but there is no src/web/index.tsx");
  const { build } = await import("vite");
  const { default: react } = await import("@vitejs/plugin-react");
  const { default: tailwindcss } = await import("@tailwindcss/vite");
  const js = manifest.web.js ?? "web.js";
  const css = (manifest.web.css ?? "web.css").replace(/\.css$/, "");
  return build({
    configFile: false,
    root,
    logLevel: "warn",
    publicDir: false,
    plugins: [sharedModules(root), react(), tailwindcss()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
      outDir: path.join(root, "dist"),
      emptyOutDir: false,
      copyPublicDir: false,
      target: "es2022",
      lib: { entry, formats: ["es"], fileName: () => js, cssFileName: css },
      cssCodeSplit: false,
      sourcemap: false,
      reportCompressedSize: false,
      watch: watch ? {} : null,
    },
  });
}

async function buildDaemon(root, manifest, watch) {
  const entry = firstExisting(root, ["src/daemon/index.ts", "src/daemon/index.js"]);
  if (!entry) fail("gasho-plugin.json has daemon, but there is no src/daemon/index.ts");
  const { build } = await import("vite");
  return build({
    configFile: false,
    root,
    logLevel: "warn",
    publicDir: false,
    ssr: { noExternal: true, target: "node" },
    build: {
      outDir: path.join(root, "dist"),
      emptyOutDir: false,
      copyPublicDir: false,
      target: "node24",
      ssr: entry,
      minify: false,
      sourcemap: false,
      reportCompressedSize: false,
      rolldownOptions: { output: { entryFileNames: manifest.daemon.js ?? "daemon.js", format: "es" } },
      watch: watch ? {} : null,
    },
  });
}

/** The manifest goes last: once it is there, the Gasho server finds the other files in place. */
function writeManifest(root) {
  const manifest = readManifest(root);
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "gasho-plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/**
 * Follows a watcher: resolves once its first build has ended; after that, calls onBuilt at the end of each build.
 * Errors are reported and the watcher goes on (the next save builds again).
 */
function follow(watcher, onBuilt) {
  let first = true;
  return new Promise((resolve) => {
    watcher.on("event", (e) => {
      if (e.code === "ERROR") {
        console.error(`gasho-plugin: ${e.error?.message ?? e.error}`);
        e.result?.close?.();
      }
      if (e.code !== "END") return;
      if (first) {
        first = false;
        resolve();
      } else onBuilt();
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] !== "build") fail("usage: gasho-plugin build [--watch] [<plugin folder>]");
  const watch = args.includes("--watch");
  const root = path.resolve(args.slice(1).find((a) => !a.startsWith("--")) ?? ".");
  const manifest = readManifest(root);
  // A build starts from an empty dist/: files of an older build (chunks) would otherwise stay in the plugin. The folder
  // itself stays (the Gasho server watches it when it is linked), and its manifest goes first and comes back last, so
  // the Gasho server waits for the whole build.
  const dist = path.join(root, "dist");
  fs.mkdirSync(dist, { recursive: true });
  fs.rmSync(path.join(dist, "gasho-plugin.json"), { force: true });
  for (const name of fs.readdirSync(dist)) fs.rmSync(path.join(dist, name), { recursive: true, force: true });
  const builds = [];
  if (manifest.web) builds.push(buildWeb(root, manifest, watch));
  if (manifest.daemon) builds.push(buildDaemon(root, manifest, watch));
  const results = await Promise.all(builds);
  if (!watch) {
    writeManifest(root);
    console.log(`gasho-plugin: built ${manifest.id} ${manifest.version} in ${path.relative(process.cwd(), path.join(root, "dist")) || "dist"}`);
    return;
  }
  // After each rebuild the manifest is written again (last), so the Gasho server sees the whole build at once.
  const rewrite = () => {
    try {
      writeManifest(root);
      console.log(`gasho-plugin: ${new Date().toLocaleTimeString()} built ${manifest.id}`);
    } catch (e) {
      console.error(`gasho-plugin: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  await Promise.all(results.map((w) => follow(w, rewrite)));
  writeManifest(root);
  console.log(`gasho-plugin: watching ${manifest.id}; dist/ is written again on every change`);
  fs.watch(path.join(root, "gasho-plugin.json"), () => rewrite());
}

try {
  await main();
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
