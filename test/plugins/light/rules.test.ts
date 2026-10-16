import { expect } from "chai";
import { readFileSync } from "node:fs";
import { parseQxf } from "../../../src/plugins/light/venue/qxf-import.js";
import { applyRules, effectiveRule, RuleSchema } from "../../../src/plugins/light/rules/rules.js";
import type { ResolvedFixture } from "../../../src/plugins/light/venue/venue.js";

const def = parseQxf(readFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), "utf8"));
const fx: ResolvedFixture = {
  patch: { id: "bar", name: "Barre", manufacturer: "Test", model: "Bar 4", mode: "15 Channel", universe: 1, address: 1, tags: [] },
  def,
  mode: def.modes[0]!,
  heads: new Map(),
  dimmers: [0],
  strobes: [1],
  panMax: 540,
  tiltMax: 270,
  shutterOpen: new Map(),
  lampOnly: false,
};
const rule = (r: unknown) => RuleSchema.parse(r);

describe("rules mask", () => {
  it("keeps a strobe under a frequency where the definition gives it, and leaves it free where not", () => {
    const xml = readFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), "utf8").replace('Preset="StrobeSlowToFast"', 'Preset="StrobeFreqRange" Res1="1" Res2="25"');
    const withHz = parseQxf(xml);
    expect(withHz.channels.get("Strobe")!.capabilities[1]!.hz).to.deep.equal([1, 25]);
    const strobe = { ...fx, def: withHz, mode: withHz.modes[0]! };
    const limit = (value: number, maxHz: number, target = strobe) => {
      const buf = new Uint8Array(512);
      buf[1] = value;
      applyRules([rule({ id: "photo", level: "venue", target: { attribute: "strobe" }, maxHz })], target, buf);
      return buf[1];
    };
    expect(limit(255, 10)).to.equal(102); // 25 Hz → the fastest setting at or under 10 Hz
    expect(limit(50, 10)).to.equal(50); // ≈ 4.8 Hz: free
    expect(limit(255, 0.5)).to.equal(10); // even 1 Hz is too fast: just outside the range (strobe off)
    expect(limit(255, 10, fx)).to.equal(255); // no frequencies in this definition: no effect
  });

  it("imposes a minimum value on a fixture type channel (a bar black under 32)", () => {
    const buf = new Uint8Array(512);
    const clamps = applyRules([rule({ id: "strobing-min", level: "type", scope: { model: "Bar 4" }, target: { channel: "Strobe" }, min: 32 })], fx, buf);
    expect(buf[1]).to.equal(32);
    expect(clamps).to.deep.equal([{ fixture: "bar", channel: "Strobe", from: 0, to: 32, rule: "strobing-min" }]);
  });

  it("moves a value out of forbidden capabilities (sound-active, auto programs)", () => {
    const buf = new Uint8Array(512);
    buf[2] = 200; // Program channel: 192-255 Sound Control
    applyRules([rule({ id: "no-sound", level: "venue", target: { attribute: "effect" }, forbidTags: ["soundActive", "autoProgram"] })], fx, buf);
    expect(buf[2]).to.equal(127); // nearest allowed: Manual 0-127
  });

  it("caps an attribute (UV-like max) and keeps values otherwise free", () => {
    const buf = new Uint8Array(512);
    buf[3] = 250;
    buf[4] = 250;
    applyRules([rule({ id: "red-max", target: { color: "red" }, max: 100 })], fx, buf);
    expect([buf[3], buf[4]]).to.deep.equal([100, 250]);
  });

  it("lets the most specific level win, unless a broader rule is locked", () => {
    const venueMax = rule({ id: "venue-max", level: "venue", target: { attribute: "intensity" }, max: 150 });
    const showMax = rule({ id: "show-max", level: "show", target: { attribute: "intensity" }, min: 200 });
    let buf = new Uint8Array(512);
    buf[0] = 255;
    applyRules([venueMax, showMax], fx, buf);
    expect(buf[0]).to.equal(255); // contradictory bounds: the show's min (more specific) wins, the venue max no longer applies
    buf = new Uint8Array(512);
    buf[0] = 255;
    applyRules([{ ...venueMax, locked: true }, showMax], fx, buf);
    expect(buf[0]).to.equal(150); // locked venue bound cannot be relaxed
  });

  it("lets a show relax a fixture type's limit, scope by scope, and says where each bound comes from", () => {
    const typeMax = rule({ id: "type-uv", level: "type", scope: { model: "Bar 4" }, target: { attribute: "intensity" }, max: 128 });
    const showMax = rule({ id: "show-uv", level: "show", target: { attribute: "intensity" }, max: 200 });
    const one = rule({ id: "this-one", level: "show", scope: { fixture: "bar" }, target: { attribute: "intensity" }, max: 100 });
    const buf = new Uint8Array(512);
    buf[0] = 255;
    applyRules([typeMax, showMax], fx, buf);
    expect(buf[0]).to.equal(200); // relaxed by the show (sequential clamps used to give 128)
    buf[0] = 255;
    applyRules([typeMax, showMax, one], fx, buf);
    expect(buf[0]).to.equal(100); // within the show, the fixture-scoped rule is more specific
    const ch = fx.def.channels.get(fx.mode.channels[0]!)!;
    expect(effectiveRule([typeMax, showMax, one], fx, ch)).to.deep.include({ max: 100, from: { max: "this-one" } });
  });
});
