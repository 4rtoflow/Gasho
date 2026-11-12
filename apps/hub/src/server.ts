// HTTP and WebSocket wiring for the Gasho server:
//   /api/*      registration and device management (JSON)
//   /ws/daemon  gasho-daemon on working servers (authenticated by its hello message)
//   /ws/client  browsers (authenticated by the device cookie)
//   other paths the UI's static files
// Every request must come from an allowed address (netallow.ts).
import fs from "node:fs";
import http from "node:http";
import type { BlockList } from "node:net";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientToHub, DaemonToHub, DeviceKind, PairRequest, PairResponse } from "@gasho/protocol";
import { clearDeviceCookie, deviceCookie, parseDeviceCookie, RateLimiter } from "./auth.ts";
import { CLOSE_UNAUTHORIZED, type ClientPeer, type DaemonPeer, type Hub } from "./hub.ts";
import { isAllowed, normalizeAddress } from "./netallow.ts";
import type { DeviceRecord, Store } from "./store.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

const HEARTBEAT_MS = 30_000;
const MAX_NAME = 60;

export interface ServerOptions {
  hub: Hub;
  store: Store;
  webDist: string;
  allow: BlockList;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(data);
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64 * 1024) throw new HttpError(413, "request too large");
    chunks.push(c as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

/** Blocks cross-site requests: state changes must be JSON (forms cannot send it) from the same origin. */
function checkSameOrigin(req: http.IncomingMessage): void {
  const origin = req.headers.origin;
  if (origin) {
    let host: string;
    try {
      host = new URL(origin).host;
    } catch {
      throw new HttpError(403, "bad origin");
    }
    if (host !== req.headers.host) throw new HttpError(403, "cross-origin request");
  }
  if (req.method !== "GET" && !String(req.headers["content-type"] ?? "").startsWith("application/json")) {
    throw new HttpError(415, "send application/json");
  }
}

function isHttps(req: http.IncomingMessage): boolean {
  return (req.socket as { encrypted?: boolean }).encrypted === true || req.headers["x-forwarded-proto"] === "https";
}

function serveStatic(webDist: string, url: URL, res: http.ServerResponse): void {
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  let file = path.resolve(webDist, rel);
  if (!file.startsWith(path.resolve(webDist))) {
    res.writeHead(403).end();
    return;
  }
  if (!rel || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(webDist, "index.html"); // single-page app
  }
  if (!fs.existsSync(file)) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" }).end("gasho-web is not built yet (npm run web:build)");
    return;
  }
  const ext = path.extname(file);
  res.writeHead(200, {
    "content-type": MIME[ext] ?? "application/octet-stream",
    "cache-control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
  });
  fs.createReadStream(file).pipe(res);
}

function parse<T>(data: unknown): T | undefined {
  try {
    return JSON.parse(String(data)) as T;
  } catch {
    return undefined;
  }
}

function cleanName(v: unknown): string {
  const name = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
  if (!name || name.length > MAX_NAME) throw new HttpError(400, `name must be 1-${MAX_NAME} characters`);
  return name;
}

export function createServer(opts: ServerOptions): http.Server {
  const { hub, store, webDist, allow } = opts;
  const pairLimiter = new RateLimiter(10, 10 * 60_000);
  const deniedLogged = new Set<string>();

  const allowed = (addr: string | undefined): boolean => {
    if (isAllowed(allow, addr)) return true;
    const a = normalizeAddress(addr) ?? "unknown";
    if (!deniedLogged.has(a)) {
      deniedLogged.add(a);
      console.log(`${new Date().toISOString()} [gasho-hub] refused a connection from ${a} (not in GASHO_ALLOW_NETS)`);
    }
    return false;
  };

  const browserDevice = (req: http.IncomingMessage): DeviceRecord | undefined => {
    const c = parseDeviceCookie(req.headers.cookie);
    return c ? store.verifyDevice(c.id, c.token, "browser") : undefined;
  };

  const requireBrowser = (req: http.IncomingMessage): DeviceRecord => {
    const d = browserDevice(req);
    if (!d) throw new HttpError(401, "this browser is not registered");
    return d;
  };

  async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const route = `${req.method} ${url.pathname}`;
    if (route === "GET /api/health") return sendJson(res, 200, { ok: true });

    if (route === "POST /api/pair") {
      checkSameOrigin(req);
      const ip = normalizeAddress(req.socket.remoteAddress) ?? "unknown";
      if (pairLimiter.blocked(ip)) throw new HttpError(429, "too many attempts; wait a few minutes");
      const body = (await readJson(req)) as Partial<PairRequest>;
      const kind: DeviceKind | undefined = body.kind === "browser" || body.kind === "machine" ? body.kind : undefined;
      if (!kind) throw new HttpError(400, "kind must be browser or machine");
      const name = cleanName(body.name);
      if (typeof body.code !== "string" || !store.consumePairingCode(body.code)) {
        pairLimiter.fail(ip);
        throw new HttpError(400, "the code is wrong, used or expired");
      }
      const { device, token } = store.createDevice(kind, name);
      const out: PairResponse = { deviceId: device.id, name: device.name };
      if (kind === "machine") return sendJson(res, 201, { ...out, token });
      return sendJson(res, 201, out, { "set-cookie": deviceCookie(device.id, token, isHttps(req)) });
    }

    if (route === "GET /api/me") {
      const d = requireBrowser(req);
      return sendJson(res, 200, { id: d.id, kind: d.kind, name: d.name, createdAt: d.createdAt, current: true });
    }

    if (route === "POST /api/logout") {
      checkSameOrigin(req);
      const d = requireBrowser(req);
      hub.revokeDevice(d.id);
      return sendJson(res, 200, { ok: true }, { "set-cookie": clearDeviceCookie() });
    }

    if (route === "GET /api/devices") {
      const d = requireBrowser(req);
      return sendJson(res, 200, hub.listDevices(d.id));
    }

    if (route === "POST /api/pairing-codes") {
      checkSameOrigin(req);
      const d = requireBrowser(req);
      return sendJson(res, 201, store.createPairingCode(`device:${d.id}`));
    }

    const m = url.pathname.match(/^\/api\/devices\/([0-9a-f-]{36})$/);
    if (m?.[1] && (req.method === "PATCH" || req.method === "DELETE")) {
      checkSameOrigin(req);
      const me = requireBrowser(req);
      const id = m[1];
      if (req.method === "DELETE") {
        if (!hub.revokeDevice(id)) throw new HttpError(404, "no such device");
        const headers: Record<string, string> = id === me.id ? { "set-cookie": clearDeviceCookie() } : {};
        return sendJson(res, 200, { ok: true }, headers);
      }
      const body = (await readJson(req)) as { name?: unknown };
      if (!hub.renameDevice(id, cleanName(body.name))) throw new HttpError(404, "no such device");
      return sendJson(res, 200, { ok: true });
    }

    throw new HttpError(404, "not found");
  }

  const server = http.createServer((req, res) => {
    if (!allowed(req.socket.remoteAddress)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end("forbidden");
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/api/")) {
      serveStatic(webDist, url, res);
      return;
    }
    api(req, res, url).catch((e: unknown) => {
      if (res.headersSent) return res.end();
      if (e instanceof HttpError) sendJson(res, e.status, { error: e.message });
      else {
        console.error("[gasho-hub] api error", e);
        sendJson(res, 500, { error: "internal error" });
      }
    });
  });

  const daemonWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  // Browsers send files with inputs (10 MB in all, about 13.4 MB as base64).
  const clientWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  const alive = new WeakMap<WebSocket, boolean>();
  const track = (ws: WebSocket): void => {
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));
  };

  daemonWss.on("connection", (ws) => {
    track(ws);
    const peer: DaemonPeer = {
      send: (msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg)),
      close: (code, reason) => ws.close(code, reason),
    };
    ws.on("message", (data) => {
      const msg = parse<DaemonToHub>(data);
      if (msg) hub.onDaemonMessage(peer, msg);
    });
    ws.on("close", () => hub.onDaemonClose(peer));
  });

  clientWss.on("connection", (ws, req: http.IncomingMessage) => {
    track(ws);
    const device = browserDevice(req);
    if (!device) {
      ws.close(CLOSE_UNAUTHORIZED, "this browser is not registered");
      return;
    }
    const peer: ClientPeer = {
      deviceId: device.id,
      send: (msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg)),
      close: (code, reason) => ws.close(code, reason),
    };
    hub.onClientConnect(peer);
    ws.on("message", (data) => {
      const msg = parse<ClientToHub>(data);
      if (msg) hub.onClientMessage(peer, msg);
    });
    ws.on("close", () => hub.onClientClose(peer));
  });

  server.on("upgrade", (req, socket, head) => {
    if (!allowed(req.socket.remoteAddress)) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    if (pathname === "/ws/client") {
      // Cross-site WebSocket hijacking guard; the SameSite=Strict cookie is the main protection.
      const origin = req.headers.origin;
      try {
        if (origin && new URL(origin).host !== req.headers.host) throw new Error("cross-origin");
      } catch {
        socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      clientWss.handleUpgrade(req, socket, head, (ws) => clientWss.emit("connection", ws, req));
    } else if (pathname === "/ws/daemon") {
      daemonWss.handleUpgrade(req, socket, head, (ws) => daemonWss.emit("connection", ws, req));
    } else {
      socket.destroy();
    }
  });

  const heartbeat = setInterval(() => {
    for (const wss of [daemonWss, clientWss]) {
      for (const ws of wss.clients) {
        if (alive.get(ws) === false) {
          ws.terminate();
          continue;
        }
        alive.set(ws, false);
        ws.ping();
      }
    }
    hub.checkRevocations();
  }, HEARTBEAT_MS);
  heartbeat.unref();
  server.on("close", () => clearInterval(heartbeat));

  return server;
}
