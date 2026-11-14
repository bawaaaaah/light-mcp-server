import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus, type PluginEvent } from "../../../src/core/event-bus.js";
import { AuthService, DEFAULT_ROLES, rightMatches } from "../../../src/core/auth.js";
import { ConfigStore } from "../../../src/core/config-store.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { CommandError, systemContext, type CommandContext } from "../../../src/plugins/light/commands/registry.js";

/**
 * « Figer les lyres » through its commands and rights (T26, lot 3; docs/specs/rules-limits.md, « Verrou des lyres »):
 * motion.freeze only hardens, motion.unfreeze only loosens, a group is expanded into its heads when frozen, the toggle
 * switches; soft freezing goes with the Panic (commands:freeze), hard freezing, the toggle and unfreezing need
 * commands:position; under a hard lock the position.* commands and calibration.record leave the head out, refused
 * when it is the only one, and remember nothing; the lock is in `state`. The engine side is motion-lock.test.ts.
 *
 * Two heads of the same model: « spot » and « spot2 ». One engine frame every 20 ms, time injected, no output route.
 */
describe("motion lock commands (T26, lot 3)", () => {
  let plugin: LightPlugin;
  let bus: EventBus;
  let now = 0;
  const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
  const run = (name: string, args: unknown = {}, ctx: CommandContext = systemContext()) => plugin.commands.invoke(name, args, ctx);
  /** A caller with these rights, as the server matches them (wildcards, implied rights). */
  const as = (rights: string[]): CommandContext => ({ origin: "ui", can: (right) => rights.some((g) => rightMatches(g, right)) });
  const role = (id: string) => as(DEFAULT_ROLES.find((r) => r.id === id)!.rights);
  const frame = () => {
    (plugin.engine as unknown as { frame(now: number): void }).frame(now);
    now += 20;
  };
  const during = (ms: number) => {
    for (let i = 0; i < ms / 20; i++) frame();
  };
  const lock = () => plugin.runtime.motionLockState();
  /** The CommandError a call throws (fails the test when it does not throw). */
  const refusal = async (p: Promise<unknown>): Promise<CommandError> => {
    try {
      await p;
    } catch (err) {
      expect(err).to.be.instanceOf(CommandError);
      return err as CommandError;
    }
    throw new Error("expected a refusal");
  };
  type Report = { level: string; heads: Record<string, string>; fixtures: { id: string; lock: string }[] };

  beforeEach(() => {
    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-lock-cmds-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    copyFileSync(new URL("../../fixtures/spot.qxf", import.meta.url), join(dataRoot, "fixtures", "spot.qxf"));
    now = 0;
    bus = new EventBus();
    plugin = new LightPlugin({ eventBus: bus, config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null, now: () => now });
    (plugin as unknown as { nextFrame: () => Promise<boolean> }).nextFrame = () => Promise.resolve((frame(), true));
    plugin.venue.fixtures.put({ id: "spot", name: "Spot", manufacturer: "Test", model: "Spot 7", mode: "Standard", universe: 1, address: 1, position: { x: -1, y: 2, z: 5 }, mount: "hung" });
    plugin.venue.fixtures.put({ id: "spot2", name: "Spot 2", manufacturer: "Test", model: "Spot 7", mode: "Standard", universe: 1, address: 11, position: { x: 1, y: 2, z: 5 }, mount: "hung" });
    plugin.runtime.zones.put({ id: "front", name: "Front", type: "stage", polygon: [[-1, 4], [1, 4], [1, 6], [-1, 6]], floorHeight: 0 } as never);
    plugin.runtime.groups.put({ id: "left", name: "Left", members: { fixtures: ["spot"], looks: [], groups: [] } } as never);
    during(100);
  });
  afterEach(async () => {
    await plugin.stop();
  });

  describe("motion.freeze and motion.unfreeze", () => {
    it("freezes globally, soft by default, and says each head's effective level", async () => {
      const r = (await run("motion.freeze")) as Report;
      expect(r).to.deep.include({ level: "soft", heads: {} });
      expect(r.fixtures).to.deep.equal([
        { id: "spot", lock: "soft" },
        { id: "spot2", lock: "soft" },
      ]);
      expect(plugin.runtime.heldPosition("spot")).to.not.equal(undefined); // frozen where it was sent
    });

    it("only hardens: soft on a hard lock keeps it hard, globally and per head", async () => {
      await run("motion.freeze", { level: "hard" });
      await run("motion.freeze", { level: "soft" });
      expect(lock().level).to.equal("hard");
      await run("motion.unfreeze");
      await run("motion.freeze", { fixtures: ["spot"], level: "hard" });
      await run("motion.freeze", { fixtures: ["spot"] });
      expect(lock()).to.deep.equal({ level: "off", heads: { spot: "hard" } });
    });

    it("expands a group into its heads when frozen: a head added to the group later stays free", async () => {
      const r = (await run("motion.freeze", { group: "left" })) as Report;
      expect(r.heads).to.deep.equal({ spot: "soft" });
      plugin.runtime.groups.put({ id: "left", name: "Left", members: { fixtures: ["spot", "spot2"], looks: [], groups: [] } } as never);
      expect(plugin.runtime.motionLock("spot2")).to.equal("off");
    });

    it("refuses a target without any installed moving head, and an unknown group", async () => {
      plugin.runtime.groups.put({ id: "empty", name: "Empty", members: { fixtures: [], looks: [], groups: [] } } as never);
      expect((await refusal(run("motion.freeze", { group: "empty" }))).code).to.equal("invalid");
      expect((await refusal(run("motion.freeze", { group: "nope" }))).message).to.match(/nope/);
    });

    it("unfreeze only loosens: hard → soft, soft → off, never freezes", async () => {
      await run("motion.unfreeze", { to: "soft" });
      expect(lock().level).to.equal("off");
      await run("motion.freeze", { level: "hard" });
      await run("motion.unfreeze", { to: "soft" });
      expect(lock().level).to.equal("soft");
      await run("motion.unfreeze");
      expect(lock().level).to.equal("off");
      expect(plugin.runtime.heldPosition("spot")).to.equal(undefined);
    });

    it("unfreezes a head on its own, and says when the global lock still holds it", async () => {
      await run("motion.freeze", { fixtures: ["spot", "spot2"], level: "hard" });
      await run("motion.unfreeze", { fixtures: ["spot2"], to: "soft" });
      expect(lock().heads).to.deep.equal({ spot: "hard", spot2: "soft" });
      await run("motion.freeze");
      const r = (await run("motion.unfreeze", { fixtures: ["spot2"] })) as Report;
      expect(r.heads).to.deep.equal({ spot: "hard" });
      expect(r.fixtures).to.deep.equal([{ id: "spot2", lock: "soft" }]); // the global soft lock still holds it
    });

    it("unfreezes a head marked absent after it was frozen", async () => {
      await run("motion.freeze", { fixtures: ["spot2"] });
      await run("venue.fixture.presence", { fixtures: ["spot2"], present: false });
      expect(plugin.runtime.movingHeads()).to.deep.equal(["spot"]);
      await run("motion.unfreeze", { fixtures: ["spot2"] });
      expect(lock().heads).to.deep.equal({});
    });

    it("toggle switches the global lock between free and the level given, and heads between free and locked", async () => {
      await run("motion.freeze", { toggle: true });
      expect(lock().level).to.equal("soft");
      await run("motion.freeze", { toggle: true, level: "hard" });
      expect(lock().level).to.equal("off");
      await run("motion.freeze", { toggle: true, fixtures: ["spot"] });
      expect(lock().heads).to.deep.equal({ spot: "soft" });
      // not all of them locked on their own: the toggle locks them all
      await run("motion.freeze", { toggle: true, fixtures: ["spot", "spot2"] });
      expect(lock().heads).to.deep.equal({ spot: "soft", spot2: "soft" });
      await run("motion.freeze", { toggle: true, fixtures: ["spot", "spot2"] });
      expect(lock().heads).to.deep.equal({});
    });

    it("puts the lock in `state`, with the strictest effective level, and sends it on every change", async () => {
      const states: { motionLock: { level: string; heads: object; effective: string } }[] = [];
      bus.subscribe((e: PluginEvent) => {
        if (e.type === "state") states.push(e.payload as (typeof states)[number]);
      });
      expect(plugin.state().motionLock).to.deep.equal({ level: "off", heads: {}, effective: "off" });
      await run("motion.freeze");
      await run("motion.freeze", { fixtures: ["spot2"], level: "hard" });
      expect(states.map((s) => s.motionLock)).to.deep.equal([
        { level: "soft", heads: {}, effective: "soft" },
        { level: "soft", heads: { spot2: "hard" }, effective: "hard" },
      ]);
    });
  });

  describe("rights (decisions Q2 + Q6)", () => {
    it("the Volunteer freezes soft, but neither hard, nor with the toggle, nor unfreezes", async () => {
      const volunteer = role("benevole");
      await run("motion.freeze", {}, volunteer);
      expect(lock().level).to.equal("soft");
      expect((await refusal(run("motion.freeze", { level: "hard" }, volunteer))).code).to.equal("forbidden");
      expect((await refusal(run("motion.freeze", { toggle: true }, volunteer))).message).to.match(/commands:position/);
      expect((await refusal(run("motion.unfreeze", {}, volunteer))).code).to.equal("forbidden");
      expect(lock().level).to.equal("soft");
    });

    it("the desk (commands:*) freezes hard, toggles and unfreezes; read-only freezes nothing", async () => {
      const desk = role("regisseur");
      await run("motion.freeze", { level: "hard" }, desk);
      await run("motion.unfreeze", {}, desk);
      await run("motion.freeze", { toggle: true }, desk);
      expect(lock().level).to.equal("soft");
      expect((await refusal(run("motion.freeze", {}, role("lecture")))).code).to.equal("forbidden");
    });

    it("whoever may aim the heads may freeze them (commands:position brings commands:freeze)", async () => {
      expect(rightMatches("commands:position", "commands:freeze")).to.equal(true);
      expect(rightMatches("commands:panic", "commands:freeze")).to.equal(false);
      await run("motion.freeze", { level: "hard" }, as(["commands:position"]));
      expect(lock().level).to.equal("hard");
    });
  });

  describe("under a hard lock", () => {
    it("position.set is refused for a frozen head, named, and nothing is remembered for the unfreeze", async () => {
      await run("motion.freeze", { fixtures: ["spot"], level: "hard" });
      const err = await refusal(run("position.set", { fixtures: ["spot"], pan: 0.9 }));
      expect(err.message).to.match(/Spot/);
      expect(err.detail).to.deep.equal({ refused: ["spot"] });
      expect(plugin.runtime.manualPosition("spot")).to.equal(undefined);
    });

    it("position.set on several heads moves the free ones and lists the frozen ones", async () => {
      await run("motion.freeze", { fixtures: ["spot"], level: "hard" });
      expect(await run("position.set", { pan: 0.9 })).to.deep.equal({ fixtures: ["spot2"], refused: ["spot"] });
      expect(plugin.runtime.manualPosition("spot2")?.pan).to.equal(0.9);
      expect(plugin.runtime.manualPosition("spot")).to.equal(undefined);
    });

    it("the soft lock leaves the pad free", async () => {
      await run("motion.freeze");
      expect(await run("position.set", { fixtures: ["spot"], pan: 0.9 })).to.deep.equal({ fixtures: ["spot"] });
    });

    it("position.aim, .home and .release leave a frozen head out, refused when it is the only one", async () => {
      await run("position.set", { pan: 0.3 });
      await run("motion.freeze", { fixtures: ["spot"], level: "hard" });
      expect((await refusal(run("position.aim", { fixtures: ["spot"], zone: "front" }))).detail).to.deep.equal({ refused: ["spot"] });
      const aimed = (await run("position.aim", { zone: "front" })) as { results: { fixture: string }[]; refused: string[] };
      expect(aimed.results.map((x) => x.fixture)).to.deep.equal(["spot2"]);
      expect(aimed.refused).to.deep.equal(["spot"]);
      await refusal(run("position.home", { fixtures: ["spot"] }));
      await refusal(run("position.release", { group: "left" }));
      // the manual position under the hard lock is still there: unfrozen, the head goes back to it, not elsewhere
      expect(plugin.runtime.manualPosition("spot")?.pan).to.equal(0.3);
      expect(await run("position.release")).to.deep.equal({ released: ["spot2"], refused: ["spot"] });
      expect(plugin.runtime.manualPosition("spot")?.pan).to.equal(0.3);
      const homed = (await run("position.home")) as { fixtures: { fixture: string }[]; refused: string[] };
      expect(homed.fixtures.map((x) => x.fixture)).to.deep.equal(["spot2"]);
      expect(homed.refused).to.deep.equal(["spot"]);
    });

    it("a global hard lock refuses a release of every head", async () => {
      await run("motion.freeze", { level: "hard" });
      expect((await refusal(run("position.release"))).detail).to.deep.equal({ refused: ["spot", "spot2"] });
    });

    it("calibration.record (right show:write) checks the lock itself: refused hard, read in soft", async () => {
      await run("position.set", { fixtures: ["spot"], pan: 0.4, tilt: 0.6 });
      during(200);
      await run("motion.freeze", { fixtures: ["spot"] });
      expect(await run("calibration.record", { fixture: "spot", point: { x: 0, y: 0, z: 0 } })).to.deep.include({ fixture: "spot", samples: 1 });
      await run("motion.freeze", { fixtures: ["spot"], level: "hard" });
      const err = await refusal(run("calibration.record", { fixture: "spot", point: { x: 0, y: 0, z: 0 } }));
      expect(err.message).to.match(/Spot.*(figée|frozen)/);
    });
  });
});

describe("the commands:freeze right on stored roles (T26 migration)", () => {
  const store = async (auth: unknown) => {
    const dir = mkdtempSync(join(tmpdir(), "light-freeze-roles-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ version: 1, server: { authToken: "master", auth }, plugins: {} }));
    const s = new ConfigStore({ filePath: join(dir, "config.json") });
    await s.load();
    return s;
  };
  const rightsOf = (auth: AuthService, id: string) => auth.roles().find((r) => r.id === id)?.rights;

  it("the built-in Volunteer has it", () => {
    expect(DEFAULT_ROLES.find((r) => r.id === "benevole")?.rights).to.include("commands:freeze");
  });

  it("gives it to every stored role that has the Panic, and to no other", async () => {
    const roles = [
      { id: "admin", name: "Admin", rights: ["*"] },
      { id: "benevole", name: "Bénévole", rights: ["commands:trigger", "commands:panic", "commands:blackout", "dashboards:view"] },
      { id: "accueil", name: "Accueil", rights: ["commands:panic"] },
      { id: "son", name: "Son", rights: ["commands:tempo"] },
    ];
    const auth = new AuthService("master", await store({ roles }));
    expect(rightsOf(auth, "benevole")).to.include("commands:freeze");
    expect(rightsOf(auth, "accueil")).to.deep.equal(["commands:panic", "commands:freeze"]);
    expect(rightsOf(auth, "son")).to.deep.equal(["commands:tempo"]);
  });

  it("runs once: a right removed after the migration stays removed", async () => {
    const config = await store({ roles: [{ id: "admin", name: "Admin", rights: ["*"] }, { id: "accueil", name: "Accueil", rights: ["commands:panic"] }] });
    const first = new AuthService("master", config);
    await first.updateRole("accueil", { rights: ["commands:panic"] });
    const again = new AuthService("master", config);
    expect(rightsOf(again, "accueil")).to.deep.equal(["commands:panic"]);
  });
});
