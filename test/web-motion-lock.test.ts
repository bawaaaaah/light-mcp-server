import { expect } from "chai";
import { groupLevels, planLock, tapTarget } from "../web/src/motionLock.js";
import { ARM_MS, CONFIRM_MIN_MS, confirms } from "../web/src/confirm.js";

describe("motion lock controls: which commands a choice sends (T26, lot 4)", () => {
  const desk = { freeze: true, position: true };
  const volunteer = { freeze: true, position: false };
  const nobody = { freeze: false, position: false };
  const at = (base: "off" | "soft" | "hard", top = base) => ({ base, top });
  const freeze = (level: "soft" | "hard") => ({ command: "motion.freeze", args: { level } });
  const unfreeze = (to: "off" | "soft") => ({ command: "motion.unfreeze", args: { to } });

  it("a press freezes soft when free and frees when frozen at any level (decision Q1)", () => {
    expect(tapTarget("off")).to.equal("soft");
    expect(tapTarget("soft")).to.equal("off");
    expect(tapTarget("hard")).to.equal("off");
    // decision V2: a role that may not unfreeze freezes what is still free; frozen everywhere, the press is « off »
    expect(tapTarget("hard", true, false)).to.equal("soft");
    expect(tapTarget("hard", true, true)).to.equal("off");
    expect(tapTarget("soft", false, false)).to.equal("off");
  });

  it("freezes only harder, unfreezes only looser, as the server does", () => {
    expect(planLock(at("off"), "soft", desk)).to.deep.equal({ calls: [freeze("soft")], confirm: false });
    expect(planLock(at("soft"), "hard", desk)).to.deep.equal({ calls: [freeze("hard")], confirm: false });
    expect(planLock(at("soft"), "off", desk)).to.deep.equal({ calls: [unfreeze("off")], confirm: false });
    expect(planLock(at("soft"), "soft", desk)).to.deep.equal({ blocked: "same" });
  });

  it("asks a second press to loosen a hard lock, to free or to soft", () => {
    expect(planLock(at("hard"), "off", desk)).to.deep.equal({ calls: [unfreeze("off")], confirm: true });
    expect(planLock(at("hard"), "soft", desk)).to.deep.equal({ calls: [unfreeze("soft")], confirm: true });
  });

  it("some heads frozen alone: the target ends whole at the level chosen; « Défiger » lifts everything (decision U2)", () => {
    // global off, one head hard: « Figées » loosens it to soft, then freezes soft everywhere
    expect(planLock(at("off", "hard"), "soft", desk)).to.deep.equal({ calls: [unfreeze("soft"), freeze("soft")], confirm: true });
    expect(planLock(at("off", "soft"), "soft", desk)).to.deep.equal({ calls: [freeze("soft")], confirm: false });
    expect(planLock(at("off", "soft"), "off", desk)).to.deep.equal({ calls: [unfreeze("off")], confirm: false });
    expect(planLock(at("off", "soft"), "hard", desk)).to.deep.equal({ calls: [freeze("hard")], confirm: false });
  });

  it("rights: the Volunteer freezes soft only; no right, nothing (decisions Q2 + Q6)", () => {
    expect(planLock(at("off"), "soft", volunteer)).to.deep.equal({ calls: [freeze("soft")], confirm: false });
    expect(planLock(at("off"), "hard", volunteer)).to.deep.equal({ blocked: "position" });
    expect(planLock(at("soft"), "off", volunteer)).to.deep.equal({ blocked: "position" });
    expect(planLock(at("off"), "soft", nobody)).to.deep.equal({ blocked: "freeze" });
  });

  it("decision V2: the desk's « Figées » sets every head soft, hard ones included; the Volunteer's freezes what is free and leaves hard ones", () => {
    expect(planLock(at("hard"), "soft", desk)).to.deep.equal({ calls: [unfreeze("soft")], confirm: true });
    expect(planLock(at("off", "hard"), "soft", volunteer)).to.deep.equal({ calls: [freeze("soft")], confirm: false });
    // nothing free any more: freezing soft would loosen, which the Volunteer may not
    expect(planLock(at("soft", "hard"), "soft", volunteer)).to.deep.equal({ blocked: "position" });
    expect(planLock(at("hard"), "soft", volunteer)).to.deep.equal({ blocked: "position" });
  });

  it("a confirmation needs a second press at least CONFIRM_MIN_MS after the first, within ARM_MS (decision B1)", () => {
    const arm = { key: "off", at: 1000 };
    expect(confirms(arm, "off", 1000 + CONFIRM_MIN_MS - 1)).to.equal(false); // a double click, a held key
    expect(confirms(arm, "off", 1000 + CONFIRM_MIN_MS)).to.equal(true);
    expect(confirms(arm, "soft", 1000 + CONFIRM_MIN_MS)).to.equal(false);
    expect(confirms(arm, "off", 1000 + ARM_MS)).to.equal(false);
    expect(confirms(null, "off", 5000)).to.equal(false);
  });

  it("a group: freezing hardens from its loosest head, loosening starts from its strictest", () => {
    expect(groupLevels([])).to.deep.equal({ base: "off", top: "off" });
    expect(groupLevels(["off", "hard"])).to.deep.equal({ base: "off", top: "hard" });
    expect(groupLevels(["soft", "soft"])).to.deep.equal({ base: "soft", top: "soft" });
  });
});
