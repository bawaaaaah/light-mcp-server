import { expect } from "chai";
import { footprintOf, normaliseName } from "../web/src/definition-names.js";
import { normaliseName as serverNormaliseName } from "../src/plugins/light/venue/qxf-import.js";

describe("web definition names: compared as the server does", () => {
  it("normalises like the server", () => {
    for (const s of ["Pro Spot", "PRO-SPOT", "Straße", "Bjørn", "Cæsar", "Éclairage", "★"]) expect(normaliseName(s), s).to.equal(serverNormaliseName(s));
  });

  it("finds a fixture's footprint despite case, punctuation and the mode's spelling", () => {
    const library = [{ manufacturer: "Acme", model: "Pro Spot", modes: [{ name: "16 Channel", channels: 16 }, { name: "Basic", channels: 4 }] }];
    expect(footprintOf(library, { manufacturer: "ACME", model: "pro-spot", mode: "16 Channel" })).to.equal(16);
    expect(footprintOf(library, { manufacturer: "Acme", model: "Pro Spot", mode: "16ch" })).to.equal(16);
    expect(footprintOf(library, { manufacturer: "Acme", model: "Other", mode: "Basic" })).to.equal(undefined);
  });
});
