import { expect } from "chai";
import { broadcastTest } from "../web/src/broadcast.js";
import { isBroadcast, localBroadcasts } from "../src/plugins/light/output/subnet.js";

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
