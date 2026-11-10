import { expect } from "chai";
import * as server from "../../../src/plugins/light/show/folders.js";
import * as web from "../../../web/src/folder.js";

// web/src/folder.ts mirrors show/folders.ts (the web app shares no code with the server): the two
// must read a look's folder the same way, or the list would group a look the commands cannot find.
describe("folder helpers: the web copy reads folders as the server does", () => {
  const cases: string[][] = [
    [],
    ["libre"],
    ["dossier:A"],
    ["dossier:", "dossier:A", "dossier:B"],
    ["dossier: A / B/ ", "libre"],
    ["dossier:A//B"],
    ["dossier: / "],
    ["dossier:Famille/Sous-dossier"],
  ];

  for (const tags of cases) {
    it(`agrees on ${JSON.stringify(tags)}`, () => {
      expect(web.folderOf(tags)).to.equal(server.folderOf(tags));
      for (const folder of [undefined, "A", "A/B"]) expect(web.withFolder(tags, folder)).to.deep.equal(server.withFolder(tags, folder));
      for (const node of ["A", "A/B", "Famille"]) expect(web.inTree(tags, node)).to.equal(server.inTree(tags, node));
    });
  }

  it("normalises a path the same way", () => {
    for (const p of ["A", " A ", "A / B/", "/A//B/", "  "]) expect(web.normalizeFolder(p)).to.equal(server.normalizeFolder(p));
    expect(web.SEPARATOR).to.equal(server.SEPARATOR);
    expect(web.FOLDER).to.equal(server.FOLDER);
  });
});
