// The catalog of GashoPlugins (docs/plugins.md, P10) as the plugins screen and the sidebar use it: which installed
// plugins it has a newer version of.
import type { CatalogPlugin, PluginCatalog, PluginInfo } from "@gasho/protocol";
import { apiSupported } from "@/plugins/registry";

/** Orders two plugin versions ("1.2.0", "1.2.0-beta.1"): negative when `a` is older than `b` (as the Gasho server does). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v);
    return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] } : { nums: [0, 0, 0], pre: undefined };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.nums[i] ?? 0) !== (y.nums[i] ?? 0)) return (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/**
 * The catalog's newer versions of installed plugins, by id. Plugins being developed (links) are left out: they are
 * never updated from the catalog.
 */
export function updatesOf(infos: PluginInfo[], catalog: PluginCatalog | undefined): Map<string, CatalogPlugin> {
  const out = new Map<string, CatalogPlugin>();
  for (const info of infos) {
    if (info.dev) continue;
    const newer = catalog?.plugins.find((p) => p.id === info.id);
    if (newer && (!info.manifest.version || compareVersions(newer.version, info.manifest.version) > 0)) out.set(info.id, newer);
  }
  return out;
}

/** How many installed plugins can be updated now (the sidebar's badge): a newer version that this Gasho can run. */
export function updateCount(infos: PluginInfo[], catalog: PluginCatalog | undefined): number {
  return [...updatesOf(infos, catalog).values()].filter((p) => apiSupported(p.api)).length;
}
