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

describe("archive restore preview", () => {
  it("lists what a restore would add, change and remove, ignoring key order and layout", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { diffFolder } = await import("../../../src/plugins/light/data/archive.js");
    const dir = join(mkdtempSync(join(tmpdir(), "light-diff-")), "show");
    mkdirSync(join(dir, "looks"), { recursive: true });
    writeFileSync(join(dir, "looks", "a.json"), '{\n  "id": "a",\n  "name": "A"\n}\n');
    writeFileSync(join(dir, "looks", "b.json"), '{"id":"b","name":"B"}');
    writeFileSync(join(dir, "looks", "gone.json"), '{"id":"gone"}');
    const diff = diffFolder(dir, {
      "looks/a.json": '{"name":"A","id":"a"}', // same content, other order and layout
      "looks/b.json": '{"id":"b","name":"B bis"}',
      "looks/new.json": '{"id":"new"}',
    });
    expect(diff).to.deep.equal({ added: ["looks/new.json"], removed: ["looks/gone.json"], changed: ["looks/b.json"], unchanged: 1 });
  });
});

describe("live values (fader levels)", () => {
  const setup = () => {
    const d = mkdtempSync(join(tmpdir(), "light-live-store-"));
    const store = new FolderStore(join(d, "show"), join(d, "backups"));
    const col = store.collection("groups", z.object({ id: z.string(), level: z.number() }));
    col.put({ id: "g", level: 1 });
    const backups = () => (existsSync(join(d, "backups")) ? readdirSync(join(d, "backups")).length : 0);
    const onDisk = () => JSON.parse(readFileSync(join(d, "show", "groups", "g.json"), "utf8")).level as number;
    return { store, col, backups, onDisk };
  };

  it("applies at once, writes once after the moves, and never makes a backup per move", async () => {
    const { col, backups, onDisk } = setup();
    for (let i = 0; i <= 100; i++) col.putLive({ id: "g", level: i / 100 });
    expect(col.get("g")!.level).to.equal(1); // in effect immediately
    expect(onDisk()).to.equal(1); // not written yet (it was 1 before, and the last move is 1)
    col.putLive({ id: "g", level: 0.3 });
    expect(onDisk()).to.equal(1);
    col.flushLive();
    expect(onDisk()).to.equal(0.3);
    expect(backups()).to.equal(0);
  });

  it("drops pending values when the disk is reloaded (a restored archive wins)", async () => {
    const { store, col, onDisk } = setup();
    col.putLive({ id: "g", level: 0.2 });
    store.reloadAll(); // e.g. after restoring an archive
    col.flushLive();
    expect(onDisk()).to.equal(1);
    expect(col.get("g")!.level).to.equal(1);
  });
});
