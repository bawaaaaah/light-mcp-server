import { expect } from "chai";
import { Glide } from "../../../src/plugins/light/engine/glide.js";

describe("fader smoothing (glide)", () => {
  const linear = { curve: "linear" as const, msPerStep: 10 };

  it("takes the target at once without smoothing", () => {
    const g = new Glide();
    expect(g.value("f", 0, undefined, 0)).to.equal(0);
    expect(g.value("f", 1, undefined, 1)).to.equal(1);
    expect(g.moving(1)).to.deep.equal({});
  });

  it("does not glide from nowhere on first sight", () => {
    const g = new Glide();
    expect(g.value("f", 0.8, linear, 0)).to.equal(0.8);
  });

  it("glides at a fixed speed: msPerStep per 1/255 of the travel", () => {
    const g = new Glide();
    g.value("f", 0, linear, 0);
    expect(g.value("f", 1, linear, 0)).to.equal(0); // starts where the output is
    expect(g.value("f", 1, linear, 1275)).to.be.closeTo(0.5, 1e-9); // 255 steps × 10 ms = 2550 ms
    expect(g.moving(1275)).to.deep.equal({ f: 0.5 });
    expect(g.value("f", 1, linear, 2550)).to.equal(1);
    expect(g.moving(2550)).to.deep.equal({});
    // half the travel takes half the time
    g.value("f", 0.5, linear, 3000);
    expect(g.value("f", 0.5, linear, 3000 + 1275)).to.equal(0.5);
  });

  it("eases in and out over the same time", () => {
    const g = new Glide();
    const ease = { curve: "ease" as const, msPerStep: 10 };
    g.value("f", 0, ease, 0);
    g.value("f", 1, ease, 0);
    const early = g.value("f", 1, ease, 255);
    expect(early).to.be.below(0.1); // slow start (linear would be 0.1)
    expect(g.value("f", 1, ease, 1275)).to.be.closeTo(0.5, 1e-9);
    expect(g.value("f", 1, ease, 2295)).to.be.closeTo(1 - early, 1e-9); // symmetrical
    expect(g.value("f", 1, ease, 2550)).to.equal(1);
  });

  it("starts again from the output when the fader moves mid-glide, never jumps", () => {
    const g = new Glide();
    g.value("f", 0, linear, 0);
    g.value("f", 1, linear, 0);
    expect(g.value("f", 1, linear, 1275)).to.be.closeTo(0.5, 1e-9);
    expect(g.value("f", 0, linear, 1275)).to.be.closeTo(0.5, 1e-9); // back down, from 0.5
    expect(g.value("f", 0, linear, 1275 + 637.5)).to.be.closeTo(0.25, 1e-9);
  });

  it("applies at once when smoothing is switched off mid-glide", () => {
    const g = new Glide();
    g.value("f", 0, linear, 0);
    g.value("f", 1, linear, 0);
    expect(g.value("f", 1, undefined, 100)).to.equal(1);
    expect(g.moving(100)).to.deep.equal({});
  });

  it("lets a glide nobody reads any more (a deleted fader) end on its own", () => {
    const g = new Glide();
    g.value("f", 0, linear, 0);
    g.value("f", 1, linear, 0);
    expect(Object.keys(g.moving(10))).to.deep.equal(["f"]);
    expect(g.moving(5000)).to.deep.equal({});
  });
});
