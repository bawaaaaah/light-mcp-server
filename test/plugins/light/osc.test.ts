import { expect } from "chai";
import { decodeOsc, encodeOsc, matchRoute } from "../../../src/plugins/light/osc/codec.js";

describe("OSC codec", () => {
  it("encodes a message byte for byte", () => {
    const buf = encodeOsc({ address: "/light/panic", args: [] });
    expect(buf.toString("hex")).to.equal("2f6c696768742f70616e6963000000002c000000");
  });

  it("round-trips int, float, string and booleans", () => {
    const msg = { address: "/light/group/ambiance/level", args: [1, 0.5, "réglage", true, false, null] };
    const back = decodeOsc(encodeOsc(msg))[0]!;
    expect(back.address).to.equal(msg.address);
    expect(back.args).to.deep.equal([1, 0.5, "réglage", true, false, null]);
  });

  it("forces a float type when asked", () => {
    const back = decodeOsc(encodeOsc({ address: "/x", args: [{ type: "f", value: 1 }] }))[0]!;
    expect(back.args).to.deep.equal([1]);
    expect(encodeOsc({ address: "/x", args: [{ type: "f", value: 1 }] }).toString("ascii", 4, 6)).to.equal(",f");
  });

  it("flattens bundles", () => {
    const m1 = encodeOsc({ address: "/a", args: [1] });
    const m2 = encodeOsc({ address: "/b", args: ["x"] });
    const size = (b: Buffer) => {
      const s = Buffer.alloc(4);
      s.writeInt32BE(b.length);
      return s;
    };
    const bundle = Buffer.concat([Buffer.from("#bundle\0"), Buffer.alloc(8), size(m1), m1, size(m2), m2]);
    expect(decodeOsc(bundle).map((m) => m.address)).to.deep.equal(["/a", "/b"]);
  });

  it("matches route patterns", () => {
    expect(matchRoute("/light/group/{id}/level", "/light/group/led%20bar/level")).to.deep.equal({ id: "led bar" });
    expect(matchRoute("/light/group/{id}/level", "/light/group/x/mute")).to.equal(null);
  });
});
