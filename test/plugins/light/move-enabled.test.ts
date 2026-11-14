import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";
import type { HeadMotionEntry } from "../../../src/plugins/light/show/motion-report.js";

/**
 * « Ne pas bouger les lyres » (T26, `move.enabled: false`; docs/specs/engine-effects-timing.md, « Couche Mouvement »):
 * the look keeps its move settings but claims no head, neither by its move nor by raw pan/tilt steps; its colours play
 * on. One engine frame every 20 ms, time injected; no output route.
 */
const SPOT = 0;

describe("look move disabled (T26, move.enabled)", () => {
  let plugin: LightPlugin;
  let now = 0;
  const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
  const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
  const frame = (): Uint8Array => {
    (plugin.engine as unknown as { frame(now: number): void }).frame(now);
    now += 20;
    return Uint8Array.from(plugin.engine.output.buffers[0]!);
  };
  const during = (ms: number): Uint8Array[] => Array.from({ length: Math.round(ms / 20) }, frame);
  const posBytes = (b: Uint8Array) => [...b.slice(SPOT, SPOT + 4)];
  const listed = async () => ((await run("position.list")) as HeadMotionEntry[]).find((h) => h.id === "spot")!;
  const circle = { shape: "cercle", center: { pan: 0.5, tilt: 0.5 }, size: { pan: 0.2, tilt: 0.2 }, every: { seconds: 2 } };

  beforeEach(() => {
    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-move-enabled-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    copyFileSync(new URL("../../fixtures/spot.qxf", import.meta.url), join(dataRoot, "fixtures", "spot.qxf"));
    now = 0;
    plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null, now: () => now });
    plugin.venue.fixtures.put({ id: "spot", name: "Spot", manufacturer: "Test", model: "Spot 7", mode: "Standard", universe: 1, address: 1, position: { x: 0, y: 2, z: 5 }, mount: "hung" });
    plugin.venue.canvases.put({ id: "lyres", name: "Lyres", topology: "line", cells: 1, render: [{ from: 0, to: 0, targets: [{ fixture: "spot", head: -1 }] }] });
    const look = (id: string, more: object) => plugin.runtime.looks.put({ id, name: id, canvas: "lyres", technique: { kind: "plat", color: "#ff0000" }, ...more } as never);
    look("circle-off", { move: { ...circle, enabled: false } });
    look("raw-off", { move: { shape: "fixe", enabled: false }, channels: { targets: [{ fixture: "spot", offset: 0 }], steps: [[240]] } });
    look("circle-on", { move: { ...circle, enabled: true } });
  });
  afterEach(async () => {
    await plugin.stop();
  });

  it("claims no head with move.enabled false: the head stays still while the colours play, and keeps the settings", async () => {
    const before = during(200).at(-1)!;
    await run("look.go", { id: "circle-off" });
    for (const f of during(3000)) {
      expect(posBytes(f)).to.deep.equal(posBytes(before));
      expect(f[SPOT + 5]).to.equal(255); // the dimmer: the look still lights the head
    }
    const motion = (await listed()).motion!;
    expect(motion.pan.layer).to.equal("rest");
    expect(motion.masked).to.deep.equal([]);
    const saved = (await run("look.get", { id: "circle-off" })) as { move: { shape: string; enabled: boolean } };
    expect(saved.move).to.include({ shape: "cercle", enabled: false });
    const brief = (await run("look.list")) as { id: string; move?: { shape: string; enabled?: boolean } }[];
    expect(brief.find((l) => l.id === "circle-off")!.move).to.deep.equal({ shape: "cercle", enabled: false });
    expect(brief.find((l) => l.id === "circle-on")!.move).to.deep.equal({ shape: "cercle" });
  });

  it("leaves raw pan/tilt steps unclaimed too", async () => {
    const before = during(200).at(-1)!;
    await run("look.go", { id: "raw-off" });
    for (const f of during(1500)) expect(posBytes(f)).to.deep.equal(posBytes(before));
  });

  it("a look with move.enabled true still moves the head", async () => {
    during(200);
    await run("look.go", { id: "circle-on" });
    const frames = during(3000);
    expect(new Set(frames.map((f) => posBytes(f).join(","))).size).to.be.greaterThan(10);
    expect((await listed()).motion!.pan.layer).to.equal("look");
  });
});
