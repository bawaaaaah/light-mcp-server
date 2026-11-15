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
import { applyQxfCorrections, planCorrections, qxfFileName, writeQxfCorrections } from "../../../src/plugins/light/venue/qxf-export.js";
import { capabilityTags, parseQxf, type FixtureDefinition } from "../../../src/plugins/light/venue/qxf-import.js";
import { Venue, type ResolvedFixture } from "../../../src/plugins/light/venue/venue.js";

const FIXTURES = ["wheel-spot.qxf", "wash-zones.qxf", "spot.qxf", "par-rgb.qxf", "mode-par.qxf", "bar4.qxf"];
const fixtureText = (name: string) => readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), "utf8");

/** A definition as plain data, to compare two readings (Map → entries). */
const plain = (d: FixtureDefinition) => ({ ...d, channels: [...d.channels.entries()] });

function makeVenue(files: Record<string, string | Buffer> = {}): { venue: Venue; defs: string } {
  const dir = mkdtempSync(join(tmpdir(), "light-qxf-export-"));
  const defs = join(dir, "fixtures");
  mkdirSync(defs);
  for (const f of FIXTURES) copyFileSync(new URL(`../../fixtures/${f}`, import.meta.url), join(defs, f));
  for (const [f, content] of Object.entries(files)) writeFileSync(join(defs, f), content);
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
    expect(qxfFileName("Straße", "Spot")).to.equal("Strasse-Spot.qxf");
    // another script: a fingerprint of the full names, so that two such models never share a file
    const jp = qxfFileName("Acme", "日本語");
    expect(jp).to.match(/^Acme-[0-9a-f]{8}\.qxf$/);
    expect(qxfFileName("Acme", "中文")).to.not.equal(jp);
    expect(qxfFileName("Акме", "Спот")).to.match(/^[0-9a-f]{8}\.qxf$/);
    // names Windows reserves for devices
    expect(qxfFileName("CON", "")).to.equal("CON_.qxf");
    expect(qxfFileName("", "lpt1")).to.equal("lpt1_.qxf");
    expect(qxfFileName("Con", "Spot")).to.equal("Con-Spot.qxf");
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
    const withoutHeads = (d: FixtureDefinition) => plain({ ...d, modes: d.modes.map((m) => ({ ...m, heads: [] })) });
    for (const f of FIXTURES) {
      const xml = fixtureText(f);
      const def = parseQxf(xml);
      // a real retouch of every wheel slot that has a colour preset or none, when the definition has a wheel
      const wheel = [...def.channels.values()].find((c) => c.attribute === "colorWheel");
      const slots = Object.fromEntries((wheel?.capabilities ?? []).filter((c) => !c.preset || /^Color(Double)?Macro$/.test(c.preset)).map((c) => [String(c.min), { color: "#123456" }]));
      const { corrections, applied } = planCorrections(def, wheel ? { wheel: { slots } } : {});
      const again = parseQxf(applyQxfCorrections(xml, corrections));
      // the retouched slots carry the new colour, and nothing else moved
      const retouched = new Set(Object.keys(slots).map(Number));
      const recolour = (d: FixtureDefinition) => ({ ...d, channels: new Map([...d.channels].map(([n, c]) => [n, n === wheel?.name ? { ...c, capabilities: c.capabilities.map((x) => (retouched.has(x.min) ? { ...x, color: "#123456", preset: x.preset ?? (x.color ? undefined : "ColorMacro"), tags: [] } : x)) } : c])) });
      expect(withoutHeads(again)).to.deep.equal(withoutHeads(recolour(def)), f);
      if (wheel) expect(applied.filter((n) => n.part === "wheel")).to.have.length.above(0, f);
      // the heads: those the file declared, kept; those deduced, declared as planned
      for (const [i, mode] of def.modes.entries()) {
        const planned = corrections.heads?.find((h) => h.mode === mode.name);
        expect(again.modes[i]!.heads).to.deep.equal(planned ? planned.heads : mode.heads, `${f} ${mode.name}`);
      }
    }
  });

  it("keeps a byte-order mark and CRLF line ends when it writes corrections", () => {
    const crlf = `\uFEFF${fixtureText("wheel-spot.qxf").replace(/\n/g, "\r\n")}`;
    const { venue } = makeVenue({ "wheel-spot.qxf": Buffer.from(crlf, "utf8") });
    venue.putOverridePart("spot", "model", "wheel", { slots: { "20": { color: "#FF6600" } } });
    const out = exportDefinition(venue, { fixture: "spot", corrections: true });
    expect(out.xml).to.equal(crlf.replace('Res1="#ff8000">Orange', 'Res1="#ff6600">Orange'));
    expect(out.base64).to.equal(undefined);
    // and the deduced heads, inserted with the file's own line ends
    const wash = `\uFEFF${fixtureText("wash-zones.qxf").replace(/\n/g, "\r\n")}`;
    const heads = exportDefinition(makeVenue({ "wash-zones.qxf": Buffer.from(wash, "utf8") }).venue, { fixture: "wash", corrections: true });
    expect(heads.xml.startsWith("\uFEFF")).to.equal(true);
    expect(heads.xml.replace(/\r\n/g, "")).to.not.include("\n");
    expect(parseQxf(heads.xml).modes[0]!.heads).to.have.length(4);
  });

  it("writes corrections into an ISO-8859-1 file byte for byte, the retouch apart", () => {
    const text = fixtureText("wheel-spot.qxf").replace('encoding="UTF-8"', 'encoding="ISO-8859-1"').replace("light-mcp-server tests", "Café");
    const latin = Buffer.from(text, "latin1");
    const { venue } = makeVenue({ "wheel-spot.qxf": latin });
    venue.putOverridePart("spot", "model", "wheel", { slots: { "20": { color: "#FF6600" } } });
    const out = exportDefinition(venue, { fixture: "spot", corrections: true });
    expect(out.corrected).to.equal(true);
    expect(out.applied.map((n) => n.part)).to.deep.equal(["wheel"]);
    const bytes = Buffer.from(out.base64!, "base64");
    expect(bytes.equals(Buffer.from(text.replace('Res1="#ff8000">Orange', 'Res1="#ff6600">Orange'), "latin1"))).to.equal(true);
    expect(bytes.includes(Buffer.from([0x43, 0x61, 0x66, 0xe9]))).to.equal(true); // « Café » in Latin-1
    expect(out.xml).to.include("Café").and.not.include("\uFFFD");
    // without corrections: the very bytes
    expect(Buffer.from(exportDefinition(venue, { fixture: "spot" }).base64!, "base64").equals(latin)).to.equal(true);
  });

  it("only says written what the file, read again, carries: names as the import reads them, duplicates refused", () => {
    const orange = { wheel: { slots: { "20": { color: "#ff6600" } } } };
    const exportWith = (xml: string) => {
      const { venue } = makeVenue({ "wheel-spot.qxf": xml });
      venue.putOverridePart("spot", "model", "wheel", orange.wheel);
      return exportDefinition(venue, { fixture: "spot", corrections: true });
    };
    const wheelSpot = fixtureText("wheel-spot.qxf");
    // a name with spaces around it, or with a numeric reference the import keeps as written: still found
    for (const xml of [wheelSpot.replace('<Channel Name="Color Wheel">', '<Channel Name=" Color Wheel ">'), wheelSpot.replaceAll("Color Wheel", "Color &#87;heel"), wheelSpot.replaceAll("Color Wheel", "Color &amp; Wheel")]) {
      const out = exportWith(xml);
      expect(out.corrected).to.equal(true);
      expect(out.applied).to.have.length(1);
      expect(out.notExported).to.deep.equal([]);
    }
    // a DOCTYPE entity in the name: the import expands it, this writer cannot find it: not said written
    const entity = exportWith(wheelSpot.replace("<!DOCTYPE FixtureDefinition>", '<!DOCTYPE FixtureDefinition [ <!ENTITY w "Wheel"> <!-- a > b --> ]>').replaceAll("Color Wheel", "Color &w;"));
    expect(entity.corrected).to.equal(false);
    expect(entity.applied).to.deep.equal([]);
    expect(entity.notExported.map((n) => n.message).join("\n")).to.match(/n'a pas pu être écrite|could not be written/);
    // two channels of that name: refused, said once
    const twice = exportWith(wheelSpot.replace(' <Channel Name="Dimmer"', ' <Channel Name="Color Wheel">\n  <Group Byte="0">Colour</Group>\n  <Capability Min="0" Max="19" Preset="ColorMacro" Res1="#ffffff">A</Capability>\n  <Capability Min="20" Max="255" Preset="ColorMacro" Res1="#000000">B</Capability>\n </Channel>\n <Channel Name="Dimmer"'));
    expect(twice.corrected).to.equal(false);
    expect(twice.applied).to.deep.equal([]);
    expect(twice.notExported.map((n) => n.message)).to.have.length(1).and.satisfy((m: string[]) => /plusieurs canaux|several channels/.test(m[0]!));
    // two modes of one name: their heads are not declared, said once
    const wash = fixtureText("wash-zones.qxf").replace(/( <Mode Name="18 Channel">[\s\S]*?<\/Mode>\n)/, "$1$1");
    const modes = exportDefinition(makeVenue({ "wash-zones.qxf": wash }).venue, { fixture: "wash", corrections: true });
    expect(modes.corrected).to.equal(false);
    expect(modes.applied).to.deep.equal([]);
    expect(modes.notExported.map((n) => n.message)).to.have.length(1).and.satisfy((m: string[]) => /plusieurs modes|several modes/.test(m[0]!));
    // the writer alone says the refusal too
    expect(writeQxfCorrections(wash, { heads: [{ mode: "18 Channel", heads: [[2, 3]] }] }).refused.map((r) => r.key)).to.deep.equal(["mode:18 Channel"]);
  });

  it("exports with corrections a file it cannot edit when there is nothing to write, and names the file when there is", () => {
    const wheelSpot = fixtureText("wheel-spot.qxf");
    for (const xml of [wheelSpot.replace('Byte="0"', "Byte=0"), wheelSpot.replace("</Creator>", "</creator>"), `${wheelSpot}<x>`]) {
      const { venue } = makeVenue({ "wheel-spot.qxf": xml });
      const none = exportDefinition(venue, { fixture: "spot", corrections: true });
      expect(none.corrected).to.equal(false);
      expect(none.xml).to.equal(xml);
      venue.putOverridePart("spot", "model", "wheel", { slots: { "20": { color: "#ff6600" } } });
      expect(() => exportDefinition(venue, { fixture: "spot", corrections: true })).to.throw(/^wheel-spot\.qxf : .*(ne peuvent pas être écrites|cannot be written)/);
    }
    // a numeric reference beyond Unicode in a name: kept as written, no failure
    const big = wheelSpot.replace('<Channel Name="Pan"', '<Channel Name="P&#x110000;an"').replace(">Pan<", ">P&#x110000;an<");
    const bigVenue = makeVenue({ "wheel-spot.qxf": big }).venue;
    bigVenue.putOverridePart("spot", "model", "wheel", { slots: { "20": { color: "#ff6600" } } });
    const out = exportDefinition(bigVenue, { fixture: "spot", corrections: true });
    expect(out.applied).to.have.length(1);
    expect(out.xml).to.include("P&#x110000;an");
  });

  it("opens a self-closing <Physical/> to write the travel", () => {
    const wash = fixtureText("wash-zones.qxf").replace("</FixtureDefinition>", ' <Physical Note="x"/>\n</FixtureDefinition>');
    const out = applyQxfCorrections(wash, { travel: { panMax: 630, tiltMax: 200 } });
    expect(out).to.include(' <Physical Note="x">\n  <Focus Type="Head" PanMax="630" TiltMax="200"/>\n </Physical>\n</FixtureDefinition>');
    const again = parseQxf(out);
    expect([again.panMax, again.tiltMax]).to.deep.equal([630, 200]);
  });

  it("does not tag a colour slot's preset as a built-in macro", () => {
    expect(capabilityTags("Red", "ColorMacro")).to.deep.equal([]);
    expect(capabilityTags("Red / Green", "ColorDoubleMacro")).to.deep.equal([]);
    expect(capabilityTags("Macro 1", "ColorMacro")).to.include("builtinMacro");
    expect(capabilityTags("Effect", "GenericMacro")).to.include("builtinMacro");
    expect(parseQxf(fixtureText("wheel-spot.qxf")).channels.get("Color Wheel")!.capabilities[1]!.tags).to.deep.equal([]);
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
    // a fixture or a model, not both
    let refused: Error | undefined;
    await plugin.commands.invoke("fixture.definition.export", { fixture: "x", manufacturer: "Test", model: "Wheel Spot" }, systemContext()).catch((e: Error) => (refused = e));
    expect(refused?.message).to.match(/pas les deux|not both/);
  });
});
