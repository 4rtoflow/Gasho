// Limits who may connect at all, by source address. Registration (auth.ts) decides what they may do.
import net from "node:net";

/** This machine and private LAN ranges (IPv4 private and link-local, IPv6 ULA and link-local). */
export const LAN_NETS = [
  "127.0.0.0/8",
  "::1/128",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
  "fc00::/7",
  "fe80::/10",
];

/** Tailscale's address ranges, for when global access through Tailscale is turned on. */
export const TAILSCALE_NETS = ["100.64.0.0/10", "fd7a:115c:a1e0::/48"];

/**
 * Parses GASHO_ALLOW_NETS: comma-separated CIDRs plus the aliases "lan" and "tailscale".
 * Unset means "lan".
 */
export function parseNets(spec: string | undefined): string[] {
  if (!spec?.trim()) return [...LAN_NETS];
  const out: string[] = [];
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (part === "lan") out.push(...LAN_NETS);
    else if (part === "tailscale") out.push(...TAILSCALE_NETS);
    else out.push(part);
  }
  return out;
}

export function buildAllowList(nets: string[]): net.BlockList {
  const list = new net.BlockList();
  for (const cidr of nets) {
    const [addr = "", prefixText] = cidr.split("/");
    const family = net.isIPv4(addr) ? "ipv4" : net.isIPv6(addr) ? "ipv6" : undefined;
    if (!family) throw new Error(`GASHO_ALLOW_NETS: not an IP network: ${cidr}`);
    const prefix = prefixText === undefined ? (family === "ipv4" ? 32 : 128) : Number(prefixText);
    if (!Number.isInteger(prefix)) throw new Error(`GASHO_ALLOW_NETS: bad prefix: ${cidr}`);
    list.addSubnet(addr, prefix, family);
  }
  return list;
}

/** "::ffff:192.168.1.5" -> "192.168.1.5"; drops an IPv6 zone id ("fe80::1%eth0"). */
export function normalizeAddress(addr: string | undefined): string | undefined {
  if (!addr) return undefined;
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped?.[1]) return mapped[1];
  return addr.replace(/%.*$/, "");
}

export function isAllowed(list: net.BlockList, addr: string | undefined): boolean {
  const a = normalizeAddress(addr);
  if (!a) return false;
  if (net.isIPv4(a)) return list.check(a, "ipv4");
  if (net.isIPv6(a)) return list.check(a, "ipv6");
  return false;
}
