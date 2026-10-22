import { expect } from "chai";
import { ClockOut } from "../../../src/plugins/light/timing/clock-out.js";

describe("MIDI clock out", () => {
  const setup = () => {
    const now = { beats: 0, source: "manual" };
    const sent: number[][] = [];
    const out = new ClockOut(() => now, (b) => sent.push(b));
    return { now, sent, out };
  };

  it("sends 24 clocks per beat as the light's beats go by, and only clocks (no Start that would roll a transport)", () => {
    const { now, sent, out } = setup();
    out.tick(); // the first call only takes the count
    for (let i = 1; i <= 200; i++) {
      now.beats = i / 100; // two beats, a tick every hundredth of a beat
      out.tick();
    }
    expect(sent).to.have.length(48);
    expect(sent.every((b) => b.length === 1 && b[0] === 0xf8)).to.equal(true);
  });

  it("is silent while the tempo follows an incoming MIDI clock, and after a stall sends one clock, not a burst", () => {
    const { now, sent, out } = setup();
    now.source = "midi";
    out.tick();
    now.beats = 4;
    out.tick();
    expect(sent).to.deep.equal([]); // never echoes the clock it follows
    now.source = "manual";
    out.tick(); // starts afresh
    now.beats = 10; // six beats without a call: a busy machine
    out.tick();
    expect(sent).to.have.length(1);
    now.beats = 10 + 1 / 24;
    out.tick();
    expect(sent).to.have.length(2);
  });
});
