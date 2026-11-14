// The theme (docs/plugins.md, P16): the values of the enabled theme plugin, set on <html> as CSS variables over
// Gasho's own (index.css). The Gasho server keeps one theme enabled; when plugins linked for development make two, the
// first by id is used. What is set is kept in localStorage for index.html, which sets it again before the page is
// drawn, so that a reload does not show Gasho's own colors first; the plugins the Gasho server sends on connecting and
// on every change replace it.
import type { PluginInfo, PluginThemeName } from "@gasho/protocol";
import { onHubMessage } from "@/lib/store";

/** Read by index.html too: the CSS variables and their values ({ "--background": "#10141c", … }). */
const KEY = "gasho.theme";

/** The enabled themes, the one in use first. */
export function enabledThemes(plugins: readonly PluginInfo[]): PluginInfo[] {
  return plugins.filter((p) => p.enabled && p.hash && p.manifest.theme).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function variables(theme: Partial<Record<PluginThemeName, string>> | undefined): Record<string, string> {
  // Tailwind CSS's gray classes (bg-neutral-950, …) read --color-neutral-*; Gasho's own read --background and the like.
  return Object.fromEntries(Object.entries(theme ?? {}).map(([name, value]) => [name.startsWith("neutral-") ? `--color-${name}` : `--${name}`, value]));
}

function saved(): Record<string, string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return typeof v === "object" && v !== null ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** What is set on <html> now: by index.html at first. */
let applied = saved();

function apply(plugins: readonly PluginInfo[]): void {
  const next = variables(enabledThemes(plugins)[0]?.manifest.theme);
  const style = document.documentElement.style;
  for (const name of Object.keys(applied)) if (!Object.hasOwn(next, name)) style.removeProperty(name);
  for (const [name, value] of Object.entries(next)) style.setProperty(name, value);
  applied = next;
  try {
    if (Object.keys(next).length > 0) localStorage.setItem(KEY, JSON.stringify(next));
    else localStorage.removeItem(KEY);
  } catch {
    // storage unavailable: the next page view starts from Gasho's own colors
  }
}

onHubMessage((m) => {
  if (m.type === "snapshot" || m.type === "plugins") apply(m.plugins ?? []);
});
