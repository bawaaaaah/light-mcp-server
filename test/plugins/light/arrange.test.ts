import { expect } from "chai";
import { arrangeAlong, mountHeight } from "../../../src/plugins/light/venue/arrange.js";

describe("placing fixtures along a zone", () => {
  const stage: [number, number][] = [[-4, 0], [4, 0], [4, 5], [-4, 5]];

  it("spreads them evenly along the edge asked, from jardin to cour or from the front to the back", () => {
    expect(arrangeAlong(stage, "front", 4)).to.deep.equal([{ x: -3, y: 0.3 }, { x: -1, y: 0.3 }, { x: 1, y: 0.3 }, { x: 3, y: 0.3 }]);
    expect(arrangeAlong(stage, "back", 2)).to.deep.equal([{ x: -2, y: 4.7 }, { x: 2, y: 4.7 }]);
    expect(arrangeAlong(stage, "middle", 1)).to.deep.equal([{ x: 0, y: 2.5 }]);
    expect(arrangeAlong(stage, "houseLeft", 2)).to.deep.equal([{ x: -3.7, y: 1.3 }, { x: -3.7, y: 3.8 }]);
    expect(arrangeAlong(stage, "houseRight", 1, 0)).to.deep.equal([{ x: 4, y: 2.5 }]);
  });

  it("stays inside a zone narrower than the inset, and gives each mount its height", () => {
    expect(arrangeAlong([[0, 0], [2, 0], [2, 0.4], [0, 0.4]], "front", 1)).to.deep.equal([{ x: 1, y: 0.2 }]);
    expect([mountHeight("truss"), mountHeight("stand"), mountHeight("wall"), mountHeight(undefined)]).to.deep.equal([5, 1.8, 3, 0.3]);
  });
});
