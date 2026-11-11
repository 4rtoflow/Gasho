// Secrets for device registration: pairing codes, device tokens and the browser cookie.
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/** No I, L, O, 0 or 1, which are easy to misread. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const PAIRING_CODE_TTL_MS = 10 * 60_000;

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** "ABCD-EF23": 8 characters from a 31-letter alphabet. */
export function newPairingCode(): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** Accepts lower case, spaces and missing hyphens. */
export function normalizeCode(input: string): string {
  const s = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

export const DEVICE_COOKIE = "gasho_device";
const COOKIE_MAX_AGE = 400 * 24 * 3600; // the longest lifetime browsers keep

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (key) out[key] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Cookie value is "<deviceId>.<token>". */
export function deviceCookie(deviceId: string, token: string, secure: boolean): string {
  return `${DEVICE_COOKIE}=${deviceId}.${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}${secure ? "; Secure" : ""}`;
}

export function clearDeviceCookie(): string {
  return `${DEVICE_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

export function parseDeviceCookie(cookieHeader: string | undefined): { id: string; token: string } | undefined {
  const value = parseCookies(cookieHeader)[DEVICE_COOKIE];
  if (!value) return undefined;
  const i = value.indexOf(".");
  if (i <= 0 || i === value.length - 1) return undefined;
  return { id: value.slice(0, i), token: value.slice(i + 1) };
}

/** Counts failures per key in a fixed window; used to slow down guessing of pairing codes. */
export class RateLimiter {
  private limit: number;
  private windowMs: number;
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  blocked(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key);
    return !!h && h.resetAt > now && h.count >= this.limit;
  }

  fail(key: string, now = Date.now()): void {
    const h = this.hits.get(key);
    if (!h || h.resetAt <= now) this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
    else h.count++;
  }
}
