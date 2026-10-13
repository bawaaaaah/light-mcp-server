import { expect } from "chai";
import { decodeSacnData, encodeSacnData, encodeSacnSync, multicastGroup } from "../../../src/plugins/light/output/sacn.js";

const cid = Buffer.from("00112233445566778899aabbccddeeff", "hex");

describe("sACN (E1.31) codec", () => {
  it("encodes a full data packet with the reference layout", () => {
    const buf = encodeSacnData({ cid, sourceName: "light-mcp-server", priority: 100, syncAddress: 0, sequence: 3, options: 0, universe: 1, data: new Uint8Array(512).fill(7) });
    expect(buf.length).to.equal(638);
    expect(buf.readUInt16BE(16)).to.equal(0x726e); // root flags+length
    expect(buf.readUInt16BE(38)).to.equal(0x7258); // framing flags+length
    expect(buf.readUInt16BE(115)).to.equal(0x720b); // DMP flags+length
    expect(buf.readUInt16BE(123)).to.equal(513);
    expect(buf[125]).to.equal(0);
  });

  it("round-trips a data packet", () => {
    const p = { cid, sourceName: "Régie", priority: 150, syncAddress: 7, sequence: 9, options: 0x20, universe: 300, data: new Uint8Array([1, 2, 3]) };
    expect(decodeSacnData(encodeSacnData(p))).to.deep.equal(p);
  });

  it("encodes a sync packet", () => {
    const buf = encodeSacnSync(cid, 5, 7);
    expect(buf.length).to.equal(49);
    expect(buf.readUInt32BE(18)).to.equal(8);
    expect(buf.readUInt16BE(45)).to.equal(7);
  });

  it("maps universes to multicast groups", () => {
    expect(multicastGroup(1)).to.equal("239.255.0.1");
    expect(multicastGroup(300)).to.equal("239.255.1.44");
  });
});
