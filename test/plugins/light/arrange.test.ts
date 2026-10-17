import { expect } from "chai";
import { arrangeAlong, mountHeight } from "../../../src/plugins/light/venue/arrange.js";
import { beamCrosses, landing, ZoneSchema } from "../../../src/plugins/light/venue/stage.js";

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

  it("finds where a beam lands, and whether it crosses a zone up to head height", () => {
    const riser = ZoneSchema.parse({ id: "r", name: "R", polygon: [[0, 0], [2, 0], [2, 2], [0, 2]], floorHeight: 0.5 });
    const down = { x: 0, y: 0, z: -1 };
    expect(landing({ x: 1, y: 1, z: 5 }, down, [riser])).to.deep.equal({ x: 1, y: 1, z: 0.5, floor: true }); // on the riser's floor
    expect(landing({ x: 1, y: 1, z: 5 }, { x: 1, y: 0, z: 0 }, [riser])).to.include({ x: 3, floor: false }); // level: 2 m out
    const face = { x: 0, y: Math.SQRT1_2, z: -Math.SQRT1_2 };
    expect(beamCrosses({ x: 1, y: -2, z: 4 }, face, riser)).to.equal(true); // through it at head height
    expect(beamCrosses({ x: 5, y: 5, z: 4 }, down, riser)).to.equal(false); // straight down beside it
    expect(beamCrosses({ x: 1, y: -6, z: 0.5 }, { x: 0, y: -1, z: 0 }, riser)).to.equal(false); // away from it
  });
});
