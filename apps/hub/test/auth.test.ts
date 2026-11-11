import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deviceCookie,
  newPairingCode,
  normalizeCode,
  parseCookies,
  parseDeviceCookie,
  RateLimiter,
} from "../src/auth.ts";
import { isAllowed, buildAllowList, normalizeAddress, parseNets } from "../src/netallow.ts";
import { Store } from "../src/store.ts";

test("pairing codes avoid look-alike characters and accept sloppy input", () => {
  for (let i = 0; i < 200; i++) assert.match(newPairingCode(), /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
  assert.equal(normalizeCode(" abcd ef23 "), "ABCD-EF23");
  assert.equal(normalizeCode("ABCD-EF23"), "ABCD-EF23");
});

test("device cookie round trip", () => {
  const header = deviceCookie("11111111-2222-3333-4444-555555555555", "tok.en_-", false);
  assert.match(header, /HttpOnly; SameSite=Strict/);
  assert.doesNotMatch(header, /Secure/);
  assert.match(deviceCookie("a", "b", true), /; Secure$/);
  const value = header.split(";")[0];
  assert.deepEqual(parseDeviceCookie(`other=1; ${value}`), { id: "11111111-2222-3333-4444-555555555555", token: "tok.en_-" });
  assert.equal(parseDeviceCookie("gasho_device=nodot"), undefined);
  assert.deepEqual(parseCookies("a=1; b = 2"), { a: "1", b: "2" });
});

test("rate limiter blocks after the limit within the window", () => {
  const r = new RateLimiter(3, 1000);
  for (let i = 0; i < 3; i++) r.fail("ip", 0);
  assert.equal(r.blocked("ip", 10), true);
  assert.equal(r.blocked("other", 10), false);
  assert.equal(r.blocked("ip", 1001), false);
});

test("allow list: LAN by default, Tailscale on request, public addresses refused", () => {
  const lan = buildAllowList(parseNets(undefined));
  for (const a of ["127.0.0.1", "::1", "::ffff:192.168.1.5", "192.168.1.5", "10.1.2.3", "172.20.0.1", "fe80::1%eth0", "fd00::1"]) {
    assert.equal(isAllowed(lan, a), true, a);
  }
  for (const a of ["8.8.8.8", "::ffff:1.1.1.1", "2001:db8::1", "100.64.1.1", "172.32.0.1", undefined]) {
    assert.equal(isAllowed(lan, a), false, String(a));
  }
  const withTailscale = buildAllowList(parseNets("lan,tailscale"));
  assert.equal(isAllowed(withTailscale, "100.101.102.103"), true);
  const custom = buildAllowList(parseNets("192.168.10.0/24"));
  assert.equal(isAllowed(custom, "192.168.10.9"), true);
  assert.equal(isAllowed(custom, "127.0.0.1"), false);
  assert.throws(() => buildAllowList(["not-an-ip/8"]));
  assert.equal(normalizeAddress("::ffff:10.0.0.1"), "10.0.0.1");
});

test("store: devices verify only with their own token and kind, and stop working when revoked", () => {
  const store = new Store(":memory:");
  const { device, token } = store.createDevice("browser", "iPhone");
  assert.equal(store.verifyDevice(device.id, token)?.name, "iPhone");
  assert.equal(store.verifyDevice(device.id, token, "machine"), undefined);
  assert.equal(store.verifyDevice(device.id, `${token}x`), undefined);
  assert.equal(store.renameDevice(device.id, "iPhone 17"), true);
  assert.equal(store.listDevices()[0]?.name, "iPhone 17");
  assert.equal(store.revokeDevice(device.id), true);
  assert.equal(store.verifyDevice(device.id, token), undefined);
  assert.equal(store.listDevices().length, 0);
});

test("store: a pairing code works once and only before it expires", () => {
  const store = new Store(":memory:");
  const { code } = store.createPairingCode("cli", 1000, 60_000);
  assert.equal(store.consumePairingCode(code.toLowerCase().replace("-", ""), 2000), true);
  assert.equal(store.consumePairingCode(code, 2000), false);
  const late = store.createPairingCode("cli", 1000, 60_000);
  assert.equal(store.consumePairingCode(late.code, 62_000), false);
  assert.equal(store.consumePairingCode("ABCD-EFGH", 2000), false);
});
