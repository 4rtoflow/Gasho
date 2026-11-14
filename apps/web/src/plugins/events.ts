// useEvent of the plugin SDK (docs/plugins.md, P8): the last data of a topic of a plugin's daemon part on a working
// server, from the events the Gasho server passes on (event-store.ts). Kept outside the app's state, so that an event
// draws again only the parts that read its topic.
import { useCallback, useSyncExternalStore } from "react";
import { onHubMessage } from "@/lib/store";
import { PluginEventStore } from "./event-store";

const events = new PluginEventStore();
onHubMessage((m) => events.onMessage(m));

/** The last data of a topic of a plugin's daemon part on a working server (undefined until an event came). */
export function useEventFor<T>(plugin: string, machine: string, topic: string): T | undefined {
  const key = PluginEventStore.key(plugin, machine, topic);
  const subscribe = useCallback((l: () => void) => events.subscribe(key, l), [key]);
  return useSyncExternalStore(subscribe, () => events.get(key) as T | undefined);
}
