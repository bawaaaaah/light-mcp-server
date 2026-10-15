import { expect } from "chai";
import { createSocket } from "node:dgram";
import { decodeControl, decodeRtpMidi, encodeControl, encodeRtpMidi } from "../../../src/plugins/light/midi/rtp/applemidi.js";
import { RtpMidiSession } from "../../../src/plugins/light/midi/rtp/session.js";

describe("AppleMIDI codec", () => {
  it("round-trips an invitation", () => {
    const buf = encodeControl({ command: "IN", version: 2, token: 0xdeadbeef, ssrc: 42, name: "Régie" });
    expect(buf.subarray(0, 4).toString("hex")).to.equal("ffff494e");
    expect(decodeControl(buf)).to.deep.equal({ command: "IN", version: 2, token: 0xdeadbeef, ssrc: 42, name: "Régie" });
  });

  it("round-trips a clock sync", () => {
    const p = { command: "CK" as const, ssrc: 7, count: 1, timestamps: [1n, 2n, 0n] as [bigint, bigint, bigint] };
    expect(decodeControl(encodeControl(p))).to.deep.equal(p);
  });

  it("round-trips an RTP-MIDI command list, short and long headers", () => {
    const short = { sequence: 1, timestamp: 100, ssrc: 9, messages: [[0x90, 36, 100], [0x80, 36, 0]] };
    expect(decodeRtpMidi(encodeRtpMidi(short))).to.deep.equal(short);
    const many = Array.from({ length: 10 }, (_, i) => [0xb0, i, i * 10]);
    const long = { sequence: 2, timestamp: 200, ssrc: 9, messages: many };
    expect(decodeRtpMidi(encodeRtpMidi(long))).to.deep.equal(long);
  });

  it("decodes running status and a program change", () => {
    // header: Z=0, len=7 → 0x90 36 100, delta 0, (running) 38 90, delta 0, 0xC0 5
    const payload = Buffer.from([0x08, 0x90, 36, 100, 0x00, 38, 90, 0x00, 0xc0]);
    const rtp = Buffer.concat([Buffer.from([0x80, 0x61, 0, 1, 0, 0, 0, 0, 0, 0, 0, 5]), payload, Buffer.from([5])]);
    rtp[12] = 0x09; // length 9
    expect(decodeRtpMidi(rtp)!.messages).to.deep.equal([
      [0x90, 36, 100],
      [0x90, 38, 90],
      [0xc0, 5],
    ]);
  });
});

describe("RTP-MIDI session (loopback)", () => {
  it("invites, syncs clocks and carries MIDI both ways", async () => {
    const a = new RtpMidiSession({ name: "A", port: 15004, host: "127.0.0.1" });
    const b = new RtpMidiSession({ name: "B", port: 15006, host: "127.0.0.1" });
    await a.start();
    await b.start();
    try {
      const synced = new Promise((res) => a.once("clockSync", res));
      const peer = await a.invite("127.0.0.1", 15006);
      expect(peer.name).to.equal("B");
      await synced;
      const gotB = new Promise<number[]>((res) => b.once("midi", res));
      a.send([[0x90, 36, 100]]);
      expect(await gotB).to.deep.equal([0x90, 36, 100]);
      const gotA = new Promise<number[]>((res) => a.once("midi", res));
      b.send([[0xb0, 7, 64]]);
      expect(await gotA).to.deep.equal([0xb0, 7, 64]);
    } finally {
      a.stop();
      b.stop();
    }
  });

  it("rejects when its port is taken instead of waiting forever", async () => {
    const squatter = createSocket("udp4");
    await new Promise<void>((res) => squatter.bind(15104, "127.0.0.1", res));
    const session = new RtpMidiSession({ name: "A", port: 15104, host: "127.0.0.1" });
    try {
      let error: Error | undefined;
      await session.start().catch((err: Error) => (error = err));
      expect(error?.message).to.match(/EADDRINUSE/);
    } finally {
      squatter.close();
    }
  });
});
