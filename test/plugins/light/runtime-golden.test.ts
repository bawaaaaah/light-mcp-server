import { expect } from "chai";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FolderStore } from "../../../src/plugins/light/data/store.js";
import { PositionPresetSchema } from "../../../src/plugins/light/show/model.js";
import { ShowRuntime } from "../../../src/plugins/light/show/runtime.js";
import { ZoneSchema } from "../../../src/plugins/light/venue/stage.js";
import { Venue } from "../../../src/plugins/light/venue/venue.js";

/**
 * Golden output of the show runtime (T48, the split of ShowRuntime): every byte of both universes, frame by frame
 * (20 ms of injected time each, render then guard as the engine does), over a scenario that goes through every layer —
 * looks with entry/exit fades and crossfades, moves, a path look over zones, raw channels with pan/tilt, a fixture with
 * tracks, colour wheels, a manual position (direct and gliding), a named position recalled, a target engaged and moved,
 * a soft then a hard motion lock, a manual colour with its fade, DCA and grand master with smoothing, a channel fader,
 * a reject rule (strictBounds and the mask), a Panic and its undo, the releases. Captured on the commit before the
 * split (`test/fixtures/runtime-golden.json`, one digest per frame); regenerate on purpose only, with
 * UPDATE_RUNTIME_GOLDEN=1.
 */
const GOLDEN = fileURLToPath(new URL("../../fixtures/runtime-golden.json", import.meta.url));
const FRAME_MS = 20;
const END_MS = 13_000;

function play(): { frames: string[]; extra: string } {
  const dir = mkdtempSync(join(tmpdir(), "light-runtime-golden-"));
  const defs = join(dir, "fixtures");
  mkdirSync(defs);
  for (const f of ["bar4.qxf", "par-rgb.qxf", "spot.qxf", "wheel-spot.qxf"]) copyFileSync(new URL(`../../fixtures/${f}`, import.meta.url), join(defs, f));
  const venue = new Venue(new FolderStore(join(dir, "venue")), [defs]);
  const t = { manufacturer: "Test" };
  venue.fixtures.put({ ...t, id: "spot16", name: "Spot 16", model: "Spot 7", mode: "Standard", universe: 1, address: 1, position: { x: -2, y: 2, z: 5 }, mount: "hung" });
  venue.fixtures.put({ ...t, id: "par", name: "Par", model: "Par RGB", mode: "3 Channel", universe: 1, address: 21 });
  venue.fixtures.put({ ...t, id: "bar-t", name: "Bar with tracks", model: "Bar 4", mode: "15 Channel", universe: 1, address: 30, overrides: { tracks: { enabled: true, fade: ["Dimmer", "R1", "G1", "B1", "R2", "G2", "B2"] } } });
  venue.fixtures.put({ ...t, id: "wspot", name: "Wheel spot", model: "Wheel Spot", mode: "Standard", universe: 1, address: 60, position: { x: 0, y: 2, z: 5 }, mount: "hung" });
  venue.fixtures.put({ ...t, id: "spot8", name: "Spot 8", model: "Spot 7", mode: "Basic", universe: 2, address: 1, position: { x: 2, y: 2, z: 5 }, mount: "hung", orientation: { yaw: 0, invertPan: true, invertTilt: false, swapPanTilt: true, panOffset: 0, tiltOffset: 0 } });
  venue.fixtures.put({ ...t, id: "bar", name: "Bar", model: "Bar 4", mode: "15 Channel", universe: 2, address: 20 });
  venue.canvases.put({ id: "wash", name: "Wash", topology: "line", cells: 3, render: [{ from: 0, to: 0, targets: [{ fixture: "par" }] }, { from: 1, to: 1, targets: [{ fixture: "bar" }] }, { from: 2, to: 2, targets: [{ fixture: "bar-t" }] }] });
  venue.canvases.put({ id: "lyres", name: "Lyres", topology: "line", cells: 3, render: [{ from: 0, to: 0, targets: [{ fixture: "spot16" }] }, { from: 1, to: 1, targets: [{ fixture: "spot8" }] }, { from: 2, to: 2, targets: [{ fixture: "wspot" }] }] });
  const clock = { now: 0, beats: 0, bpm: 120 };
  const show = new ShowRuntime(new FolderStore(join(dir, "show")), venue, { state: () => ({ beats: clock.beats, bpm: clock.bpm }) }, () => clock.now);
  for (const z of [
    ZoneSchema.parse({ id: "jardin", name: "Gauche", polygon: [[-3, 3], [-2, 3], [-2, 4], [-3, 4]], aim: { height: 1 } }),
    ZoneSchema.parse({ id: "cour", name: "Droite", polygon: [[2, 3], [3, 3], [3, 4], [2, 4]], aim: {} }),
    ZoneSchema.parse({ id: "fond", name: "Fond", polygon: [[-0.5, 5], [0.5, 5], [0.5, 6], [-0.5, 6]] }),
  ])
    show.zones.put(z);
  const look = (id: string, canvas: string, technique: unknown, fades: [number, number], more: object = {}) =>
    show.looks.put({ id, name: id, canvas, technique, timing: { entryFade: fades[0], exitFade: fades[1] }, ...more } as never);
  look("red", "wash", { kind: "plat", color: "#ff0000" }, [1, 1]);
  look("blue", "wash", { kind: "respiration", colors: ["#0000ff", "#ffffff"] }, [0.5, 2]);
  look("circle", "lyres", { kind: "plat", color: "#ffffff" }, [1, 1], { move: { shape: "cercle", size: { pan: 0.2, tilt: 0.1 }, every: { beats: 2 } } });
  look("tour", "lyres", { kind: "plat", color: "#ff8000" }, [0.6, 0.8], {
    move: { shape: "fixe", every: { seconds: 1 }, fade: { seconds: 0.2 }, at: { path: { stops: [{ zone: "jardin" }, { zone: "cour" }, { zone: "fond" }] } } },
  });
  look("follow", "lyres", { kind: "aucune" }, [0, 0], { move: { shape: "huit", size: { pan: 0.1, tilt: 0.05 }, every: { seconds: 2 }, at: { target: "tg" } } });
  look("scene", "wash", { kind: "aucune" }, [1, 2], {
    channels: {
      targets: [
        { fixture: "bar", offset: 1 },
        { fixture: "bar-t", offset: 2 },
        { fixture: "spot16", offset: 0 },
        { fixture: "spot16", offset: 2 },
        { fixture: "spot16", offset: 5 },
      ],
      steps: [
        [40, 60, 30, 220, 180],
        [90, 10, 60, 200, 120],
      ],
    },
  });
  look("safe", "wash", { kind: "plat", color: "#202020" }, [0.5, 0.5]);
  show.groups.put({ id: "ex-wash", name: "Wash", exclusive: true, members: { looks: ["red", "blue"] } });
  show.groups.put({ id: "ex-lyres", name: "Lyres", exclusive: true, members: { looks: ["circle", "tour"] } });
  show.groups.put({ id: "dca", name: "DCA", members: { fixtures: ["bar", "spot16", "par"] }, master: { level: 0.8, smoothing: { curve: "ease", msPerStep: 3 } } });
  show.faders.put({ id: "f", name: "F", channels: [{ fixture: "par", offset: 2 }], level: 0.4 });
  show.rules.put({ id: "wheel-max", name: "Wheel max", level: "show", scope: { fixture: "spot16" }, target: { channel: "Color Wheel" }, max: 50, onViolation: "reject" } as never);
  show.targets.put({ id: "tg", name: "Cible", fixtures: ["wspot", "spot16"], point: { x: 0, y: 3, z: 1 }, smoothing: { curve: "linear", msPerStep: 2 } } as never);
  show.positionPresets.put(PositionPresetSchema.parse({ id: "pp", name: "Position A", values: { wspot: { pan: 0.3, tilt: 0.7 }, spot8: { pan: 0.6, tilt: 0.4 } } }));
  show.saveSettings({ restPositions: { spot16: { pan: 0.4, tilt: 0.6 } }, moveFade: { seconds: 0.8 } });

  const extra = createHash("sha256");
  const note = (label: string, value: unknown) => extra.update(`${label}:${JSON.stringify(value)}\n`);
  let undo: ReturnType<ShowRuntime["takeBeforePanic"]>;
  const events: [number, string, () => unknown][] = [
    [100, "go red", () => show.go("red")],
    [300, "go circle", () => show.go("circle")],
    [700, "dca", () => show.groups.putLive({ ...show.groups.get("dca")!, master: { level: 0.3, mute: false, smoothing: { curve: "ease", msPerStep: 3 } } })],
    [1200, "go blue", () => show.go("blue")],
    [1500, "colour", () => show.setColour(["par", "bar"], "#00ff00", 800)],
    [1800, "strict tour", () => show.strictBounds("tour").map((b) => [b.rule.id, b.clamps])],
    [2000, "go tour", () => show.go("tour")],
    [2300, "go scene", () => show.go("scene")],
    [2600, "manual glide", () => show.setPosition(["spot8"], { pan: 0.2, tilt: 0.7 }, "glide")],
    [2900, "manual pan", () => show.setPosition(["spot8"], { pan: 0.35 })],
    [3000, "engage", () => show.engageTarget("tg", true, 1000)],
    [3300, "go follow", () => show.go("follow")],
    [3500, "move target", () => show.moveTarget("tg", { x: 1.5, z: 1.8 }).point],
    [3900, "recall", () => show.recallPreset("pp", ["wspot"])],
    [4000, "soft lock", () => show.setMotionLock({ level: "off", heads: { spot8: "soft" } })],
    [4200, "pad soft", () => show.setPosition(["spot8"], { pan: 0.55, tilt: 0.25 })],
    [4500, "hard lock", () => show.setMotionLock({ level: "off", heads: { spot8: "soft", spot16: "hard" } })],
    [4700, "aim", () => show.aim(["wspot"], { x: 2.5, y: 3.5, z: 0 })],
    [5000, "gm", () => show.saveSettings({ grandMaster: 0.5, grandMasterSmoothing: { curve: "ease", msPerStep: 2 } })],
    [5300, "fader", () => show.faders.putLive({ ...show.faders.get("f")!, level: 0.9 })],
    [5600, "colour 2", () => show.setColour(["bar-t"], "#ff00ff", 400)],
    [
      6000,
      "panic",
      () => {
        show.rememberBeforePanic(false);
        show.cancelResets();
        show.holdPositions();
        show.disengageTargets();
        const stopped = show.stopAll();
        const colours = show.clearColours();
        const released = show.releasePositions();
        show.go("safe");
        show.notePanicDone(false);
        return { stopped, colours, released };
      },
    ],
    [6800, "release hold", () => show.releaseHold(["wspot"])],
    [
      7500,
      "undo",
      () => {
        undo = show.takeBeforePanic();
        const { colours, ...snap } = undo!;
        const done = show.applySnapshot(snap, "exact");
        return { done, colours: show.restoreColours(colours) };
      },
    ],
    [8500, "release top", () => show.releaseTop()],
    [9000, "home spot8", () => show.homePositions(["spot8"])],
    [9300, "release colours", () => show.releaseColours(undefined, 600)],
    [9600, "stop tour", () => show.stop("tour")],
    [10000, "unlock", () => show.setMotionLock({ level: "off", heads: {} })],
    [10400, "disengage", () => show.engageTarget("tg", false).engaged],
    [10800, "stop all", () => show.stopAll()],
  ];
  const frames: string[] = [];
  let e = 0;
  for (let ms = 0; ms <= END_MS; ms += FRAME_MS) {
    for (; e < events.length && events[e]![0] <= ms; e++) {
      const [, label, run] = events[e]!;
      note(label, run() ?? null);
    }
    const buffers = [new Uint8Array(512), new Uint8Array(512)];
    show.render(buffers);
    show.guard(buffers);
    const h = createHash("sha256");
    for (const b of buffers) h.update(b);
    frames.push(h.digest("hex").slice(0, 16));
    note("errors", show.lastErrors);
    clock.now += FRAME_MS;
    clock.beats += (FRAME_MS / 1000) * (clock.bpm / 60);
  }
  return { frames, extra: extra.digest("hex").slice(0, 16) };
}

describe("show runtime: golden output (T48)", () => {
  it("sends the same bytes on both universes, frame by frame, as before the split", () => {
    const got = play();
    if (process.env.UPDATE_RUNTIME_GOLDEN === "1" || !existsSync(GOLDEN)) {
      if (process.env.UPDATE_RUNTIME_GOLDEN !== "1") throw new Error("missing golden: test/fixtures/runtime-golden.json");
      writeFileSync(GOLDEN, `${JSON.stringify({ frameMs: FRAME_MS, extra: got.extra, frames: got.frames }, null, 1)}\n`);
    }
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as { extra: string; frames: string[] };
    const firstDiff = got.frames.findIndex((d, i) => d !== golden.frames[i]);
    expect(firstDiff, `first frame that differs: ${firstDiff} (${firstDiff * FRAME_MS} ms)`).to.equal(-1);
    expect(got.frames).to.have.length(golden.frames.length);
    expect(got.extra, "command results and render errors").to.equal(golden.extra);
  });

  it("is deterministic: two runs give the same frames", () => {
    expect(play()).to.deep.equal(play());
  });
});
