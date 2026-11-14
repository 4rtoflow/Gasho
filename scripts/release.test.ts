import assert from "node:assert/strict";
import { test } from "node:test";
import { latestTag, nextVersion, parseVersion, pluginApi } from "./release.ts";

test("a feature raises y and puts z back to 0; a fix raises z", () => {
  assert.equal(nextVersion("0.13.0", "minor", 0), "0.14.0");
  assert.equal(nextVersion("0.12.1", "minor", 0), "0.13.0");
  assert.equal(nextVersion("0.13.0", "patch", 0), "0.13.1");
  assert.equal(nextVersion("0.9.9", "patch", 0), "0.9.10");
  assert.equal(nextVersion("1.2.0", "patch", 1), "1.2.1");
});

test("x stays fixed", () => {
  assert.throws(() => nextVersion("1.2.0", "minor", 0), /fixed x 0/);
});

test("versions are x.y.z", () => {
  assert.deepEqual(parseVersion("0.13.0"), [0, 13, 0]);
  assert.throws(() => parseVersion("0.13"));
  assert.throws(() => parseVersion("0.13.0-beta.1"));
});

test("the last tag is the highest version, not the last in the list", () => {
  const tags = ["daemon-v0.9.0", "daemon-v0.10.2", "daemon-v0.10.10", "plugin-sdk-v1.2.0", "daemon-vx", "daemon-v0.11.0-rc.1"];
  assert.equal(latestTag(tags, "daemon-v"), "daemon-v0.10.10");
  assert.equal(latestTag(tags, "plugin-sdk-v"), "plugin-sdk-v1.2.0");
  assert.equal(latestTag(tags, "none-v"), undefined);
});

test("the plugin API's version is read from the source", () => {
  assert.equal(pluginApi('export const PLUGIN_API = "1.2";'), "1.2");
  assert.equal(pluginApi("nothing here"), undefined);
});
