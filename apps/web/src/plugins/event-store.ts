// The events of plugins' daemon parts (docs/plugins.md, P8) as this page has them: the last data of each plugin,
// working server and topic, starting from the events the Gasho server kept (retain) when the page connected. A plugin
// that is disabled, removed or replaced by a new version loses its events here, as it does on the Gasho server. Each
// reader listens to its own topic only, so that an event draws again only the parts that read it (events.ts).
import type { HubToClient, PluginEvent, PluginInfo } from "@gasho/protocol";

export class PluginEventStore {
  private last = new Map<string, unknown>();
  private listeners = new Map<string, Set<() => void>>();
  /** The version of each enabled plugin whose events are kept. */
  private versions = new Map<string, string>();

  static key(plugin: string, machine: string, topic: string): string {
    return `${plugin}\0${machine}\0${topic}`;
  }

  get(key: string): unknown {
    return this.last.get(key);
  }

  subscribe(key: string, l: () => void): () => void {
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(l);
    return () => {
      set.delete(l);
      if (set.size === 0) this.listeners.delete(key);
    };
  }

  /** What the Gasho server sends that matters here: events, the plugins, and a new connection's snapshot. */
  onMessage(m: HubToClient): void {
    if (m.type === "plugin.event") this.put(m.event);
    else if (m.type === "plugins") this.pluginsChanged(m.plugins);
    else if (m.type === "snapshot") {
      // A new connection: what the Gasho server kept is what stands.
      this.forget(() => true);
      this.versions.clear();
      this.pluginsChanged(m.plugins ?? []);
      for (const e of m.pluginEvents ?? []) this.put(e);
    }
  }

  private notify(key: string): void {
    for (const l of this.listeners.get(key) ?? []) l();
  }

  private put(e: PluginEvent): void {
    if (typeof e?.plugin !== "string" || typeof e.machine !== "string" || typeof e.topic !== "string") return;
    const key = PluginEventStore.key(e.plugin, e.machine, e.topic);
    this.last.set(key, e.data);
    this.notify(key);
  }

  private forget(match: (key: string) => boolean): void {
    for (const key of [...this.last.keys()]) {
      if (!match(key)) continue;
      this.last.delete(key);
      this.notify(key);
    }
  }

  /** The events of plugins that are gone, disabled, or of another version now are dropped. */
  private pluginsChanged(infos: PluginInfo[]): void {
    const now = new Map(infos.flatMap((i) => (i.enabled && i.hash ? [[i.id, i.hash] as const] : [])));
    for (const [id, hash] of this.versions) if (now.get(id) !== hash) this.forget((key) => key.startsWith(`${id}\0`));
    this.versions = now;
  }
}
