// REST calls to the Gasho server. State changes are sent as JSON, which the server requires.
import type { DeviceInfo, PairingCode, PairRequest, PairResponse } from "@gasho/protocol";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: method === "GET" ? undefined : { "content-type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
    credentials: "same-origin",
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText);
  return data as T;
}

/** The registered browser, or null when this browser is not registered. */
export async function fetchMe(): Promise<DeviceInfo | null> {
  try {
    return await call<DeviceInfo>("GET", "/api/me");
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return null;
    throw e;
  }
}

export function pairBrowser(code: string, name: string): Promise<PairResponse> {
  const body: PairRequest = { code, kind: "browser", name };
  return call("POST", "/api/pair", body);
}

export const listDevices = (): Promise<DeviceInfo[]> => call("GET", "/api/devices");
export const createPairingCode = (): Promise<PairingCode> => call("POST", "/api/pairing-codes");
export const renameDevice = (id: string, name: string): Promise<unknown> => call("PATCH", `/api/devices/${id}`, { name });
export const revokeDevice = (id: string): Promise<unknown> => call("DELETE", `/api/devices/${id}`);
export const unregisterThisBrowser = (): Promise<unknown> => call("POST", "/api/logout");

/** Messages the server sends, in Japanese for the UI. */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 429) return "試行が多すぎます。数分待ってから、もう一度入力してください。";
    if (e.message.includes("code")) return "コードが正しくないか、使用済みか、期限が切れています。";
    if (e.status === 401) return "このブラウザは登録されていません。";
    return `エラー（${e.status}）：${e.message}`;
  }
  return "Gasho サーバーにつながりません。";
}

/** A starting point for the device name; the user can change it. */
export function guessDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Macintosh/.test(ua)) return navigator.maxTouchPoints > 1 ? "iPad" : "Mac";
  if (/Windows/.test(ua)) return "Windows";
  if (/Linux/.test(ua)) return "Linux";
  return "ブラウザ";
}
