import { expect } from "chai";
import { mergeOverrides, modelKey } from "../../../src/plugins/light/venue/overrides.js";
import { sameName } from "../../../src/plugins/light/venue/qxf-import.js";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderStore } from "../../../src/plugins/light/data/store.js";
import { Venue } from "../../../src/plugins/light/venue/venue.js";

describe("fixture overrides: a model's corrections, overridden by a fixture's own", () => {
  it("keys a model without case or punctuation", () => {
    expect(modelKey("Mac Mah", "Spot 200")).to.equal(modelKey("mac-mah", "SPOT_200"));
  });

  it("keys a model as its definition is found: « Spot 200 » is « Spot200 », as sameName says", () => {
    expect(modelKey("Acme", "Spot 200")).to.equal(modelKey("Acme", "Spot200"));
    expect(sameName("Spot 200", "Spot200")).to.equal(true);
  });

  it("keeps manufacturer and model apart: (« A », « B C ») and (« A B », « C ») are two models", () => {
    expect(modelKey("A", "B C")).to.not.equal(modelKey("A B", "C"));
  });

  it("folds accents, for the key and for finding a definition alike", () => {
    expect(modelKey("Éclairage Lumière", "Pâr LED")).to.equal(modelKey("eclairage lumiere", "PAR LED"));
    expect(sameName("Lumière", "Lumiere")).to.equal(true);
  });

  it("refuses a name without a letter or digit, which would key every such model alike", () => {
    expect(() => modelKey("Acme", "★")).to.throw();
    expect(() => modelKey("", "Spot")).to.throw();
  });

  it("replaces each part as a whole by the fixture's own, and keeps the model's other parts", () => {
    const merged = mergeOverrides({ wheel: { doubles: false }, heads: { accent: [] } }, { wheel: { change: "black" } });
    expect(merged).to.deep.equal({ wheel: { change: "black" }, heads: { accent: [] } });
    expect(mergeOverrides(undefined, undefined)).to.deep.equal({});
  });
});

describe("model keys of a venue opened", () => {
  const write = (root: string, id: string, manufacturer: string, model: string, overrides: unknown) => {
    mkdirSync(join(root, "models"), { recursive: true });
    writeFileSync(join(root, "models", `${id}.json`), JSON.stringify({ id, manufacturer, model, overrides }));
  };
  const open = (root: string) => new Venue(new FolderStore(root), []);

  it("folds ß, ø and æ like the other letters", () => {
    expect(sameName("Straße", "Strasse")).to.equal(true);
    expect(sameName("Bjørn", "Bjorn")).to.equal(true);
    expect(modelKey("Cæsar", "X")).to.equal(modelKey("Caesar", "X"));
  });

  it("re-keys a model stored under the old key format, on disk too", () => {
    const root = mkdtempSync(join(tmpdir(), "light-models-"));
    write(root, "acmespot200", "Acme", "Spot 200", { wheel: { doubles: false } }); // the old key: both names joined
    const venue = open(root);
    const key = modelKey("Acme", "Spot 200");
    expect(venue.models.list().map((m) => m.id)).to.deep.equal([key]);
    expect(venue.models.get(key)?.overrides.wheel).to.deep.equal({ doubles: false });
    expect(readdirSync(join(root, "models"))).to.deep.equal([`${key}.json`]);
  });

  it("keeps the record already under the right key when both exist, and the fixture-less one is dropped", () => {
    const root = mkdtempSync(join(tmpdir(), "light-models-"));
    const key = modelKey("Acme", "Spot 200");
    write(root, key, "Acme", "Spot 200", { heads: { follow: false } });
    write(root, "acmespot200", "Acme", "Spot 200", { wheel: { doubles: false } });
    write(root, "star", "★", "★", {}); // no key exists for it: left alone
    const venue = open(root);
    expect(venue.models.list().map((m) => m.id).sort()).to.deep.equal([key, "star"].sort());
    expect(venue.models.get(key)?.overrides).to.deep.equal({ heads: { follow: false } });
  });
});
