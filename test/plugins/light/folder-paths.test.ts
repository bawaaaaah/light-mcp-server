import { expect } from "chai";
import { folderLabel, folderOf, foldersOf, inTree, nestOf, normalizeFolder, renamedPath, withFolder, withoutFolderTag, withParents } from "../../../src/plugins/light/show/folders.js";

// show/folders.ts is the one reading of a look's folder, for the commands and for the web app (the show list, the look
// editor and menu), which imports it as it is (T43).
describe("look folders (show/folders.ts)", () => {
  it("reads a look's folder from its first named dossier: tag, normalised", () => {
    const cases: [string[], string | undefined][] = [
      [[], undefined],
      [["libre"], undefined],
      [["dossier:A"], "A"],
      [["dossier:", "dossier:A", "dossier:B"], "A"],
      [["dossier: A / B/ ", "libre"], "A/B"],
      [["dossier:A//B"], "A/B"],
      [["dossier: / "], undefined],
      [["dossier:Famille/Sous-dossier"], "Famille/Sous-dossier"],
    ];
    for (const [tags, folder] of cases) expect(folderOf(tags), JSON.stringify(tags)).to.equal(folder);
  });

  it("normalises a path: segments trimmed, inner spaces made one, empty segments dropped", () => {
    const cases: [string, string][] = [["A", "A"], [" A ", "A"], ["A / B/", "A/B"], ["/A//B/", "A/B"], ["  ", ""], ["Mon  dossier", "Mon dossier"], ["A /  Grand   B", "A/Grand B"]];
    for (const [path, normal] of cases) expect(normalizeFolder(path)).to.equal(normal);
  });

  it("finds a look in a folder or under it", () => {
    expect(inTree(["dossier:A/B"], "A")).to.equal(true);
    expect(inTree(["dossier:A/B"], "A/B")).to.equal(true);
    expect(inTree(["dossier:AB"], "A")).to.equal(false);
    expect(inTree(["dossier:A"], "A/B")).to.equal(false);
    expect(inTree(["libre"], "")).to.equal(false);
  });

  it("writes exactly one folder tag, or none", () => {
    expect(withFolder(["x", "dossier:", "dossier:A"], "B")).to.deep.equal(["x", "dossier:B"]);
    expect(withFolder(["x", "dossier:A"])).to.deep.equal(["x"]);
    expect(withoutFolderTag(["dossier:A", "x"])).to.deep.equal(["x"]);
  });

  it("lists the folders in use with their parents, and shows a path as people read it", () => {
    expect(withParents(["B/C", "A"])).to.deep.equal(["A", "B", "B/C"]);
    expect(foldersOf([{ tags: ["dossier:A/B"] }, { tags: [] }, { tags: ["dossier:A"] }])).to.deep.equal(["A", "A/B"]);
    expect(folderLabel("Rigging/Trappe")).to.equal("Rigging ▸ Trappe");
  });

  it("nests and renames a folder with its subtree, never under its own branch", () => {
    expect(nestOf("A/B", "C")).to.equal("C/B");
    expect(nestOf("A/B")).to.equal("B");
    expect(nestOf("A", "A/B")).to.equal(undefined);
    expect(nestOf("A", "A")).to.equal(undefined);
    expect(renamedPath("A/B", "A", "Z")).to.equal("Z/B");
    expect(renamedPath("AB", "A", "Z")).to.equal("AB");
  });
});
