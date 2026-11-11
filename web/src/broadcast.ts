/**
 * Is a host a broadcast address, as the server judges it (src/plugins/light/output/subnet.ts,
 * isBroadcast), from what output.status publishes: one of this machine's subnet broadcasts
 * (`localBroadcasts`); a x.x.x.255 only when it is out of this machine's subnets (`outOfSubnet`): on a
 * local /8, 2.3.4.255 is a node. An older server without `localBroadcasts`: its own broadcast, and
 * any x.x.x.255 as before.
 */
export function broadcastTest(output: { broadcast?: string; localBroadcasts?: string[]; outOfSubnet?: string[] }): (ip: string) => boolean {
  const known = output.localBroadcasts;
  const local = new Set(known ?? ["255.255.255.255", ...(output.broadcast ? [output.broadcast] : [])]);
  const away = new Set(output.outOfSubnet ?? []);
  return (ip) => local.has(ip) || (ip.endsWith(".255") && (known ? away.has(ip) : true));
}
