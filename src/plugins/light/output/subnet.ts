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

/** The broadcast address of a subnet. */
export function broadcastOf(s: Subnet): string {
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
 * A broadcast address: the limited broadcast, a subnet's broadcast, or any x.x.x.255 (the usual /24
 * one, even of a network this machine is not on): a route given one sends to everybody, never to a
 * node that could fail to answer discovery.
 */
export function isBroadcast(ip: string, subnets: readonly Subnet[] = []): boolean {
  return ip === "255.255.255.255" || ip.endsWith(".255") || subnets.some((s) => broadcastOf(s) === ip);
}
