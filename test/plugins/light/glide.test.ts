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

  describe("eased glides keep their speed when the target moves", () => {
    const ease = { curve: "ease" as const, msPerStep: 10 }; // a full travel in 2550 ms
    /** Plays frames every `step` ms from `from` to `to`, the target given by `target(t)`; the levels sent. */
    const play = (g: Glide, target: (t: number) => number, from: number, to: number, step = 10) => {
      const out: number[] = [];
      for (let t = from; t <= to; t += step) out.push(g.value("f", target(t), ease, t));
      return out;
    };

    it("follows a MIDI fader pushed up step by step, never stuck in a new ease in", () => {
      const g = new Glide();
      g.value("f", 0, ease, 0);
      // a fader pushed from 0 to 100 % in 1 s, a CC every 10 ms
      const fader = (t: number) => Math.min(1, Math.round((t / 1000) * 127) / 127);
      const sent = play(g, fader, 0, 4000);
      for (let i = 1; i < sent.length; i++) expect(sent[i]!).to.be.at.least(sent[i - 1]! - 1e-12); // never back
      expect(Math.max(...sent)).to.be.at.most(1); // never past the fader
      // half-way through the nominal 2.55 s, the output is well on its way (a restart at every CC kept it near 0)
      expect(sent[Math.round(1275 / 10)]!).to.be.above(0.3);
      expect(sent[sent.length - 1]).to.equal(1);
      expect(g.moving(4000)).to.deep.equal({});
    });

    it("speed carries over: no drop to standstill when the target moves on", () => {
      const g = new Glide();
      g.value("f", 0, ease, 0);
      g.value("f", 0.5, ease, 0);
      const before = g.value("f", 0.5, ease, 600) - g.value("f", 0.5, ease, 590);
      g.value("f", 1, ease, 600); // the fader goes on up
      const after = g.value("f", 1, ease, 610) - g.value("f", 1, ease, 600);
      expect(after).to.be.closeTo(before, before * 0.2); // still moving at about the same speed
    });

    it("never passes a target close ahead of a fast output", () => {
      const g = new Glide();
      g.value("f", 0, ease, 0);
      g.value("f", 1, ease, 0);
      g.value("f", 1, ease, 1275); // halfway, at full speed
      const sent = play(g, () => 0.55, 1280, 3000);
      expect(Math.max(...sent)).to.be.at.most(0.55 + 1e-9);
      expect(sent[sent.length - 1]).to.equal(0.55);
    });

    it("turning back brakes first, never past where it was going, then eases to the new target", () => {
      const g = new Glide();
      g.value("f", 0, ease, 0);
      g.value("f", 1, ease, 0);
      const at = g.value("f", 1, ease, 1275); // 0.5, going up fast
      const sent = play(g, () => 0, 1280, 6000);
      const top = Math.max(...sent);
      expect(top).to.be.above(at); // it slows down on its way up first: no reversal at once
      expect(top).to.be.at.most(1);
      const peak = sent.indexOf(top);
      for (let i = peak + 1; i < sent.length; i++) expect(sent[i]!).to.be.at.most(sent[i - 1]! + 1e-12); // then only down
      expect(sent[sent.length - 1]).to.equal(0);
      // gliding all the way: the ghost bar never blinks off between braking and going down
      const g2 = new Glide();
      g2.value("f", 0, ease, 0);
      g2.value("f", 1, ease, 0);
      g2.value("f", 1, ease, 1275);
      for (let t = 1280; t < 1700; t += 10) {
        g2.value("f", 0, ease, t);
        expect(Object.keys(g2.moving(t))).to.deep.equal(["f"]);
      }
    });
  });
});
