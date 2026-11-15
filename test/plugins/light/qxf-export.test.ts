import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";
import { FolderStore } from "../../../src/plugins/light/data/store.js";
import { exportDefinition } from "../../../src/plugins/light/venue/definition-export.js";
import { headsOf } from "../../../src/plugins/light/venue/heads.js";
import { applyQxfCorrections, planCorrections, qxfFileName } from "../../../src/plugins/light/venue/qxf-export.js";
import { parseQxf, type FixtureDefinition } from "../../../src/plugins/light/venue/qxf-import.js";
import { Venue, type ResolvedFixture } from "../../../src/plugins/light/venue/venue.js";

const FIXTURES = ["wheel-spot.qxf", "wash-zones.qxf", "spot.qxf", "par-rgb.qxf"];
const fixtureText = (name: string) => readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), "utf8");

/** A definition as plain data, to compare two readings (Map → entries). */
const plain = (d: FixtureDefinition) => ({ ...d, channels: [...d.channels.entries()] });

function makeVenue(): { venue: Venue; defs: string } {
  const dir = mkdtempSync(join(tmpdir(), "light-qxf-export-"));
  const defs = join(dir, "fixtures");
  mkdirSync(defs);
  for (const f of FIXTURES) copyFileSync(new URL(`../../fixtures/${f}`, import.meta.url), join(defs, f));
  const venue = new Venue(new FolderStore(join(dir, "venue")), [defs]);
  venue.fixtures.put({ id: "spot", name: "Spot", manufacturer: "Test", model: "Wheel Spot", mode: "Standard", universe: 1, address: 1 });
  venue.fixtures.put({ id: "wash", name: "Wash", manufacturer: "Test", model: "Wash Zones", mode: "18 Channel", universe: 1, address: 20 });
  return { venue, defs };
}

describe("qxf export: a library definition back to a QLC+ file", () => {
  it("gives the library file byte for byte without corrections, under QLC+'s name", () => {
    const { venue, defs } = makeVenue();
    for (const [model, file] of [
      ["Wheel Spot", "wheel-spot.qxf"],
      ["Wash Zones", "wash-zones.qxf"],
      ["Spot 7", "spot.qxf"],
    ] as const) {
      const out = exportDefinition(venue, { manufacturer: "Test", model });
      expect(Buffer.from(out.xml, "utf8").equals(readFileSync(join(defs, file)))).to.equal(true);
      expect(out.corrected).to.equal(false);
      expect(out.source).to.equal(file);
      expect(out.base64).to.equal(undefined);
      expect(plain(parseQxf(out.xml))).to.deep.equal(plain(parseQxf(fixtureText(file))));
    }
    expect(exportDefinition(venue, { manufacturer: "Test", model: "Wheel Spot" }).file).to.equal("Test-Wheel-Spot.qxf");
    // by a patched fixture: its model's file
    expect(exportDefinition(venue, { fixture: "spot" }).xml).to.equal(fixtureText("wheel-spot.qxf"));
  });

  it("keeps a byte-order mark, CRLF line ends and bytes that are not UTF-8", () => {
    const { venue, defs } = makeVenue();
    const crlf = Buffer.from(`\uFEFF${fixtureText("par-rgb.qxf").replace(/\n/g, "\r\n")}`, "utf8");
    writeFileSync(join(defs, "par-rgb.qxf"), crlf);
    const def = parseQxf(fixtureText("par-rgb.qxf"));
    const out = exportDefinition(venue, { manufacturer: def.manufacturer, model: def.model });
    expect(Buffer.from(out.xml, "utf8").equals(crlf)).to.equal(true);
    // Latin-1 « é » in a comment: the bytes come back in base64
    const latin = Buffer.concat([Buffer.from(fixtureText("par-rgb.qxf").replace("</FixtureDefinition>", "<!-- "), "utf8"), Buffer.from([0xe9]), Buffer.from(" --></FixtureDefinition>\n")]);
    writeFileSync(join(defs, "par-rgb.qxf"), latin);
    const raw = exportDefinition(venue, { manufacturer: def.manufacturer, model: def.model });
    expect(Buffer.from(raw.base64!, "base64").equals(latin)).to.equal(true);
  });

  it("names the file as QLC+ does, plain", () => {
    expect(qxfFileName("Acme", "Spot 900")).to.equal("Acme-Spot-900.qxf");
    expect(qxfFileName("Éclairage", "Wash (v2)")).to.equal("Eclairage-Wash-v2.qxf");
    expect(qxfFileName("A/B", "C  D")).to.equal("A-B-C-D.qxf");
  });

  it("refuses the built-in generic dimmer and an unknown model or fixture", () => {
    const { venue } = makeVenue();
    expect(() => exportDefinition(venue, { manufacturer: "Generic", model: "Generic" })).to.throw(/intégré|built into/);
    expect(() => exportDefinition(venue, { manufacturer: "Test", model: "Nope" })).to.throw(/aucune définition|no definition/);
    expect(() => exportDefinition(venue, { fixture: "nope" })).to.throw(/inconnue|unknown/);
    expect(() => exportDefinition(venue, {})).to.throw();
  });

  it("writes the wheel slots' real colours, and says what QLC+ cannot hold", () => {
    const { venue } = makeVenue();
    venue.putOverridePart("spot", "model", "wheel", { slots: { "20": { color: "#FF6600" }, "110": { color: "#123456" }, "30": { answers: ["#ff0000"] }, "40": { off: true }, "7": { color: "#000000" } }, change: "black" });
    const out = exportDefinition(venue, { manufacturer: "Test", model: "Wheel Spot", corrections: true });
    expect(out.corrected).to.equal(true);
    // only the slot's colour changed, in place; the rest of the file is the library's
    expect(out.xml).to.equal(fixtureText("wheel-spot.qxf").replace('Res1="#ff8000">Orange', 'Res1="#ff6600">Orange'));
    const again = parseQxf(out.xml).channels.get("Color Wheel")!.capabilities;
    expect(again.find((c) => c.min === 20)!.color).to.equal("#ff6600");
    expect(out.applied.map((n) => n.part)).to.deep.equal(["wheel"]);
    // a rainbow (ColorWheelIndex) has no colour in QLC+; answers, off, an unknown slot and the change are this server's
    const said = out.notExported.map((n) => n.message).join("\n");
    expect(said).to.match(/ColorWheelIndex/);
    expect(said).to.match(/répond|answers/);
    expect(said).to.match(/jamais choisie|never chosen/);
    expect(said).to.match(/ 7/);
    expect(said).to.match(/noir|black/);
  });

  it("adds Res1 and the ColorMacro preset to a slot without a colour, and replaces an old Color attribute", () => {
    const xml = fixtureText("spot.qxf");
    const out = applyQxfCorrections(xml, { wheel: [{ channel: "Color Wheel", slots: { 80: "#aa00ff", 64: "#ffaa00", 16: "#ee0000" } }] });
    expect(out).to.include('<Capability Min="80" Max="255" Preset="ColorMacro" Res1="#aa00ff">Rainbow</Capability>');
    expect(out).to.include('<Capability Min="64" Max="79" Color="#ffaa00">Amber</Capability>');
    expect(out).to.include('Res1="#ee0000">Red</Capability>');
    const caps = parseQxf(out).channels.get("Color Wheel")!.capabilities;
    expect(caps.map((c) => c.color)).to.deep.equal(["#ffffff", "#ee0000", "#00ff00", "#0000ff", "#ffaa00", "#aa00ff"]);
    // nothing asked: the very same text
    expect(applyQxfCorrections(xml, {})).to.equal(xml);
  });

  it("declares the heads deduced from the channel names, read back the same (halo included)", () => {
    const { venue } = makeVenue();
    const before = venue.resolve("wash") as ResolvedFixture;
    const out = exportDefinition(venue, { fixture: "wash", corrections: true });
    expect(out.corrected).to.equal(true);
    expect(out.applied.map((n) => n.part)).to.deep.equal(["heads"]);
    expect(out.notExported).to.deep.equal([]); // the halo is named so: still an accent once declared
    const again = parseQxf(out.xml);
    const mode = again.modes[0]!;
    expect(mode.heads).to.deep.equal([
      [2, 3, 4, 5],
      [6, 7, 8, 9],
      [10, 11, 12, 13],
      [14, 15, 16],
    ]);
    const h = headsOf(again, mode);
    expect(h.deduced).to.equal(false);
    expect([...h.heads.entries()]).to.deep.equal([...before.heads.entries()]);
    expect([...h.accent]).to.deep.equal([...before.accent]);
    // only <Head> elements were added, at the end of the mode, indented as QLC+ does
    expect(out.xml).to.include('<Channel Number="17">Halo Effect</Channel>\n  <Head>\n   <Channel>2</Channel>');
    expect(out.xml.replace(/\n  <Head>[\s\S]*?<\/Head>/g, "")).to.equal(fixtureText("wash-zones.qxf"));
  });

  it("says a halo designated by hand, one kept dark, the tracks and the fixture's inversions do not pass", () => {
    const { venue } = makeVenue();
    venue.putOverridePart("wash", "model", "heads", { accent: ["Red 3", "Green 3", "Blue 3", "White 3"], follow: false });
    venue.putOverridePart("wash", "fixture", "tracks", { enabled: true, fade: ["Dimmer"] });
    venue.fixtures.put({ ...venue.fixtures.get("wash")!, orientation: { yaw: 0, invertPan: true, invertTilt: false, swapPanTilt: false, panOffset: 0, tiltOffset: 0 } });
    const out = exportDefinition(venue, { fixture: "wash", corrections: true });
    const parts = out.notExported.map((n) => n.part).sort();
    expect(parts).to.deep.equal(["heads", "heads", "orientation", "tracks"]);
    expect(out.notExported.find((n) => n.message.includes("Red 3"))).to.not.equal(undefined);
    // the model alone: no fixture's tracks nor inversions
    const model = exportDefinition(venue, { manufacturer: "Test", model: "Wash Zones", corrections: true });
    expect(model.notExported.map((n) => n.part).sort()).to.deep.equal(["heads", "heads"]);
  });

  it("writes the real pan/tilt travel on every <Focus>, or adds one", () => {
    const xml = fixtureText("wheel-spot.qxf");
    const out = applyQxfCorrections(xml, { travel: { panMax: 630, tiltMax: 265 } });
    expect(out).to.equal(xml.replace('PanMax="540" TiltMax="270"', 'PanMax="630" TiltMax="265"'));
    const wash = fixtureText("wash-zones.qxf");
    const added = parseQxf(applyQxfCorrections(wash, { travel: { panMax: 360 } }));
    expect(added.panMax).to.equal(360);
    expect(plain({ ...added, panMax: undefined })).to.deep.equal(plain({ ...parseQxf(wash), panMax: undefined }));
    // a mode's own <Physical> is corrected too
    const spot = parseQxf(applyQxfCorrections(fixtureText("spot.qxf"), { travel: { tiltMax: 200 } }));
    expect(spot.modes.every((m) => m.tiltMax === undefined || m.tiltMax === 200)).to.equal(true);
    expect(spot.tiltMax).to.equal(200);
  });

  it("round-trips every test definition through the corrections without losing anything else", () => {
    for (const f of FIXTURES) {
      const xml = fixtureText(f);
      const def = parseQxf(xml);
      const { corrections } = planCorrections(def, {});
      const again = parseQxf(applyQxfCorrections(xml, corrections));
      expect(plain({ ...again, modes: again.modes.map((m) => ({ ...m, heads: [] })) })).to.deep.equal(plain({ ...def, modes: def.modes.map((m) => ({ ...m, heads: [] })) }), f);
    }
  });

  it("is a command: MCP, HTTP and the CLI call fixture.definition.export", async () => {
    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-qxf-cmd-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    copyFileSync(new URL("../../fixtures/wheel-spot.qxf", import.meta.url), join(dataRoot, "fixtures", "wheel-spot.qxf"));
    const cfg: Record<string, unknown> = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    const plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
    const out = (await plugin.commands.invoke("fixture.definition.export", { manufacturer: "Test", model: "Wheel Spot" }, systemContext())) as { file: string; xml: string };
    expect(out.file).to.equal("Test-Wheel-Spot.qxf");
    expect(out.xml).to.equal(fixtureText("wheel-spot.qxf"));
    expect(plugin.commands.list().find((c) => c.name === "fixture.definition.export")?.readOnly).to.equal(true);
  });
});
