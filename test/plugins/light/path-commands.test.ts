import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";

/**
 * Zones and paths through the commands (T28): look.put checks the base (one at most) and what the stops name, says the
 * path's warnings at save, look.preview gives the stops resolved head by head, a zone cited by a path cannot be deleted
 * unless forced, and « Vérifier le show » says a stop gone and a trip crossing a no-aim zone.
 */
describe("zones and paths through the commands (T28)", () => {
  let plugin: LightPlugin;
  const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
  const refusal = async (name: string, args: unknown) => {
    try {
      await run(name, args);
    } catch (e) {
      return (e as Error).message;
    }
    return "";
  };
  const look = (move: object) => ({ id: "p", name: "Parcours", canvas: "lyres", technique: { kind: "aucune" }, move });
  const stops = [{ zone: "jardin" }, { zone: "cour" }];

  beforeEach(async () => {
    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-path-cmd-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    copyFileSync(new URL("../../fixtures/spot.qxf", import.meta.url), join(dataRoot, "fixtures", "spot.qxf"));
    const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
    const venue = plugin.runtime.venue;
    venue.fixtures.put({ id: "spot", name: "Spot 1", manufacturer: "Test", model: "Spot 7", mode: "Standard", universe: 1, address: 1, position: { x: 0, y: 1, z: 5 }, mount: "hung" });
    venue.canvases.put({ id: "lyres", name: "Lyres", topology: "line", cells: 1, render: [{ from: 0, to: 0, targets: [{ fixture: "spot", head: -1 }] }] });
    await run("stage.zone.put", { zone: { id: "jardin", name: "Estrade gauche", polygon: [[-3, 3], [-2, 3], [-2, 4], [-3, 4]], aim: { height: 1 } } });
    await run("stage.zone.put", { zone: { id: "cour", name: "Estrade droite", polygon: [[2, 3], [3, 3], [3, 4], [2, 4]], aim: {} } });
  });

  it("look.put: one base at most, a height for a zone only, the stops naming what exists", async () => {
    expect(await refusal("look.put", { look: look({ at: { zone: "jardin", path: { stops } } }) })).to.match(/une seule base|one base only/);
    expect(await refusal("look.put", { look: look({ at: { zone: "nulle-part" } }) })).to.match(/zone inconnue|unknown zone/);
    expect(await refusal("look.put", { look: look({ at: { height: 1 } }) })).to.match(/hauteur|height/);
    expect(await refusal("look.put", { look: look({ at: { path: { stops: [{ zone: "jardin" }, { position: "absente" }] } } }) })).to.match(/arrêt 2|stop 2/);
    expect(await refusal("look.put", { look: look({ at: { path: { stops: [{ zone: "jardin", point: { x: 0, y: 0, z: 0 } }] } } }) })).to.not.equal("");
    const saved = (await run("look.put", { look: look({ at: { path: { stops, order: "pingpong" } } }) })) as { move: { at: { path: { order: string; travel: number } } } };
    expect(saved.move.at.path).to.include({ order: "pingpong", travel: 0.5 });
    const back = (await run("look.get", { id: "p" })) as { move: { at: { path: { stops: unknown[] } } } };
    expect(back.move.at.path.stops).to.deep.equal(stops);
  });

  it("look.put and look.preview say a trip crossing a no-aim zone; the preview gives each stop for each head", async () => {
    await run("stage.zone.put", { zone: { id: "pupitre", name: "Pupitre", polygon: [[-1, 3], [1, 3], [1, 4], [-1, 4]], noAim: true } });
    const saved = (await run("look.put", { look: look({ at: { path: { stops } } }) })) as { warnings?: string[] };
    expect(saved.warnings?.join(" ")).to.match(/Pupitre/);
    const preview = (await run("look.preview", { look: look({ at: { path: { stops } } }) })) as { path?: { stops: { name: string; heads: { id: string; pan?: number; error?: string }[] }[]; warnings: { kind: string }[] } };
    expect(preview.path?.stops.map((s) => s.name)).to.deep.equal(["zone « Estrade gauche »", "zone « Estrade droite »"]);
    expect(preview.path?.stops[0]!.heads[0]!.id).to.equal("spot");
    expect(preview.path?.stops[0]!.heads[0]!.pan).to.be.a("number");
    expect(preview.path?.warnings.map((w) => w.kind)).to.deep.equal(["noAim"]);
  });

  it("a zone cited by a path or aimed at by a look cannot be deleted unless forced; « Vérifier le show » then says the stop gone", async () => {
    await run("look.put", { look: look({ at: { path: { stops } } }) });
    await run("look.put", { look: { ...look({ at: { zone: "jardin" } }), id: "z", name: "Sur la zone" } });
    const refused = await refusal("stage.zone.delete", { id: "cour" });
    expect(refused).to.match(/Parcours/);
    expect(await refusal("stage.zone.delete", { id: "jardin" })).to.match(/Sur la zone/);
    await run("stage.zone.delete", { id: "cour", force: true });
    const lint = (await run("show.lint")) as { issues: { level: string; where: string; message: string }[] };
    const mine = lint.issues.filter((i) => i.where === "look p");
    expect(mine.some((i) => i.level === "erreur" && /arrêt 2|stop 2/.test(i.message))).to.equal(true);
    // the look stays editable with its stop gone (deleted with force)
    expect(await refusal("look.put", { look: look({ at: { path: { stops } } }) })).to.equal("");
  });
});
