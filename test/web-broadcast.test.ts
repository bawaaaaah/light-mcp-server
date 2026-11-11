import { expect } from "chai";
import { broadcastTest } from "../web/src/broadcast.js";
import { isBroadcast, localBroadcasts, outOfSubnet } from "../src/plugins/light/output/subnet.js";
import { OutputRouter } from "../src/plugins/light/output/output-router.js";

describe("broadcast addresses (server and client agree)", () => {
  // a /8 Art-Net network: 2.3.4.255 is a node on it, 2.255.255.255 its broadcast
  const subnets = [{ address: "2.0.0.10", netmask: "255.0.0.0" }];

  it("takes a .255 inside a local wider subnet for a node, the subnet's broadcast for a broadcast", () => {
    expect(isBroadcast("2.3.4.255", subnets)).to.equal(false);
    expect(isBroadcast("2.255.255.255", subnets)).to.equal(true);
    expect(isBroadcast("255.255.255.255", subnets)).to.equal(true);
    expect(isBroadcast("198.51.100.255", subnets)).to.equal(true); // a remote network's usual /24 broadcast
    expect(isBroadcast("198.51.100.7", subnets)).to.equal(false);
    expect(localBroadcasts(subnets)).to.deep.equal(["255.255.255.255", "2.255.255.255"]);
  });

  it("judges the same on the client from output.status", () => {
    const test = broadcastTest({ broadcast: "2.255.255.255", localBroadcasts: localBroadcasts(subnets), outOfSubnet: ["198.51.100.255"] });
    expect(test("2.3.4.255")).to.equal(false);
    expect(test("2.255.255.255")).to.equal(true);
    expect(test("255.255.255.255")).to.equal(true);
    expect(test("198.51.100.255")).to.equal(true);
    expect(test("198.51.100.7")).to.equal(false);
    // an older server: its broadcast, and any .255 as before
    expect(broadcastTest({ broadcast: "192.0.2.255" })("10.0.0.255")).to.equal(true);
  });
});

describe("broadcast addresses with a bound interface (server and client agree)", () => {
  // a bound /24, and a /8 on another interface the output does not go out on
  const interfaces = [
    { address: "192.0.2.10", netmask: "255.255.255.0" },
    { address: "2.0.0.10", netmask: "255.0.0.0" },
    { address: "127.0.0.1", netmask: "255.0.0.0" },
  ];
  const ips = ["192.0.2.255", "192.0.2.7", "2.3.4.255", "2.255.255.255", "198.51.100.255", "198.51.100.7", "255.255.255.255", "127.255.255.255"];
  const clientOf = (router: OutputRouter) => broadcastTest({ broadcast: router.broadcastAddress(), localBroadcasts: router.localBroadcasts(), outOfSubnet: router.outOfSubnet(ips) });

  it("judges coverage, localBroadcasts and outOfSubnet on the bound interface's subnet only", () => {
    const router = new OutputRouter({ bindAddress: "192.0.2.10", routes: [] }, undefined, undefined, () => interfaces);
    expect(router.broadcastAddress()).to.equal("192.0.2.255");
    expect(router.localBroadcasts()).to.deep.equal(["255.255.255.255", "192.0.2.255"]);
    expect(router.outOfSubnet(["2.3.4.255", "192.0.2.7"])).to.deep.equal(["2.3.4.255"]);
    const client = clientOf(router);
    for (const ip of ips) expect(client(ip), ip).to.equal(router.isBroadcast(ip));
    expect(router.isBroadcast("2.3.4.255")).to.equal(true); // out of the bound /24: a remote network's broadcast, for both
  });

  it("judges on every interface when none is bound", () => {
    const router = new OutputRouter({ routes: [] }, undefined, undefined, () => interfaces);
    expect(router.localBroadcasts()).to.deep.equal(["255.255.255.255", "192.0.2.255", "2.255.255.255", "127.255.255.255"]);
    const client = clientOf(router);
    for (const ip of ips) expect(client(ip), ip).to.equal(router.isBroadcast(ip));
    expect(router.isBroadcast("2.3.4.255")).to.equal(false); // a node on the /8
  });

  it("agrees on /31 and /32 interfaces too", () => {
    const vpn = { address: "10.0.0.1", netmask: "255.255.255.255" };
    for (const iface of [{ address: "10.0.0.254", netmask: "255.255.255.254" }, vpn]) {
      const router = new OutputRouter({ bindAddress: iface.address, routes: [] }, undefined, undefined, () => [iface, ...interfaces]);
      const client = clientOf(router);
      for (const ip of [...ips, "10.0.0.255"]) expect(client(ip), `${ip} on ${iface.netmask}`).to.equal(router.isBroadcast(ip));
    }
    expect(isBroadcast("10.0.0.255", [{ address: "10.0.0.254", netmask: "255.255.255.254" }])).to.equal(false); // the /31 link's other end
    // a bound /32 judges nothing: outOfSubnet is left out, and any .255 is a broadcast for both
    const bound = new OutputRouter({ bindAddress: vpn.address, routes: [] }, undefined, undefined, () => [vpn, ...interfaces]);
    expect(bound.outOfSubnet(ips)).to.equal(undefined);
    expect(bound.isBroadcast("198.51.100.255")).to.equal(true);
    expect(outOfSubnet(["198.51.100.255"], [vpn])).to.deep.equal([]);
  });
});
