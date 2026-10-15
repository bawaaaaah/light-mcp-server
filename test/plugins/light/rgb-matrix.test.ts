import { expect } from "chai";
import { readFileSync } from "node:fs";
import { parseQxf } from "../../../src/plugins/light/venue/qxf-import.js";
import { parseQxw } from "../../../src/plugins/light/presets/qxw-import.js";
import { matrixTechnique, qxwToShow } from "../../../src/plugins/light/presets/qxw-to-show.js";

const bar4 = parseQxf(readFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), "utf8"));

/** Two 4-head bars; a fixture group puts them in a 4 × 2 grid; two matrices started by buttons. */
const WORKSPACE = `<?xml version="1.0" encoding="UTF-8"?>
<Workspace><Creator><Version>4.14.1</Version></Creator><Engine>
<Fixture><Manufacturer>Test</Manufacturer><Model>Bar 4</Model><Mode>15 Channel</Mode><ID>0</ID><Name>Haut</Name><Universe>0</Universe><Address>0</Address><Channels>15</Channels></Fixture>
<Fixture><Manufacturer>Test</Manufacturer><Model>Bar 4</Model><Mode>15 Channel</Mode><ID>1</ID><Name>Bas</Name><Universe>0</Universe><Address>15</Address><Channels>15</Channels></Fixture>
<FixtureGroup ID="0"><Name>Mur</Name><Size X="4" Y="2"/>
<Head X="0" Y="0" Fixture="0">0</Head><Head X="1" Y="0" Fixture="0">1</Head><Head X="2" Y="0" Fixture="0">2</Head><Head X="3" Y="0" Fixture="0">3</Head>
<Head X="0" Y="1" Fixture="1">0</Head><Head X="1" Y="1" Fixture="1">1</Head><Head X="2" Y="1" Fixture="1">2</Head><Head X="3" Y="1" Fixture="1">3</Head>
</FixtureGroup>
<Function ID="1" Type="RGBMatrix" Name="alterne"><Speed FadeIn="0" FadeOut="0" Duration="500"/><Direction>Forward</Direction><RunOrder>Loop</RunOrder><Algorithm Type="Script">Alternate</Algorithm><Color Index="0">4294901760</Color><Color Index="1">4278190335</Color><FixtureGroup>0</FixtureGroup></Function>
<Function ID="2" Type="RGBMatrix" Name="bandes"><Speed FadeIn="0" FadeOut="0" Duration="1000"/><Direction>Forward</Direction><RunOrder>Loop</RunOrder><Algorithm Type="Script">Stripes</Algorithm><Color Index="0">4294901760</Color><FixtureGroup>0</FixtureGroup><Property Name="color1Index" Value="Blue"/><Property Name="color2Index" Value="Cyan"/><Property Name="color3Index" Value="White"/></Function>
<Function ID="3" Type="RGBMatrix" Name="jamais"><Speed FadeIn="0" FadeOut="0" Duration="500"/><Algorithm Type="Plain"/><Color Index="0">4294901760</Color><FixtureGroup>0</FixtureGroup></Function>
</Engine>
<VirtualConsole><Frame Caption="">
<Button Caption="Alterne" ID="10"><Function ID="1"/><Action>Toggle</Action><Input Universe="0" Channel="164"/></Button>
<Button Caption="Bandes" ID="11"><Function ID="2"/><Action>Toggle</Action><Input Universe="0" Channel="165"/></Button>
</Frame></VirtualConsole></Workspace>`;

describe("QLC+ RGB matrices", () => {
  const ws = parseQxw(WORKSPACE);
  const p = qxwToShow(ws, [bar4]);

  it("reads the matrix (algorithm, colours, group) and the fixture group grid", () => {
    expect(ws.functions.get(1)!.matrix).to.deep.equal({ algorithm: "Alternate", colors: [0xff0000, 0x0000ff], fixtureGroup: 0, properties: {} });
    expect(ws.functions.get(3)!.matrix!.algorithm).to.equal("Plain");
    expect(ws.fixtureGroups[0]).to.deep.include({ id: 0, name: "Mur", width: 4, height: 2 });
    expect(ws.fixtureGroups[0]!.heads).to.have.length(8);
  });

  it("builds a canvas of the group, column by column", () => {
    const c = p.matrixCanvases[0]!;
    expect(c).to.deep.include({ id: "qlc-groupe-0", cells: 8 });
    expect(c.render.slice(0, 3).map((r) => r.targets[0])).to.deep.equal([
      { fixture: "haut", head: 0 },
      { fixture: "bas", head: 0 },
      { fixture: "haut", head: 1 },
    ]);
  });

  it("turns the matrices buttons start into looks with the nearest technique, and keeps their notes", () => {
    const alt = p.looks.find((l) => l.id === "alterne")!;
    expect(alt).to.deep.include({ canvas: "qlc-groupe-0" });
    expect(alt.technique).to.deep.equal({ kind: "damier", colors: ["#ff0000", "#0000ff"], block: 1 });
    expect(p.looks.find((l) => l.id === "bandes")!.technique).to.deep.equal({ kind: "palette", colors: ["#0000ff", "#00ffff", "#ffffff"], block: 1 });
    expect(p.looks.find((l) => l.id === "jamais")).to.equal(undefined); // no widget starts it
    expect(p.report.warnings).to.include("matrice « bandes » (Stripes) : approximée par la technique palette");
    expect(p.mappings.map((m) => [m.input.number, m.on.args.id])).to.deep.include.members([
      [36, "alterne"],
      [37, "bandes"],
    ]);
  });

  it("maps the other algorithms", () => {
    const m = (algorithm: string, properties: Record<string, string> = {}) => matrixTechnique({ algorithm, colors: [0x00ff00], fixtureGroup: 0, properties }, 3).technique;
    expect(m("Plain")).to.deep.equal({ kind: "plat", color: "#00ff00" });
    expect(m("Plasma").kind).to.equal("palette");
    expect(m("Flying Objects")).to.deep.include({ kind: "masques", masks: ["#--", "-#-", "--#"] });
  });
});
