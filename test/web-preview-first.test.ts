import { expect } from "chai";
import { SHEET_GUARD_MS, guardPassed, asksBeforeLaunch } from "../web/src/preview-first.js";

describe("preview before launch: guard timing", () => {
  it("SHEET_GUARD_MS is 400", () => {
    expect(SHEET_GUARD_MS).to.equal(400);
  });
  it("the guard is not passed exactly 400 ms later", () => {
    expect(guardPassed(400, 0)).to.equal(false);
  });
  it("the guard is passed 401 ms later", () => {
    expect(guardPassed(401, 0)).to.equal(true);
  });
  it("is not passed at 0 ms", () => {
    expect(guardPassed(0, 0)).to.equal(false);
  });
  it("is not passed when the clock went backwards", () => {
    expect(guardPassed(0, 100)).to.equal(false);
  });
});

describe("preview before launch: asking before launch", () => {
  it("never asks when on is false, whatever the mode", () => {
    for (const mode of [undefined, "latch", "toggle", "trigger", "momentary", "unknown"] as (string | undefined)[]) {
      for (const playing of [false, true]) {
        expect(asksBeforeLaunch({ on: false, mode, playing })).to.equal(false);
      }
    }
  });
  it("asks for undefined, latch, toggle and trigger (not playing) when on is true", () => {
    expect(asksBeforeLaunch({ on: true, mode: undefined, playing: false })).to.equal(true);
    expect(asksBeforeLaunch({ on: true, mode: "latch", playing: false })).to.equal(true);
    expect(asksBeforeLaunch({ on: true, mode: "toggle", playing: false })).to.equal(true);
    expect(asksBeforeLaunch({ on: true, mode: "trigger", playing: false })).to.equal(true);
  });
  it("does not ask for trigger when the look is playing", () => {
    expect(asksBeforeLaunch({ on: true, mode: "trigger", playing: true })).to.equal(false);
  });
  it("never asks for momentary, playing or not", () => {
    expect(asksBeforeLaunch({ on: true, mode: "momentary", playing: false })).to.equal(false);
    expect(asksBeforeLaunch({ on: true, mode: "momentary", playing: true })).to.equal(false);
  });
  it("asks for latch and toggle even when the look is playing", () => {
    expect(asksBeforeLaunch({ on: true, mode: "latch", playing: true })).to.equal(true);
    expect(asksBeforeLaunch({ on: true, mode: "toggle", playing: true })).to.equal(true);
  });
  it("an unknown mode behaves like latch", () => {
    expect(asksBeforeLaunch({ on: true, mode: "bogus", playing: false })).to.equal(true);
    expect(asksBeforeLaunch({ on: true, mode: "bogus", playing: true })).to.equal(true);
  });
});
