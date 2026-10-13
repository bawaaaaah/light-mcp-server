import { expect } from "chai";
import { readFileSync } from "node:fs";
import { parseQxf } from "../../../src/plugins/light/venue/qxf-import.js";
import { applyRules, RuleSchema } from "../../../src/plugins/light/rules/rules.js";
import type { ResolvedFixture } from "../../../src/plugins/light/venue/venue.js";

const def = parseQxf(readFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), "utf8"));
const fx: ResolvedFixture = {
  patch: { id: "bar", name: "Barre", manufacturer: "Test", model: "Bar 4", mode: "15 Channel", universe: 1, address: 1, tags: [] },
  def,
  mode: def.modes[0]!,
  heads: new Map(),
  dimmers: [0],
  strobes: [1],
};
const rule = (r: unknown) => RuleSchema.parse(r);

describe("rules mask", () => {
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
    expect(buf[0]).to.equal(200); // show (more specific) wins
    buf = new Uint8Array(512);
    buf[0] = 255;
    applyRules([{ ...venueMax, locked: true }, showMax], fx, buf);
    expect(buf[0]).to.equal(150); // locked venue bound cannot be relaxed
  });
});
