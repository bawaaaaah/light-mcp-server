import { expect } from "chai";
import { createSocket } from "node:dgram";
import { MidiHub, type HubMessage } from "../../../src/plugins/light/midi/hub.js";
import { RtpMidiSession } from "../../../src/plugins/light/midi/rtp/session.js";

/** Fake native MIDI layer: ports can appear/disappear and inputs can be fed. */
function fakeNative() {
  const state = { inputs: ["IAC Bus 1", "USB Pad"], outputs: ["IAC Bus 1", "USB Pad", "LED Out"], sent: [] as { port: string; bytes: number[] }[] };
  const handlers = new Map<string, (d: number, m: number[]) => void>();
  class Input {
    private h?: (d: number, m: number[]) => void;
    getPortCount() {
      return state.inputs.length;
    }
    getPortName(i: number) {
      return state.inputs[i]!;
    }
    openPort(i: number) {
      handlers.set(state.inputs[i]!, (d, m) => this.h?.(d, m));
    }
    closePort() {}
    ignoreTypes() {}
    on(_e: "message", fn: (d: number, m: number[]) => void) {
      this.h = fn;
    }
  }
  class Output {
    private name = "";
    getPortCount() {
      return state.outputs.length;
    }
    getPortName(i: number) {
      return state.outputs[i]!;
    }
    openPort(i: number) {
      this.name = state.outputs[i]!;
    }
    closePort() {}
    sendMessage(bytes: number[]) {
      state.sent.push({ port: this.name, bytes });
    }
  }
  return { native: { Input, Output }, state, feed: (port: string, bytes: number[]) => handlers.get(port)?.(0, bytes) };
}

describe("MIDI hub", () => {
  it("opens watched inputs only and normalises their messages", () => {
    const f = fakeNative();
    const hub = new MidiHub({ inputs: ["iac"], rtp: { enabled: false, port: 0, name: "t" } }, { native: f.native });
    const got: HubMessage[] = [];
    hub.on("message", (m: HubMessage) => got.push(m));
    hub.scan();
    f.feed("IAC Bus 1", [0x90, 36, 100]);
    f.feed("USB Pad", [0x90, 37, 100]);
    expect(got.map((m) => [m.port, m.msg.type])).to.deep.equal([["IAC Bus 1", "noteon"]]);
    expect(hub.status().inputs.find((i) => i.name === "IAC Bus 1")!.lastMessageAt).to.be.a("number");
  });

  it("detects hot-plugged ports and opens a watched one automatically", () => {
    const f = fakeNative();
    const hub = new MidiHub({ inputs: ["launchpad"], rtp: { enabled: false, port: 0, name: "t" } }, { native: f.native });
    const events: unknown[] = [];
    hub.on("ports", (e: unknown) => events.push(e));
    hub.scan();
    f.state.inputs.push("Launchpad X");
    hub.scan();
    expect(events.at(-1)).to.deep.equal({ appeared: ["Launchpad X"] });
    expect(hub.status().inputs.find((i) => i.name === "Launchpad X")!.open).to.equal(true);
  });

  it("refuses a feedback port that is also a watched input", () => {
    const f = fakeNative();
    const hub = new MidiHub({ inputs: ["iac"], feedbackOutput: "iac", rtp: { enabled: false, port: 0, name: "t" } }, { native: f.native });
    const warnings: string[] = [];
    hub.on("warning", (w: string) => warnings.push(w));
    hub.scan();
    hub.sendFeedback([[0x90, 36, 127]]);
    expect(warnings[0]).to.match(/boucle/);
    expect(f.state.sent).to.deep.equal([]);
  });

  it("sends feedback to a distinct output", () => {
    const f = fakeNative();
    const hub = new MidiHub({ inputs: ["usb"], feedbackOutput: "led", rtp: { enabled: false, port: 0, name: "t" } }, { native: f.native });
    hub.scan();
    hub.sendFeedback([[0x90, 36, 127]]);
    expect(f.state.sent).to.deep.equal([{ port: "LED Out", bytes: [0x90, 36, 127] }]);
  });

  it("sends the MIDI clock to its own output, never to a watched input", () => {
    const f = fakeNative();
    const hub = new MidiHub({ inputs: ["iac"], feedbackOutput: "LED", clockOutput: "USB Pad", rtp: { enabled: false, port: 0, name: "t" } }, { native: f.native });
    hub.scan();
    hub.sendClock([0xf8]);
    hub.sendFeedback([[0x90, 36, 127]]);
    expect(f.state.sent).to.deep.equal([
      { port: "USB Pad", bytes: [0xf8] },
      { port: "LED Out", bytes: [0x90, 36, 127] },
    ]);
    expect(hub.status().clock).to.equal("USB Pad");
    // the interface unplugged: the driver throws, the hub drops the port and the server keeps going
    const unplugged: string[] = [];
    hub.on("warning", (w: string) => unplugged.push(w));
    (hub as unknown as { clockPort: { out: { sendMessage: () => void } } }).clockPort.out.sendMessage = () => {
      throw new Error("port closed");
    };
    expect(() => hub.sendClock([0xf8])).to.not.throw();
    expect(hub.status().clock).to.equal(undefined);
    expect(unplugged[0]).to.match(/horloge MIDI : port closed/);
    const warnings: string[] = [];
    const looped = new MidiHub({ inputs: ["iac"], clockOutput: "IAC", rtp: { enabled: false, port: 0, name: "t" } }, { native: f.native });
    looped.on("warning", (w: string) => warnings.push(w));
    looped.scan();
    expect(looped.status().clock).to.equal(undefined); // the tempo would follow its own clock
    expect(warnings[0]).to.match(/horloge MIDI refusé/);
  });

  it("works without local MIDI and receives RTP-MIDI", async () => {
    const hub = new MidiHub({ inputs: [], rtp: { enabled: true, port: 15204, name: "hub", advertise: false } }, { native: null });
    expect(hub.localAvailable).to.equal(false);
    await hub.start();
    const remote = new RtpMidiSession({ name: "Régie", port: 15206, host: "127.0.0.1" });
    await remote.start();
    try {
      await remote.invite("127.0.0.1", 15204);
      const got = new Promise<HubMessage>((res) => hub.once("message", res));
      remote.send([[0xb0, 7, 64]]);
      const m = await got;
      expect(m.source).to.equal("rtp");
      expect(m.port).to.equal("RTP · Régie");
      expect(m.msg).to.deep.equal({ type: "cc", channel: 1, controller: 7, value: 64 });
    } finally {
      remote.stop();
      hub.stop();
    }
  });

  it("takes the next free port when its own is held, and says which", async () => {
    // On a Mac, the system's own network MIDI session usually holds 5004.
    const squatter = createSocket("udp4");
    await new Promise<void>((res) => squatter.bind(15304, "0.0.0.0", res));
    const hub = new MidiHub({ inputs: [], rtp: { enabled: true, port: 15304, name: "hub", advertise: false } }, { native: null });
    try {
      await hub.start();
      expect(hub.status().rtp).to.deep.include({ port: 15306, wanted: 15304, error: undefined });
    } finally {
      hub.stop();
      squatter.close();
    }
  });

  it("joins a session by address, leaves it, and joins again by itself one it keeps", async () => {
    const hub = new MidiHub({ inputs: [], rtp: { enabled: true, port: 15404, name: "hub", advertise: false, connect: ["Régie"] } }, { native: null });
    await hub.start();
    const remote = new RtpMidiSession({ name: "Régie", port: 15406, host: "127.0.0.1" });
    await remote.start();
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 300 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
      expect(ok()).to.equal(true);
    };
    try {
      expect(await hub.rtpConnect({ address: "127.0.0.1", port: 15406 })).to.deep.equal({ name: "Régie", address: "127.0.0.1", port: 15406 });
      await until(() => remote.listPeers().length === 1);
      expect(hub.status().rtp.peers).to.deep.equal(["Régie (127.0.0.1)"]);
      expect(hub.rtpDisconnect("Régie")).to.equal(true);
      await until(() => remote.listPeers().length === 0);
      // found on the network (Bonjour stands in here), kept: joined again within seconds
      (hub as unknown as { browser: object }).browser = { ask: () => undefined, list: () => [{ name: "Régie", host: "regie", port: 15406, addresses: ["127.0.0.1"] }], stop: async () => undefined };
      expect(hub.rtpSessions()).to.deep.equal([{ name: "Régie", host: "regie", address: "127.0.0.1", port: 15406, connected: false, kept: true, self: false }]);
      (hub as unknown as { joinKept: () => void }).joinKept();
      await until(() => hub.rtpSessions()[0]!.connected);
      await hub.rtpConnect({ name: "Nulle part" }).then(
        () => expect.fail("not on the network"),
        (e: Error) => expect(e.message).to.match(/introuvable/),
      );
    } finally {
      remote.stop();
      hub.stop();
    }
  });
});
