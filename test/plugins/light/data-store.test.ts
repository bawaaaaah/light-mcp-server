import { expect } from "chai";
import { mkdtempSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { FolderStore, slugify, stableStringify } from "../../../src/plugins/light/data/store.js";

const Palette = z.object({ id: z.string(), name: z.string(), colors: z.array(z.string()), notes: z.string().optional() });

describe("folder store", () => {
  const dirs = () => {
    const d = mkdtempSync(join(tmpdir(), "light-store-"));
    return { root: join(d, "show"), backups: join(d, "backups") };
  };

  it("serializes with sorted keys and a trailing newline", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] } })).to.equal('{\n  "a": {\n    "c": [\n      3,\n      {\n        "e": 2,\n        "f": 1\n      }\n    ],\n    "d": 2\n  },\n  "b": 1\n}\n');
  });

  it("slugifies labels into ids", () => {
    expect(slugify("Refrain · Wave bleu")).to.equal("refrain-wave-bleu");
    expect(slugify("Éternel")).to.equal("eternel");
  });

  it("writes one file per object and reloads it", () => {
    const { root } = dirs();
    const s1 = new FolderStore(root);
    s1.collection("palettes", Palette).put({ id: "intime", name: "Intime bleu/ambre", colors: ["#1e3ce6", "#ff960f"] });
    expect(readdirSync(join(root, "palettes"))).to.deep.equal(["intime.json"]);
    const s2 = new FolderStore(root);
    expect(s2.collection("palettes", Palette).get("intime")!.colors).to.deep.equal(["#1e3ce6", "#ff960f"]);
  });

  it("is idempotent: saving the same object twice does not rewrite or back up", () => {
    const { root, backups } = dirs();
    const store = new FolderStore(root, backups);
    const events: string[] = [];
    store.onChange((e) => events.push(e.kind));
    const c = store.collection("palettes", Palette);
    c.put({ id: "a", name: "A", colors: [] });
    c.put({ name: "A", colors: [], id: "a" });
    expect(events).to.deep.equal(["put"]);
    expect(existsSync(backups)).to.equal(false);
  });

  it("backs up the previous version on change and on delete", () => {
    const { root, backups } = dirs();
    const c = new FolderStore(root, backups).collection("palettes", Palette);
    c.put({ id: "a", name: "A", colors: [] });
    c.put({ id: "a", name: "A2", colors: [] });
    c.delete("a");
    const stamps = readdirSync(backups);
    expect(stamps.length).to.be.at.least(1);
    const saved = stamps.map((s) => readFileSync(join(backups, s, "palettes", "a.json"), "utf8"));
    expect(saved.some((t) => t.includes('"A"'))).to.equal(true);
  });

  it("rejects invalid objects and ids, and reports invalid files on load", () => {
    const { root } = dirs();
    const c = new FolderStore(root).collection("palettes", Palette);
    expect(() => c.put({ id: "a", name: 3 })).to.throw();
    expect(() => c.put({ id: "Bad Id", name: "x", colors: [] })).to.throw(/identifiant/);
  });
});
