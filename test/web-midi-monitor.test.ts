import { expect } from "chai";
import { TEXTS } from "../web/src/i18n.js";
import { describeMonitor } from "../web/src/midi-monitor.js";

/** The MIDI page's monitor lines (docs/specs/midi.md): a message and what it did, or a release with its cause. */
describe("MIDI monitor lines", () => {
  const fr = TEXTS.fr;
  const wheel = [{ id: "bend", label: "Molette", mode: "momentary" }];

  it("a release says its cause, what it let go and its commands", () => {
    expect(describeMonitor({ port: "IAC Live", msg: { type: "release", cause: "input" }, matched: wheel, calls: [{ command: "look.stop", target: "hole", ok: true }], ms: 0 }, fr)).to.equal("IAC Live · relâché : entrée perdue → Molette : look.stop hole ✓");
    expect(describeMonitor({ port: "", msg: { type: "release", cause: "mapping" }, matched: wheel, calls: [{ command: "look.stop", target: "hole", ok: true }], ms: 0 }, fr)).to.equal("— · relâché : mapping modifié ou supprimé → Molette : look.stop hole ✓");
    expect(describeMonitor({ port: "RTP · Régie", msg: { type: "release", cause: "profile" }, matched: wheel, calls: [{ command: "look.stop", target: "hole", ok: true }], ms: 0 }, TEXTS.en)).to.equal("RTP · Régie · released: input closed by the profile → Molette: look.stop hole ✓");
  });

  it("a release with no end action says there is nothing to send, never « note off ignored »", () => {
    const line = describeMonitor({ port: "IAC Live", msg: { type: "release", cause: "input" }, matched: wheel, calls: [], ms: 0 }, fr);
    expect(line).to.equal("IAC Live · relâché : entrée perdue → Molette : rien à envoyer (pas d'action de fin)");
    expect(describeMonitor({ port: "IAC Live", msg: { type: "release", cause: "input" }, matched: wheel, calls: [], ms: 0 }, TEXTS.en)).to.match(/nothing to send \(no end action\)$/);
  });

  it("a message: what it matched and did, or that nothing is mapped", () => {
    expect(describeMonitor({ port: "IAC Live", msg: { type: "noteon", channel: 1, note: 50, velocity: 100 }, matched: [], calls: [], ms: 1 }, fr)).to.equal("IAC Live · noteon 1 50 100 · aucun mapping");
    expect(describeMonitor({ port: "IAC Live", msg: { type: "noteoff", channel: 1, note: 50, velocity: 0 }, matched: [{ id: "n", label: "Pad", mode: "latch" }], calls: [], ms: 1 }, fr)).to.match(/rien \(note off ignoré/);
  });
});
