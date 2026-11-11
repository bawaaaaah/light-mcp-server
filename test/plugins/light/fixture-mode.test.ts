import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext, type CommandError } from "../../../src/plugins/light/commands/registry.js";

/**
 * T6: venue.fixture.mode (a fixture's DMX mode, its references carried over by channel name, one proposal
 * that show.revert takes back, the shared-venue choice) and fixture.channel.mode (a channel's working mode by
 * name, through its own fader, highest takes precedence with the looks). The synthetic « Mode Par »
 * (test/fixtures/mode-par.qxf) is patched at U1.1 in its 6-channel mode, a Bar 4 at U1.8.
 */
describe("fixture modes: DMX mode and a channel's working mode (T6)", () => {
  let plugin: LightPlugin;
  let dataRoot: string;
  const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
  const refusal = (p: Promise<unknown>) =>
    p.then(
      () => expect.fail("refused expected"),
      (e: unknown) => e as CommandError,
    );
  const par = () => plugin.runtime.venue.fixtures.get("par")!;
  const look = (id: string, targets: { fixture: string; offset: number }[], steps: number[][]) => ({ id, name: id, canvas: "none", technique: { kind: "plat", color: "#000000" }, channels: { targets, steps } });
  type Plan = { moved: { id: string; from: number; to: number; message: string }[]; lost: { id: string; channel?: string; message: string }[]; overlaps: string[]; freeAddress?: number; proposal?: string; relaunched: string[]; info: string[]; emptied: { id: string }[]; cellsWithoutRender: { canvas: string; cells: number[] }[]; sharedWith: string[] };

  beforeEach(async () => {
    dataRoot = join(mkdtempSync(join(tmpdir(), "light-fixture-mode-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    for (const f of ["mode-par.qxf", "bar4.qxf"]) copyFileSync(new URL(`../../fixtures/${f}`, import.meta.url), join(dataRoot, "fixtures", f));
    let cfg: Record<string, unknown> = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async (c) => void (cfg = c as Record<string, unknown>) }, dataRoot, midiNative: null });
    await run("venue.fixture.put", { fixture: { id: "par", name: "Par", manufacturer: "Test", model: "Mode Par", mode: "6 Channel", universe: 1, address: 1 } });
    await run("venue.fixture.put", { fixture: { id: "bar", name: "Barre", manufacturer: "Test", model: "Bar 4", mode: "15 Channel", universe: 1, address: 8 } });
    await run("venue.canvas.put", { canvas: { id: "none", name: "Vide", topology: "line", cells: 1, render: [] } });
  });

  it("refuses a mode the definition does not have, naming those it has, and a fixture without a definition", async () => {
    const e = await refusal(run("venue.fixture.mode", { id: "par", mode: "12 Channel" }));
    expect(e.message).to.contain("6 Channel (6)").and.contain("Pixel (9)");
    await run("venue.fixture.put", { fixture: { id: "ghost", name: "Fantôme", manufacturer: "Nobody", model: "Nothing", mode: "1", universe: 1, address: 300 } });
    expect((await refusal(run("venue.fixture.mode", { id: "ghost", mode: "2" }))).message).to.contain("définition manquante");
    expect(await run("venue.fixture.mode", { id: "par", mode: "6 Channel" })).to.deep.include({ unchanged: true });
  });

  it("previews the change without writing it, then carries looks and faders by channel name; show.revert takes it all back", async () => {
    await run("look.put", { look: look("prog", [{ fixture: "par", offset: 4 }, { fixture: "par", offset: 5 }], [[23, 100]]) });
    await run("fader.put", { fader: { id: "dim", name: "Gradateur", channels: [{ fixture: "par", offset: 0 }], level: 0.5 } });
    const preview = (await run("venue.fixture.mode", { id: "par", mode: "8 Channel", dryRun: true })) as Plan;
    expect(preview.moved.map((m) => `${m.id}:${m.from}→${m.to}`)).to.deep.equal(["prog:4→6", "prog:5→7", "dim:0→1"]);
    expect(preview.lost).to.deep.equal([]);
    // 8 channels from U1.1 reach the bar's first channel: said, with where it would fit
    expect(preview.overlaps.join()).to.contain("Barre").and.contain("U1.8");
    expect(preview.freeAddress).to.equal(23);
    expect(par().mode).to.equal("6 Channel");
    // the overlap refuses it, unless forced; the bar moved away, it goes through
    expect((await refusal(run("venue.fixture.mode", { id: "par", mode: "8 Channel" }))).message).to.contain("force: true");
    await run("venue.fixture.put", { fixture: { ...plugin.runtime.venue.fixtures.get("bar")!, address: 100 } });
    const done = (await run("venue.fixture.mode", { id: "par", mode: "8 Channel" })) as Plan;
    expect(par().mode).to.equal("8 Channel");
    expect(plugin.runtime.looks.get("prog")!.channels!.targets).to.deep.equal([{ fixture: "par", offset: 6 }, { fixture: "par", offset: 7 }]);
    expect(plugin.runtime.faders.get("dim")!.channels).to.deep.equal([{ fixture: "par", offset: 1 }]);
    expect(done.proposal).to.be.a("string");
    await run("show.revert", { id: done.proposal });
    expect(par().mode).to.equal("6 Channel");
    expect(plugin.runtime.looks.get("prog")!.channels!.targets).to.deep.equal([{ fixture: "par", offset: 4 }, { fixture: "par", offset: 5 }]);
    expect(plugin.runtime.faders.get("dim")!.channels).to.deep.equal([{ fixture: "par", offset: 0 }]);
  });

  it("refuses losses unless forced, naming them; forced, a fader left with no channel goes, and comes back with the revert", async () => {
    await run("look.put", { look: look("prog", [{ fixture: "par", offset: 4 }, { fixture: "par", offset: 0 }], [[23, 255]]) });
    await run("fader.put", { fader: { id: "speed", name: "Vitesse", channels: [{ fixture: "par", offset: 5 }], level: 0.2 } });
    const e = await refusal(run("venue.fixture.mode", { id: "par", mode: "Pixel" }));
    expect(e.message).to.contain("« Program »").and.contain("perdu").and.contain("Vitesse");
    expect(par().mode).to.equal("6 Channel");
    expect(plugin.runtime.looks.get("prog")!.channels!.targets).to.have.length(2);
    const done = (await run("venue.fixture.mode", { id: "par", mode: "Pixel", force: true })) as Plan;
    expect(done.emptied.map((x) => x.id)).to.deep.equal(["speed"]);
    expect(plugin.runtime.looks.get("prog")!.channels).to.deep.equal({ targets: [{ fixture: "par", offset: 0 }], steps: [[255]] });
    expect(plugin.runtime.faders.get("speed")).to.equal(undefined);
    await run("show.revert", { id: done.proposal });
    expect(plugin.runtime.faders.get("speed")!.channels).to.deep.equal([{ fixture: "par", offset: 5 }]);
    expect(plugin.runtime.looks.get("prog")!.channels!.steps).to.deep.equal([[23, 255]]);
  });

  it("keeps canvas heads known by their channels' names, and says which looks playing are restarted", async () => {
    await run("venue.fixture.put", { fixture: { ...par(), mode: "Pixel", address: 30 } });
    await run("venue.canvas.put", { canvas: { id: "pix", name: "Pixels", topology: "line", cells: 2, render: [{ from: 0, to: 0, targets: [{ fixture: "par", head: 0 }] }, { from: 1, to: 1, targets: [{ fixture: "par", head: 1 }] }] } });
    await run("look.put", { look: look("macro", [{ fixture: "par", offset: 0 }], [[200]]) });
    await run("look.go", { id: "macro" });
    const done = (await run("venue.fixture.mode", { id: "par", mode: "Pixel reversed" })) as Plan;
    // the heads are numbered by their names (« Red 1 » is head 1 wherever it sits): same sets, same heads
    expect(plugin.runtime.venue.canvases.get("pix")!.render.map((r) => r.targets[0]!.head)).to.deep.equal([0, 1]);
    expect(done.relaunched).to.deep.equal([]); // its only channel (Dimmer) stays where it was
    // back to 6 channels: no heads to match, the cells go dark (said), the dimmer stays
    const back = (await run("venue.fixture.mode", { id: "par", mode: "6 Channel", dryRun: true })) as Plan;
    expect(back.cellsWithoutRender).to.deep.equal([{ canvas: "pix", name: "Pixels", cells: [0, 1] }]);
    await run("look.put", { look: look("macro", [{ fixture: "par", offset: 7 }], [[200]]) });
    await run("look.go", { id: "macro" });
    expect(((await run("venue.fixture.mode", { id: "par", mode: "Pixel", dryRun: true })) as Plan).relaunched).to.deep.equal(["macro"]);
  });

  it("says when a halo correction no longer acts in the new mode", async () => {
    await run("venue.fixture.put", { fixture: { ...par(), mode: "Pixel", address: 30 } });
    await run("venue.fixture.heads.set", { fixture: "par", scope: "fixture", accent: ["Red 2", "Green 2", "Blue 2"] });
    const plan = (await run("venue.fixture.mode", { id: "par", mode: "6 Channel", dryRun: true })) as Plan;
    expect(plan.info.join()).to.contain("halo");
  });

  describe("on a venue shared with another show", () => {
    let other: string;
    beforeEach(async () => {
      await run("venue.fixture.put", { fixture: { ...plugin.runtime.venue.fixtures.get("bar")!, address: 100 } });
      other = ((await run("show.create", { name: "Deuxième", venue: "current", open: false })) as { id: string }).id;
      // the other show has a look on the par too, written in its folder
      const dir = join(dataRoot, "shows", other, "looks");
      mkdirSync(dir, { recursive: true });
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(dir, "theirs.json"), JSON.stringify({ ...look("theirs", [{ fixture: "par", offset: 4 }], [[50]]), timing: {} }));
    });
    const theirs = () => JSON.parse(readFileSync(join(dataRoot, "shows", other, "looks", "theirs.json"), "utf8")) as { channels: { targets: { offset: number }[] } };

    it("asks to choose, naming the other show; the preview says it", async () => {
      const e = await refusal(run("venue.fixture.mode", { id: "par", mode: "8 Channel" }));
      expect(e.message).to.contain("Deuxième").and.contain("copy").and.contain("all");
      expect(e.detail).to.deep.equal({ shared: ["Deuxième"] });
      expect(((await run("venue.fixture.mode", { id: "par", mode: "8 Channel", dryRun: true })) as Plan).sharedWith).to.deep.equal(["Deuxième"]);
      expect(par().mode).to.equal("6 Channel");
    });

    it("« all »: changes it for every show, the other show's looks carried over too, and taken back with the revert", async () => {
      const done = (await run("venue.fixture.mode", { id: "par", mode: "8 Channel", shared: "all" })) as Plan & { otherShows: { show: string; looks: number }[] };
      expect(done.otherShows).to.deep.equal([{ show: "Deuxième", looks: 1, faders: 0, lost: 0 }]);
      expect(theirs().channels.targets[0]!.offset).to.equal(6);
      await run("show.revert", { id: done.proposal });
      expect(theirs().channels.targets[0]!.offset).to.equal(4);
      expect(par().mode).to.equal("6 Channel");
    });

    it("« copy »: this show gets a venue of its own, the other keeps the old mode and its looks", async () => {
      const done = (await run("venue.fixture.mode", { id: "par", mode: "8 Channel", shared: "copy" })) as Plan & { detached?: boolean };
      expect(done.detached).to.equal(true);
      expect(par().mode).to.equal("8 Channel");
      const venues = (await run("venue.list")) as { id: string; shows: string[]; active: boolean }[];
      const original = venues.find((v) => v.shows.includes(other))!;
      expect(original.active).to.equal(false);
      expect((JSON.parse(readFileSync(join(dataRoot, "venues", original.id, "fixtures", "par.json"), "utf8")) as { mode: string }).mode).to.equal("6 Channel");
      expect(theirs().channels.targets[0]!.offset).to.equal(4);
    });

    const activeVenue = async () => ((await run("venue.list")) as { id: string; active: boolean }[]).find((v) => v.active)!.id;

    it("« copy » with a loss and no force: refused before anything moves, the show still on the shared venue", async () => {
      const venueBefore = await activeVenue();
      await run("look.put", { look: look("prog", [{ fixture: "par", offset: 4 }], [[23]]) });
      await run("look.go", { id: "prog" });
      const preview = (await run("venue.fixture.mode", { id: "par", mode: "Pixel", shared: "copy", dryRun: true })) as Plan & { detach: { stopped: string[] } };
      expect(preview.detach.stopped).to.deep.equal(["prog"]); // reopened on the copy: what plays stops, said first
      expect((await refusal(run("venue.fixture.mode", { id: "par", mode: "Pixel", shared: "copy" }))).message).to.contain("force: true");
      expect(await activeVenue()).to.equal(venueBefore);
      expect(par().mode).to.equal("6 Channel");
      expect(plugin.runtime.isActive("prog")).to.equal(true);
    });

    it("« all »: a fader emptied in the other show goes from its folder and comes back with the revert; a later edit there is left alone", async () => {
      const { writeFileSync } = await import("node:fs");
      const faders = join(dataRoot, "shows", other, "faders");
      mkdirSync(faders, { recursive: true });
      writeFileSync(join(faders, "speed.json"), JSON.stringify({ id: "speed", name: "Vitesse", channels: [{ fixture: "par", offset: 5 }], level: 0 }));
      const preview = (await run("venue.fixture.mode", { id: "par", mode: "Pixel", shared: "all", dryRun: true })) as Plan & { otherShows: { lost: number }[] };
      expect(preview.emptied).to.deep.include({ show: "Deuxième", id: "speed", name: "Vitesse", usedBy: [] });
      expect(preview.otherShows[0]!.lost).to.equal(2); // their look's « Program », their fader
      const done = (await run("venue.fixture.mode", { id: "par", mode: "Pixel", shared: "all", force: true })) as Plan;
      const { existsSync } = await import("node:fs");
      expect(existsSync(join(faders, "speed.json"))).to.equal(false);
      // their look edited since (by hand here): the revert leaves it and says so
      writeFileSync(join(dataRoot, "shows", other, "looks", "theirs.json"), JSON.stringify({ ...look("theirs", [{ fixture: "par", offset: 0 }], [[99]]), timing: {} }));
      const back = (await run("show.revert", { id: done.proposal })) as { warnings?: string[] };
      expect(existsSync(join(faders, "speed.json"))).to.equal(true);
      expect(back.warnings!.join()).to.contain("Deuxième · theirs");
      expect(theirs().channels.targets[0]!.offset).to.equal(0);
    });

    it("« all »: a look of the other show that cannot be read refuses unless forced, named", async () => {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(dataRoot, "shows", other, "looks", "broken.json"), JSON.stringify({ id: "broken" }));
      const preview = (await run("venue.fixture.mode", { id: "par", mode: "8 Channel", shared: "all", dryRun: true })) as Plan & { unreadable: { show: string }[] };
      expect(preview.unreadable.map((u) => u.show)).to.deep.equal(["Deuxième"]);
      expect((await refusal(run("venue.fixture.mode", { id: "par", mode: "8 Channel", shared: "all" }))).message).to.contain("illisible");
      expect(par().mode).to.equal("6 Channel");
    });

    it("« all »: a write failing in the other show takes everything back, and the proposal is not left to apply", async () => {
      const { chmodSync } = await import("node:fs");
      const looksDir = join(dataRoot, "shows", other, "looks");
      chmodSync(looksDir, 0o555);
      try {
        const e = await refusal(run("venue.fixture.mode", { id: "par", mode: "8 Channel", shared: "all" }));
        expect(e.message).to.contain("rien n'a changé");
      } finally {
        chmodSync(looksDir, 0o755);
      }
      expect(par().mode).to.equal("6 Channel");
      expect(theirs().channels.targets[0]!.offset).to.equal(4);
      const proposals = (await run("show.proposals")) as { status: string }[];
      expect(proposals.map((p) => p.status)).to.deep.equal(["discarded"]);
    });
  });

  it("refuses an undo over what was edited since, naming it, unless forced; a live fader level is no edit", async () => {
    await run("venue.fixture.put", { fixture: { ...plugin.runtime.venue.fixtures.get("bar")!, address: 100 } });
    await run("look.put", { look: look("prog", [{ fixture: "par", offset: 4 }], [[23]]) });
    await run("fader.put", { fader: { id: "dim", name: "Gradateur", channels: [{ fixture: "par", offset: 0 }], level: 0.5 } });
    const done = (await run("venue.fixture.mode", { id: "par", mode: "8 Channel" })) as Plan;
    await run("fader.level", { id: "dim", level: 0.9 });
    await run("look.put", { look: { ...plugin.runtime.looks.get("prog")!, name: "Programme renommé" } });
    await run("venue.fixture.put", { fixture: { ...par(), address: 50 } });
    const e = await refusal(run("show.revert", { id: done.proposal }));
    expect((e.detail as { changed: string[] }).changed).to.deep.equal(["Par (fixtures)", "Programme renommé (looks)"]);
    expect(par().mode).to.equal("8 Channel");
    await run("show.revert", { id: done.proposal, force: true });
    expect(par()).to.include({ mode: "6 Channel", address: 1 });
  });

  it("refuses a second change of the same fixture while one is running", async () => {
    await run("venue.fixture.put", { fixture: { ...plugin.runtime.venue.fixtures.get("bar")!, address: 100 } });
    const results = await Promise.allSettled([run("venue.fixture.mode", { id: "par", mode: "8 Channel" }), run("venue.fixture.mode", { id: "par", mode: "Pixel", force: true })]);
    expect(results.map((r) => r.status)).to.deep.equal(["fulfilled", "rejected"]);
    expect(String(((results[1] as PromiseRejectedResult).reason as Error).message)).to.contain("déjà en cours");
    expect(par().mode).to.equal("8 Channel");
  });

  it("says in the preview that the venue's other shows cannot be read, instead of refusing it", async () => {
    const { writeFileSync } = await import("node:fs");
    const other = ((await run("show.create", { name: "Abîmé", venue: "current", open: false })) as { id: string }).id;
    writeFileSync(join(dataRoot, "shows", other, "show.json"), "{ not json");
    const preview = (await run("venue.fixture.mode", { id: "par", mode: "Pixel reversed", dryRun: true })) as Plan & { othersUnreadable?: string };
    expect(preview.othersUnreadable).to.contain(other);
    expect((await refusal(run("venue.fixture.mode", { id: "par", mode: "Pixel reversed" }))).message).to.contain("force: true");
  });

  it("is not redone after its undo (its plan is read again by running it again)", async () => {
    await run("venue.fixture.put", { fixture: { ...plugin.runtime.venue.fixtures.get("bar")!, address: 100 } });
    const done = (await run("venue.fixture.mode", { id: "par", mode: "8 Channel" })) as Plan;
    await run("show.revert", { id: done.proposal });
    expect((await refusal(run("show.apply", { id: done.proposal }))).message).to.contain("ne se refait pas");
    expect(par().mode).to.equal("6 Channel");
  });

  it("takes a canvas back with the undo, a look playing on it included", async () => {
    await run("venue.fixture.put", { fixture: { ...par(), mode: "Pixel", address: 30 } });
    const render = [{ from: 0, to: 0, targets: [{ fixture: "par", head: 0 }] }, { from: 1, to: 1, targets: [{ fixture: "par", head: 1 }] }];
    await run("venue.canvas.put", { canvas: { id: "pix", name: "Pixels", topology: "line", cells: 2, render } });
    await run("look.put", { look: { id: "on-pix", name: "Sur les pixels", canvas: "pix", technique: { kind: "plat", color: "#ff0000" } } });
    await run("look.go", { id: "on-pix" });
    const done = (await run("venue.fixture.mode", { id: "par", mode: "6 Channel", force: true })) as Plan;
    expect(plugin.runtime.venue.canvases.get("pix")!.render).to.deep.equal([]);
    await run("show.revert", { id: done.proposal });
    expect(par().mode).to.equal("Pixel");
    expect(plugin.runtime.venue.canvases.get("pix")!.render).to.deep.equal(render);
  });

  describe("fixture.channel.mode", () => {
    const value = () => plugin.engine.output.get(1)[par().address - 1 + 4]!;

    it("tells two modes of one name apart by their first value, and refuses the name alone", async () => {
      await run("venue.fixture.put", { fixture: { ...par(), mode: "Pixel reversed", address: 30 } });
      const e = await refusal(run("fixture.channel.mode", { fixture: "par", channel: "Macro", mode: "No function" }));
      expect(e.message).to.contain("No function (0–9), No function (246–255)").and.contain("min");
      expect(await run("fixture.channel.mode", { fixture: "par", channel: "Macro", mode: "No function", min: 246 })).to.include({ value: 250, output: 250, min: 246 });
      expect(await run("fixture.channel.mode", { fixture: "par", channel: "Macro", mode: "No function", min: 0 })).to.include({ value: 4 });
      expect((await refusal(run("fixture.channel.mode", { fixture: "par", channel: "Macro", mode: "No function", min: 5 }))).message).to.contain("ne commence à 5");
    });

    it("names the fader holding the channel, not the look under it", async () => {
      await run("look.put", { look: look("low", [{ fixture: "par", offset: 4 }], [[150]]) });
      await run("look.go", { id: "low" });
      // two channels: not the panel's own fader of this channel
      await run("fader.put", { fader: { id: "high", name: "Haut", channels: [{ fixture: "par", offset: 4 }, { fixture: "bar", offset: 0 }], level: 220 / 255 } });
      const r = (await run("fixture.channel.mode", { fixture: "par", channel: "Program", mode: "Auto", variant: "Auto 1" })) as { output: number; heldBy: { looks: unknown[]; faders: { id: string }[] } };
      expect(r.output).to.equal(220);
      expect(r.heldBy.looks).to.deep.equal([]);
      expect(r.heldBy.faders.map((x) => x.id)).to.deep.equal(["high"]);
    });

    it("under a blackout says the output is below, not that someone holds it", async () => {
      plugin.engine.setBlackout(true);
      const r = (await run("fixture.channel.mode", { fixture: "par", channel: "Program", mode: "Auto", variant: "Auto 2" })) as Record<string, unknown>;
      expect(r).to.include({ output: 0, below: true, blackout: true });
      expect(r.heldBy).to.equal(undefined);
      plugin.engine.setBlackout(false);
    });

    it("sets a channel's mode and variant by name through its own fader, at the middle of the range", async () => {
      const r = (await run("fixture.channel.mode", { fixture: "par", channel: "Program", mode: "Auto", variant: "Auto 2" })) as { fader: string; value: number; output: number; heldBy?: unknown };
      expect(r).to.include({ offset: 4, mode: "Auto", variant: "Auto 2", value: 55, output: 55 });
      expect(r.heldBy).to.equal(undefined);
      expect(plugin.runtime.faders.get(r.fader)!.channels).to.deep.equal([{ fixture: "par", offset: 4 }]);
      // the same fader again: the first variant when none is given; a continuous mode takes a value
      const again = (await run("fixture.channel.mode", { fixture: "par", offset: 4, mode: "sound" })) as { fader: string; value: number };
      expect(again).to.include({ fader: r.fader, value: 119 });
      expect(plugin.runtime.faders.list().filter((f) => f.channels[0]!.offset === 4)).to.have.length(1);
      expect(await run("fixture.channel.mode", { fixture: "par", channel: "Speed", mode: "Speed slow → fast", value: 128 })).to.include({ value: 128, output: 128 });
    });

    it("names the look holding the channel higher (highest takes precedence)", async () => {
      await run("look.put", { look: look("fade", [{ fixture: "par", offset: 4 }], [[230]]) });
      await run("look.go", { id: "fade" });
      const r = (await run("fixture.channel.mode", { fixture: "par", channel: "Program", mode: "Auto", variant: "Auto 1" })) as { output: number; heldBy?: { looks: { id: string }[] } };
      expect(r.output).to.equal(230);
      expect(value()).to.equal(230);
      expect(r.heldBy!.looks.map((l) => l.id)).to.deep.equal(["fade"]);
      await run("look.stop", { id: "fade" });
    });

    it("refuses an unknown mode, variant or channel, and a value for a mode that is not continuous", async () => {
      expect((await refusal(run("fixture.channel.mode", { fixture: "par", channel: "Program", mode: "Laser" }))).message).to.contain("Auto (8–103), Sound (104–167)");
      expect((await refusal(run("fixture.channel.mode", { fixture: "par", channel: "Program", mode: "Auto", variant: "Auto 9" }))).message).to.contain("Auto 1, Auto 2, Auto 3");
      expect((await refusal(run("fixture.channel.mode", { fixture: "par", channel: "Nope", mode: "Auto" }))).message).to.contain("canal inconnu");
      expect((await refusal(run("fixture.channel.mode", { fixture: "par", channel: "Dimmer", mode: "Auto" }))).message).to.contain("pas de fonctions");
      expect((await refusal(run("fixture.channel.mode", { fixture: "par", channel: "Program", mode: "Auto", value: 30 }))).message).to.contain("continu");
    });

    it("lists the channel's modes in venue.fixture.channels, beside its flat ranges", async () => {
      const rows = (await run("venue.fixture.channels")) as { id: string; channels: { name: string; ranges?: unknown[]; modes?: { name: string; variants: unknown[]; continuous: boolean }[] }[] }[];
      const program = rows.find((r) => r.id === "par")!.channels.find((c) => c.name === "Program")!;
      expect(program.ranges).to.have.length(8);
      expect(program.modes!.map((m) => `${m.name}/${m.variants.length}`)).to.deep.equal(["No function/1", "Auto/3", "Sound/2", "Color fade/2"]);
    });
  });
});
