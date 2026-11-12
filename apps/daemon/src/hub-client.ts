// Keeps a WebSocket connection to gasho-hub, reconnecting with backoff.
// Uses the WebSocket client built into Node.js.
import type { DaemonToHub, HubToDaemon } from "@gasho/protocol";
import { log } from "./util.ts";

/** Close code the Gasho server uses for unknown or revoked registrations. */
const CLOSE_INVALID_CREDENTIALS = 4001;

export interface HubClientOptions {
  url: string;
  hello: () => DaemonToHub;
  onReady: () => void;
  onMessage: (m: HubToDaemon) => void;
  /** Called instead of reconnecting when the Gasho server rejects the registration. */
  onRejected: (reason: string) => void;
}

export class HubClient {
  private opts: HubClientOptions;
  private ws: WebSocket | undefined;
  private ready = false;
  private backoff = 1000;
  /** Hook events are kept while disconnected; other messages are rebuilt on reconnect. */
  private queue: DaemonToHub[] = [];

  constructor(opts: HubClientOptions) {
    this.opts = opts;
  }

  connect(): void {
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify(this.opts.hello()));
    });
    ws.addEventListener("message", (ev) => {
      let msg: HubToDaemon;
      try {
        msg = JSON.parse(String(ev.data)) as HubToDaemon;
      } catch {
        return;
      }
      if (msg.type === "welcome") {
        this.ready = true;
        this.backoff = 1000;
        log(`hub: connected to ${this.opts.url}`);
        this.opts.onReady();
        for (const m of this.queue.splice(0)) this.send(m);
        return;
      }
      this.opts.onMessage(msg);
    });
    ws.addEventListener("close", (ev) => {
      if (this.ready) log(`hub: disconnected (${ev.code} ${ev.reason})`);
      this.ready = false;
      this.ws = undefined;
      if (ev.code === CLOSE_INVALID_CREDENTIALS) {
        this.opts.onRejected(ev.reason || "invalid credentials");
        return;
      }
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30_000);
    });
    ws.addEventListener("error", () => {
      // A close event follows and schedules the reconnect.
    });
  }

  get connected(): boolean {
    return this.ready;
  }

  send(m: DaemonToHub): void {
    if (this.ready && this.ws) {
      this.ws.send(JSON.stringify(m));
    } else if (m.type === "hook") {
      this.queue.push(m);
      if (this.queue.length > 500) this.queue.shift();
    }
  }
}
