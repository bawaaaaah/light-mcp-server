import { expect } from "chai";
import { arrowStep, defaultSpan, logicalToPad, offsetDeg, padToLogical, quantize, type PadSpan } from "../web/src/correctionPad.js";

/** A 16-bit head on 540° / 270°, aimed off-centre. */
const fine: PadSpan = { center: { pan: 0.6, tilt: 0.3 }, half: 10, travel: { pan: 540, tilt: 270 }, step: { pan: 540 / 65535, tilt: 270 / 65535 }, fine: { pan: true, tilt: true } };
/** The same without fine channels: one step is 2.1° of pan, 1.06° of tilt. */
const coarse: PadSpan = { ...fine, half: 45, step: { pan: 540 / 255, tilt: 270 / 255 }, fine: { pan: false, tilt: false } };

describe("correction pad (T8): ± a few degrees around the computed aim, on the output's grid", () => {
  it("opens on ± 10°, widened to ± 45° when a step of an 8-bit axis is more than a tenth of it", () => {
    expect(defaultSpan(fine.step)).to.equal(10);
    expect(defaultSpan(coarse.step)).to.equal(45);
    expect(defaultSpan({ pan: 360 / 255, tilt: 180 / 255 })).to.equal(45); // 1.4° a step: under ten steps in 10°
    expect(defaultSpan({ pan: 180 / 255, tilt: 90 / 255 })).to.equal(10);
  });

  it("puts the computed aim at the centre and the edges at ± half the span, both ways", () => {
    expect(padToLogical(fine, 0.5, 0.5).pan).to.be.closeTo(0.6, 1 / 65535);
    const edge = padToLogical(fine, 1, 0);
    expect(offsetDeg(fine, edge).pan).to.be.closeTo(10, 0.01);
    expect(offsetDeg(fine, edge).tilt).to.be.closeTo(-10, 0.01);
    const p = padToLogical(fine, 0.73, 0.21);
    const back = logicalToPad(fine, p);
    expect(back.pan).to.be.closeTo(0.73, 1e-3);
    expect(back.tilt).to.be.closeTo(0.21, 1e-3);
    expect(logicalToPad(fine, { pan: 0.9, tilt: 0.3 }).pan).to.be.above(1); // beyond the pad's edge: the caller keeps it there
  });

  it("moves by whole 8-bit steps without a fine channel, by 16-bit ones with it", () => {
    const p = padToLogical(coarse, 0.513, 0.5);
    expect((p.pan * 255) % 1).to.be.closeTo(0, 1e-9);
    expect(quantize(0.50001, true) * 65535).to.be.closeTo(Math.round(0.50001 * 65535), 1e-9);
    expect(quantize(1.2, false)).to.equal(1);
  });

  it("steps an arrow by a hundredth of the pad (Shift a tenth), never under one real step; Alt one real step", () => {
    expect(arrowStep(fine, "pan") * 540).to.be.closeTo(0.2, 1e-9); // 20° wide: 0.2° a press
    expect(arrowStep(fine, "pan", { shift: true }) * 540).to.be.closeTo(2, 1e-9);
    expect(arrowStep(fine, "tilt", { finest: true })).to.be.closeTo(1 / 65535, 1e-12);
    expect(arrowStep(coarse, "pan")).to.be.closeTo(1 / 255, 1e-12); // 0.9° asked, 2.1° a step: one step
    expect((arrowStep(coarse, "pan", { shift: true }) * 255) % 1).to.be.closeTo(0, 1e-9); // whole steps
  });
});
