import { expect } from "chai";
import {
  OpCode,
  decodeDmx,
  decodePollReply,
  encodeDmx,
  encodePoll,
  encodePollReply,
  encodeSync,
  portAddress,
  readOpCode,
  splitPortAddress,
} from "../../../src/plugins/light/output/artnet.js";

describe("Art-Net codec", () => {
  it("builds the 15-bit port-address and splits it back", () => {
    const pa = portAddress(1, 2, 3);
    expect(pa).to.equal(0x123);
    expect(splitPortAddress(pa)).to.deep.equal({ net: 1, subNet: 2, universe: 3 });
  });

  it("encodes ArtPoll byte for byte", () => {
    const buf = encodePoll();
    expect(buf.toString("hex")).to.equal("4172742d4e6574000020000e0200");
    expect(readOpCode(buf)).to.equal(OpCode.Poll);
  });

  it("encodes ArtDmx with an even length and Net/SubUni split", () => {
    const data = new Uint8Array([255, 128, 1]);
    const buf = encodeDmx({ sequence: 7, physical: 0, portAddress: portAddress(1, 0, 5), data });
    expect(buf.length).to.equal(18 + 4);
    expect(buf.readUInt16LE(8)).to.equal(OpCode.Dmx);
    expect(buf.readUInt16BE(10)).to.equal(14);
    expect(buf[12]).to.equal(7);
    expect(buf[14]).to.equal(0x05); // SubUni
    expect(buf[15]).to.equal(0x01); // Net
    expect(buf.readUInt16BE(16)).to.equal(4);
    const back = decodeDmx(buf)!;
    expect(back.portAddress).to.equal(portAddress(1, 0, 5));
    expect(Array.from(back.data)).to.deep.equal([255, 128, 1, 0]);
  });

  it("encodes a full 512-channel universe", () => {
    const buf = encodeDmx({ sequence: 1, physical: 0, portAddress: 0, data: new Uint8Array(512).fill(9) });
    expect(buf.length).to.equal(530);
    expect(decodeDmx(buf)!.data.length).to.equal(512);
  });

  it("encodes ArtSync", () => {
    expect(readOpCode(encodeSync())).to.equal(OpCode.Sync);
  });

  it("decodes an ArtPollReply and derives its output port-addresses", () => {
    const buf = encodePollReply({
      ip: "10.0.0.40",
      shortName: "Node A",
      longName: "Test node, two outputs",
      netSwitch: 0,
      subSwitch: 1,
      swOut: [0, 1],
      mac: "de:ad:be:ef:00:01",
    });
    const reply = decodePollReply(buf)!;
    expect(reply.ip).to.equal("10.0.0.40");
    expect(reply.shortName).to.equal("Node A");
    expect(reply.longName).to.equal("Test node, two outputs");
    expect(reply.numPorts).to.equal(2);
    expect(reply.outputAddresses).to.deep.equal([portAddress(0, 1, 0), portAddress(0, 1, 1)]);
    expect(reply.mac).to.equal("de:ad:be:ef:00:01");
  });

  it("rejects non Art-Net and truncated packets", () => {
    expect(readOpCode(Buffer.from("hello world"))).to.equal(null);
    expect(decodePollReply(encodePoll())).to.equal(null);
    expect(decodeDmx(encodePoll())).to.equal(null);
  });
});
