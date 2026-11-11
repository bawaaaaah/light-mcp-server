/**
 * IPv4 subnets of this machine's interfaces, as plain data: is an address reachable directly (on one
 * of them), is it a broadcast address. Pure: the caller passes the interfaces (os.networkInterfaces()).
 */
export interface Subnet {
  address: string;
  netmask: string;
}

const toInt = (ip: string): number | undefined => {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  let n = 0;
  for (const p of parts) {
    const b = Number(p);
    if (!/^\d{1,3}$/.test(p) || b > 255) return undefined;
    n = n * 256 + b;
  }
  return n;
};
const toIp = (n: number): string => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");

/** The IPv4 subnets of `os.networkInterfaces()`, loopback included. */
export function subnetsOf(interfaces: Record<string, readonly { family: string | number; address: string; netmask: string }[] | undefined>): Subnet[] {
  return Object.values(interfaces).flatMap((list) => (list ?? []).filter((a) => a.family === "IPv4" || a.family === 4).map((a) => ({ address: a.address, netmask: a.netmask })));
}

/** The prefix length of a netmask (255.255.255.0 → 24). */
const prefixOf = (netmask: string): number => (toInt(netmask) ?? 0).toString(2).split("1").length - 1;

/** The broadcast address of a subnet; none for a /31 or /32 (point-to-point, host route): that address would be a host. */
export function broadcastOf(s: Subnet): string | undefined {
  if (prefixOf(s.netmask) >= 31) return undefined;
  const ip = toInt(s.address) ?? 0;
  const mask = toInt(s.netmask) ?? 0;
  return toIp(((ip & mask) | (~mask >>> 0)) >>> 0);
}

/** On one of these subnets: reachable without a router (an Art-Net node normally is). Not an IPv4 address: false. */
export function onSubnet(ip: string, subnets: readonly Subnet[]): boolean {
  const n = toInt(ip);
  if (n === undefined) return false;
  return subnets.some((s) => {
    const mask = toInt(s.netmask) ?? 0;
    return ((n & mask) >>> 0) === (((toInt(s.address) ?? 0) & mask) >>> 0);
  });
}

/**
 * A broadcast address: the limited broadcast; on one of this machine's subnets, that subnet's
 * broadcast only (on a /8, 2.3.4.255 is an ordinary node); elsewhere, any x.x.x.255 (the usual /24
 * one of a network this machine is not on): a route given one sends to everybody, never to a node
 * that could fail to answer discovery. A /31 or /32 interface has no broadcast and decides nothing.
 */
export function isBroadcast(ip: string, subnets: readonly Subnet[] = []): boolean {
  if (ip === "255.255.255.255") return true;
  const local = subnets.filter((s) => broadcastOf(s) !== undefined && onSubnet(ip, [s]));
  return local.length ? local.some((s) => broadcastOf(s) === ip) : ip.endsWith(".255");
}

/** The broadcast addresses of these subnets, the limited broadcast first (what output.status publishes). */
export function localBroadcasts(subnets: readonly Subnet[]): string[] {
  return [...new Set(["255.255.255.255", ...subnets.map(broadcastOf).filter((b) => b !== undefined)])];
}

/**
 * Of these addresses, those on none of the subnets: out of reach without a router. The limited
 * broadcast and the broadcast of a local subnet are never out; any other x.x.x.255 is judged as an
 * address (a remote network's broadcast is out of reach too). A /32 interface (host route, VPN end)
 * holds one address and says nothing about the network beyond: with only those, nothing is judged.
 */
export function outOfSubnet(ips: readonly string[], subnets: readonly Subnet[]): string[] {
  const judged = subnets.filter((s) => prefixOf(s.netmask) < 32);
  if (!judged.length) return [];
  const reachable = new Set(["255.255.255.255", ...subnets.map(broadcastOf).filter((b) => b !== undefined)]);
  return [...new Set(ips)].filter((ip) => !reachable.has(ip) && !onSubnet(ip, judged));
}
