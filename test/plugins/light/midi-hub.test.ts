import { expect } from "chai";
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

  it("works without local MIDI and receives RTP-MIDI", async () => {
    const hub = new MidiHub({ inputs: [], rtp: { enabled: true, port: 15204, name: "hub" } }, { native: null });
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
});
