/**
 * Is a host a broadcast address, as the server judges it (src/plugins/light/output/subnet.ts,
 * isBroadcast), from what output.status publishes on the same subnets (the bound interface's, else
 * every interface's): one of their broadcasts (`localBroadcasts`); a x.x.x.255 only when it is out of
 * them (`outOfSubnet`): on a local /8, 2.3.4.255 is a node. Without `outOfSubnet` (subnets that judge
 * nothing: a bound /32), any x.x.x.255. An older server without `localBroadcasts`: its own broadcast,
 * and any x.x.x.255 as before.
 */
export function broadcastTest(output: { broadcast?: string; localBroadcasts?: string[]; outOfSubnet?: string[] }): (ip: string) => boolean {
  const known = output.localBroadcasts;
  const local = new Set(known ?? ["255.255.255.255", ...(output.broadcast ? [output.broadcast] : [])]);
  const away = known && output.outOfSubnet ? new Set(output.outOfSubnet) : undefined;
  return (ip) => local.has(ip) || (ip.endsWith(".255") && (away ? away.has(ip) : true));
}
