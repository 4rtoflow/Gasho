// HTTP and WebSocket wiring: /ws/daemon for gasho-daemon, /ws/client for browsers, static files for the UI.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientToHub, DaemonToHub } from "@gasho/protocol";
import type { ClientPeer, DaemonPeer, Hub } from "./hub.ts";

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

function serveStatic(webDist: string, req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    return;
  }
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  let file = path.resolve(webDist, rel);
  if (!file.startsWith(path.resolve(webDist))) {
    res.writeHead(403).end();
    return;
  }
  if (!rel || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    // Single-page app: unknown paths get index.html.
    file = path.join(webDist, "index.html");
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

function peerOf<T>(ws: WebSocket): { send(msg: T): void; close(code: number, reason: string): void } {
  return {
    send: (msg) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    },
    close: (code, reason) => ws.close(code, reason),
  };
}

export function createServer(hub: Hub, webDist: string): http.Server {
  const server = http.createServer((req, res) => serveStatic(webDist, req, res));
  const daemonWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  const clientWss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  daemonWss.on("connection", (ws) => {
    const peer: DaemonPeer = peerOf(ws);
    ws.on("message", (data) => {
      const msg = parse<DaemonToHub>(data);
      if (msg) hub.onDaemonMessage(peer, msg);
    });
    ws.on("close", () => hub.onDaemonClose(peer));
  });

  clientWss.on("connection", (ws) => {
    const peer: ClientPeer = peerOf(ws);
    hub.onClientConnect(peer);
    ws.on("message", (data) => {
      const msg = parse<ClientToHub>(data);
      if (msg) hub.onClientMessage(peer, msg);
    });
    ws.on("close", () => hub.onClientClose(peer));
  });

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    const wss = pathname === "/ws/daemon" ? daemonWss : pathname === "/ws/client" ? clientWss : undefined;
    if (!wss) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  return server;
}
