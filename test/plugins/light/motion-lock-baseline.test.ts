import { expect } from "chai";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";

/**
 * « Figer les lyres » (T26) changes nothing while nothing is locked: a long scenario without a lock (looks that move,
 * the pad, raw pan/tilt, a channel fader on pan, the DMX console, a speed rule, a snapshot, Panic and its undo, a
 * recall, a cut `moveFade`, Blackout, a restart) sends, frame by frame, the whole universe it sent before the lock
 * existed. Differential test against a baseline captured on the commit before T26 (`test/fixtures/motion-lock-baseline.json`,
 * one digest per second of frames; regenerate on purpose only, with UPDATE_MOTION_LOCK_BASELINE=1).
 */
const BASELINE = fileURLToPath(new URL("../../fixtures/motion-lock-baseline.json", import.meta.url));
const FRAMES_PER_DIGEST = 50;

describe("motion lock: nothing changes without a lock (differential)", () => {
  let plugin: LightPlugin;
  let dataRoot: string;
  let now = 0;
  const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
  const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
  const start = () => {
    plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null, now: () => now });
  };
  const digests: string[] = [];
  let hash = createHash("sha256");
  let count = 0;
  /** Engine frames, 20 ms apart, universe 1 hashed. */
  const during = (ms: number) => {
    for (let i = 0; i < Math.round(ms / 20); i++) {
      (plugin.engine as unknown as { frame(now: number): void }).frame(now);
      now += 20;
      hash.update(plugin.engine.output.buffers[0]!);
      if (++count === FRAMES_PER_DIGEST) {
        digests.push(hash.digest("hex").slice(0, 16));
        hash = createHash("sha256");
        count = 0;
      }
    }
  };

  before(() => {
    dataRoot = join(mkdtempSync(join(tmpdir(), "light-motion-lock-base-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    copyFileSync(new URL("../../fixtures/spot.qxf", import.meta.url), join(dataRoot, "fixtures", "spot.qxf"));
    start();
    plugin.venue.fixtures.put({ id: "spot", name: "Spot", manufacturer: "Test", model: "Spot 7", mode: "Standard", universe: 1, address: 1, position: { x: -1, y: 2, z: 5 }, mount: "hung" });
    plugin.venue.fixtures.put({ id: "spot2", name: "Spot 2", manufacturer: "Test", model: "Spot 7", mode: "Standard", universe: 1, address: 11, position: { x: 1, y: 2, z: 5 }, mount: "hung" });
    plugin.venue.canvases.put({ id: "lyres", name: "Lyres", topology: "line", cells: 2, render: [{ from: 0, to: 0, targets: [{ fixture: "spot", head: -1 }] }, { from: 1, to: 1, targets: [{ fixture: "spot2", head: -1 }] }] });
    const look = (id: string, more: object) => plugin.runtime.looks.put({ id, name: id, canvas: "lyres", technique: { kind: "plat", color: "#ff0000" }, ...more } as never);
    look("circle", { move: { shape: "cercle", center: { pan: 0.5, tilt: 0.5 }, size: { pan: 0.2, tilt: 0.2 }, every: { seconds: 2 }, spread: 0 } });
    look("low", { move: { shape: "fixe", center: { pan: 0.2, tilt: 0.8 } } });
    look("raw", { channels: { targets: [{ fixture: "spot", offset: 0 }], steps: [[240]] } });
  });
  after(async () => {
    await plugin.stop();
  });

  it("sends what it sent before T26, frame by frame, and writes no lock into show.json", async () => {
    during(200);
    await run("look.go", { id: "circle" });
    during(1500);
    plugin.runtime.setPosition(["spot"], { pan: 0.9, tilt: 0.1 });
    during(500);
    await run("look.go", { id: "low" });
    during(700);
    plugin.runtime.releasePositions();
    during(1500);
    await run("look.go", { id: "raw" });
    during(500);
    await run("fader.put", { fader: { id: "panfader", name: "Pan", channels: [{ fixture: "spot2", offset: 0 }], level: 0.5 } });
    during(300);
    await run("dmx.set", { universe: 1, values: { "1": 200, "3": 20 } });
    during(300);
    await run("dmx.release", { universe: 1 });
    during(300);
    await run("rule.put", { where: "show", rule: { id: "lent", name: "Lent", level: "show", scope: { fixture: "spot" }, target: {}, maxDegPerSecond: 20 } });
    await run("look.stop", { id: "low" });
    during(1500);
    await run("snapshot.save", { name: "S" });
    await run("panic");
    during(1500);
    await run("panic.undo");
    during(1500);
    await run("snapshot.recall", { id: "s" });
    during(1000);
    await run("show.settings.set", { moveFade: { seconds: 0 } });
    await run("look.go", { id: "low" });
    during(500);
    await run("blackout", { on: true });
    during(300);
    await plugin.stop();
    start();
    during(500);
    digests.push(hash.digest("hex").slice(0, 16));

    if (process.env.UPDATE_MOTION_LOCK_BASELINE === "1") writeFileSync(BASELINE, `${JSON.stringify({ framesPerDigest: FRAMES_PER_DIGEST, digests }, null, 1)}\n`);
    if (!existsSync(BASELINE)) throw new Error("missing baseline: test/fixtures/motion-lock-baseline.json");
    const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as { digests: string[] };
    const firstDiff = digests.findIndex((d, i) => d !== baseline.digests[i]);
    expect(firstDiff, `first second that differs: ${firstDiff}`).to.equal(-1);
    expect(digests).to.have.length(baseline.digests.length);
    expect(readFileSync(join(dataRoot, "shows", "default", "show.json"), "utf8")).to.not.include("motionLock");
  });
});
