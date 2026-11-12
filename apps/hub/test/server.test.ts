// End-to-end over HTTP and WebSocket: registration, cookies, cross-origin guards and the allow list.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type { HubToClient, PairResponse } from "@gasho/protocol";
import { Hub } from "../src/hub.ts";
import { buildAllowList, parseNets } from "../src/netallow.ts";
import { createServer } from "../src/server.ts";
import { Store } from "../src/store.ts";

let store: Store;
let server: ReturnType<typeof createServer>;
let base = "";

before(async () => {
  store = new Store(":memory:");
  server = createServer({ hub: new Hub(store), store, webDist: "/nonexistent", allow: buildAllowList(parseNets(undefined)) });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

const json = { "content-type": "application/json" };

async function pair(kind: "browser" | "machine", name: string, code = store.createPairingCode("test").code) {
  return fetch(`${base}/api/pair`, { method: "POST", headers: json, body: JSON.stringify({ code, kind, name }) });
}

function firstMessage(url: string, headers: Record<string, string>): Promise<{ data?: unknown; close?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers } as unknown as string[]);
    ws.addEventListener("message", (ev) => {
      resolve({ data: JSON.parse(String(ev.data)) });
      ws.close();
    });
    ws.addEventListener("close", (ev) => resolve({ close: ev.code }));
  });
}

test("a browser registers with a code, gets a cookie, and can then use the API", async () => {
  assert.equal((await fetch(`${base}/api/me`)).status, 401);

  const bad = await pair("browser", "iPhone", "WRNG-CODE");
  assert.equal(bad.status, 400);

  const res = await pair("browser", "iPhone");
  assert.equal(res.status, 201);
  const body = (await res.json()) as PairResponse;
  assert.equal(body.token, undefined); // browsers get the token only as a cookie
  const setCookie = res.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /^gasho_device=[0-9a-f-]+\.[\w-]+; .*HttpOnly; SameSite=Strict/);
  const cookie = setCookie.split(";")[0] ?? "";

  const me = await fetch(`${base}/api/me`, { headers: { cookie } });
  assert.equal(me.status, 200);
  assert.equal(((await me.json()) as { name: string }).name, "iPhone");

  // State changes must be JSON from the same origin.
  assert.equal((await fetch(`${base}/api/pairing-codes`, { method: "POST", headers: { cookie } })).status, 415);
  const cross = await fetch(`${base}/api/pairing-codes`, {
    method: "POST",
    headers: { cookie, ...json, origin: "http://evil.example" },
    body: "{}",
  });
  assert.equal(cross.status, 403);
  const code = await fetch(`${base}/api/pairing-codes`, { method: "POST", headers: { cookie, ...json }, body: "{}" });
  assert.equal(code.status, 201);
  assert.match(((await code.json()) as { code: string }).code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  const devices = (await (await fetch(`${base}/api/devices`, { headers: { cookie } })).json()) as Array<{ current?: boolean }>;
  assert.equal(devices.filter((d) => d.current).length, 1);

  // The browser WebSocket needs the cookie.
  const anonymous = await firstMessage(`${base.replace("http", "ws")}/ws/client`, {});
  assert.equal(anonymous.close, 4401);
  const authed = await firstMessage(`${base.replace("http", "ws")}/ws/client`, { cookie });
  assert.equal((authed.data as HubToClient).type, "snapshot");

  // Unregistering this browser clears the cookie and the registration.
  const out = await fetch(`${base}/api/logout`, { method: "POST", headers: { cookie, ...json }, body: "{}" });
  assert.equal(out.status, 200);
  assert.match(out.headers.get("set-cookie") ?? "", /Max-Age=0/);
  assert.equal((await fetch(`${base}/api/me`, { headers: { cookie } })).status, 401);
});

test("a working server registers with a code, gets a token, and its hello is accepted", async () => {
  const res = await pair("machine", "ubuntu");
  assert.equal(res.status, 201);
  const body = (await res.json()) as PairResponse;
  assert.ok(body.token);
  assert.equal(res.headers.get("set-cookie"), null);

  const welcome = await new Promise<unknown>((resolve) => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws/daemon`);
    ws.addEventListener("open", () =>
      ws.send(JSON.stringify({ type: "hello", machineId: body.deviceId, token: body.token, daemonVersion: "test" })),
    );
    ws.addEventListener("message", (ev) => {
      resolve(JSON.parse(String(ev.data)));
      ws.close();
    });
  });
  assert.deepEqual(welcome, { type: "welcome" });
});

test("guessing codes is slowed down", async () => {
  // Earlier tests used up one failure for this address; 9 more reach the limit of 10.
  for (let i = 0; i < 9; i++) assert.equal((await pair("browser", "x", "AAAA-AAAA")).status, 400);
  assert.equal((await pair("browser", "x")).status, 429);
});

test("addresses outside the allow list are refused", async () => {
  const s2 = new Store(":memory:");
  const strict = createServer({ hub: new Hub(s2), store: s2, webDist: "/nonexistent", allow: buildAllowList(["10.0.0.0/8"]) });
  await new Promise<void>((r) => strict.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(strict.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${url}/api/health`)).status, 403);
    assert.equal((await fetch(`${url}/`)).status, 403);
  } finally {
    strict.closeAllConnections();
    strict.close();
  }
});
