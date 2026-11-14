import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginInfo } from "@gasho/protocol";
import { PluginEventStore } from "../src/plugins/event-store.ts";

const info = (id: string, hash: string, enabled = true): PluginInfo => ({ id, manifest: { id, name: id, version: "1.0.0", api: "1.4" }, dev: false, enabled, machines: "all", hash, values: {} });
const key = (plugin: string, topic: string, machine = "m1") => PluginEventStore.key(plugin, machine, topic);

test("the last event of each plugin, working server and topic is kept, and only its readers hear of it", () => {
  const store = new PluginEventStore();
  store.onMessage({ type: "snapshot", machines: [], notifications: [], events: [], plugins: [info("a", "h1")], pluginEvents: [{ plugin: "a", machine: "m1", topic: "state", data: { up: true } }] });
  assert.deepEqual(store.get(key("a", "state")), { up: true });
  let heard = 0;
  let other = 0;
  store.subscribe(key("a", "progress"), () => heard++);
  store.subscribe(key("a", "progress", "m2"), () => other++);
  store.onMessage({ type: "plugin.event", event: { plugin: "a", machine: "m1", topic: "progress", data: 10 } });
  store.onMessage({ type: "plugin.event", event: { plugin: "a", machine: "m1", topic: "progress", data: 20 } });
  assert.equal(store.get(key("a", "progress")), 20);
  assert.equal(store.get(key("a", "progress", "m2")), undefined);
  assert.equal(heard, 2);
  assert.equal(other, 0);
});

test("a plugin disabled, removed or replaced by a new version loses its events; a new connection starts from what was kept", () => {
  const store = new PluginEventStore();
  const ev = (plugin: string, topic: string) => store.onMessage({ type: "plugin.event", event: { plugin, machine: "m1", topic, data: 1 } });
  store.onMessage({ type: "snapshot", machines: [], notifications: [], events: [], plugins: [info("a", "h1"), info("b", "h1")] });
  ev("a", "x");
  ev("b", "y");
  let dropped = 0;
  store.subscribe(key("a", "x"), () => dropped++);
  // Settings or the state of a daemon part change the plugins, not the version: nothing is dropped.
  store.onMessage({ type: "plugins", plugins: [info("a", "h1"), info("b", "h1")] });
  assert.equal(store.get(key("a", "x")), 1);
  store.onMessage({ type: "plugins", plugins: [info("a", "h2"), info("b", "h1")] });
  assert.equal(store.get(key("a", "x")), undefined);
  assert.equal(dropped, 1);
  assert.equal(store.get(key("b", "y")), 1);
  store.onMessage({ type: "plugins", plugins: [info("a", "h2"), info("b", "h1", false)] });
  assert.equal(store.get(key("b", "y")), undefined);
  ev("a", "x");
  store.onMessage({ type: "plugins", plugins: [] });
  assert.equal(store.get(key("a", "x")), undefined);

  ev("a", "z");
  store.onMessage({ type: "snapshot", machines: [], notifications: [], events: [], plugins: [info("a", "h2")], pluginEvents: [{ plugin: "a", machine: "m1", topic: "kept", data: 2 }] });
  assert.equal(store.get(key("a", "z")), undefined);
  assert.equal(store.get(key("a", "kept")), 2);
});
