import { expect } from "chai";
import { copyFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderStore } from "../../../src/plugins/light/data/store.js";
import { Venue } from "../../../src/plugins/light/venue/venue.js";
import { ShowRuntime } from "../../../src/plugins/light/show/runtime.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "light-show-"));
  const defs = join(dir, "fixtures");
  mkdirSync(defs);
  copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(defs, "bar4.qxf"));
  const venue = new Venue(new FolderStore(join(dir, "venue")), [defs]);
  venue.fixtures.put({ id: "bar-l", name: "Barre public", manufacturer: "Test", model: "Bar 4", mode: "15 Channel", universe: 1, address: 1, role: "wash-public" });
  venue.fixtures.put({ id: "bar-r", name: "Barre fond", manufacturer: "Test", model: "Bar 4", mode: "15 Channel", universe: 1, address: 16, role: "contre" });
  venue.canvases.put({
    id: "mur",
    name: "Mur",
    topology: "line",
    cells: 8,
    render: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ from: i, to: i, targets: [{ fixture: i < 4 ? "bar-l" : "bar-r", head: i % 4 }] })),
  });
  let beats = 0;
  let now = 0;
  const show = new ShowRuntime(new FolderStore(join(dir, "show")), venue, { state: () => ({ beats }) }, () => now);
  const advance = (b: number) => {
    beats += b;
    now += b * 500;
  };
  const dmx = () => {
    const buffers = [new Uint8Array(512)];
    show.render(buffers);
    return buffers[0]!;
  };
  return { venue, show, dmx, advance };
}

describe("show runtime", () => {
  it("plays a look on the canvas and follows the beat", () => {
    const { show, dmx, advance } = setup();
    show.looks.put({ id: "dam", name: "Damier", canvas: "mur", technique: { kind: "damier", colors: ["#ff0000", "#0000ff"], block: 1 } });
    show.go("dam");
    let b = dmx();
    expect([b[3], b[5], b[6], b[8]]).to.deep.equal([255, 0, 0, 255]); // cell0 red, cell1 blue
    advance(1);
    b = dmx();
    expect([b[3], b[5]]).to.deep.equal([0, 255]); // swapped on the next beat
  });

  it("uses palettes by reference", () => {
    const { show, dmx } = setup();
    show.palettes.put({ id: "chaud", name: "Chaud", colors: ["#ff8000", "#ffff00"] });
    show.looks.put({ id: "p", name: "Plat", canvas: "mur", palette: "chaud", technique: { kind: "plat", color: "#000000" } });
    show.go("p");
    expect([dmx()[3], dmx()[4]]).to.deep.equal([255, 128]);
    show.palettes.put({ id: "chaud", name: "Chaud", colors: ["#00ff00"] });
    expect([dmx()[3], dmx()[4]]).to.deep.equal([0, 255]);
  });

  it("releases the other looks of an exclusive group (idempotent go)", () => {
    const { show } = setup();
    show.looks.put({ id: "a", name: "A", canvas: "mur", technique: { kind: "plat", color: "#ff0000" } });
    show.looks.put({ id: "b", name: "B", canvas: "mur", technique: { kind: "plat", color: "#0000ff" } });
    show.groups.put({ id: "sections", name: "Sections", exclusive: true, members: { looks: ["a", "b"] } });
    show.go("a");
    expect(show.go("b").released).to.deep.equal(["a"]);
    expect(show.go("b")).to.deep.equal({ started: false, released: [] });
    expect(show.activeLooks()).to.deep.equal(["b"]);
  });

  it("multiplies masters like DCAs: Ambiance 50 % over LED bar public 80 % → 40 %", () => {
    const { show, dmx } = setup();
    show.groups.put({ id: "bar-public", name: "LED bar public", members: { fixtures: ["bar-l"] }, master: { level: 0.8 } });
    show.groups.put({ id: "bar-fond", name: "LED bar fond", members: { fixtures: ["bar-r"] }, master: { level: 1 } });
    show.groups.put({ id: "ambiance", name: "Ambiance", members: { groups: ["bar-public", "bar-fond"] }, master: { level: 0.5 } });
    const b = dmx();
    expect(b[0]).to.equal(Math.round(0.4 * 255)); // bar-l dimmer
    expect(b[15]).to.equal(Math.round(0.5 * 255)); // bar-r dimmer
  });

  it("applies mute, flash and limits", () => {
    const { show, dmx } = setup();
    show.groups.put({ id: "g", name: "G", members: { fixtures: ["bar-l"] }, master: { level: 1, mute: true } });
    expect(dmx()[0]).to.equal(0);
    show.setFlash("g", true);
    expect(dmx()[0]).to.equal(255);
    show.setFlash("g", false);
    show.groups.put({ id: "g", name: "G", members: { fixtures: ["bar-l"] }, master: { level: 1 }, limits: { max: 0.7 } });
    expect(dmx()[0]).to.equal(Math.round(0.7 * 255));
  });

  it("selects members dynamically by role", () => {
    const { show, dmx } = setup();
    show.groups.put({ id: "public", name: "Public", selector: { role: "wash-public" }, master: { level: 0.5 } });
    expect(dmx()[0]).to.equal(128);
    expect(dmx()[15]).to.equal(255);
  });

  it("doses included presets with the master and keeps excluded fixtures out", () => {
    const { show, dmx } = setup();
    show.looks.put({ id: "fx", name: "FX", canvas: "mur", technique: { kind: "plat", color: "#ff0000" } });
    show.groups.put({ id: "dose", name: "Dose FX", master: { level: 0.5 }, presets: { included: ["fx"] } });
    show.groups.put({ id: "face", name: "Face", members: { fixtures: ["bar-r"] }, presets: { excluded: ["fx"] } });
    show.go("fx");
    const b = dmx();
    expect(b[3]).to.equal(128); // bar-l red at 50 %
    expect(b[15 + 3]).to.equal(0); // bar-r untouched by fx
  });
});
