import { expect } from "chai";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FolderStore } from "../../../src/plugins/light/data/store.js";
import { Venue } from "../../../src/plugins/light/venue/venue.js";
import { ShowRuntime } from "../../../src/plugins/light/show/runtime.js";

/**
 * The motion layer (T25, lot 2) only speaks for the pan/tilt bytes of the moving heads: every other byte of the
 * output — the fixtures without pan/tilt, and the light, wheel and shutter of the moving heads themselves — is what
 * it was before the layer, frame by frame. Differential test against a baseline captured on the commit before the
 * integration (`test/fixtures/motion-baseline.json`, one digest per second of frames; regenerate on purpose only,
 * with UPDATE_MOTION_BASELINE=1).
 */
const BASELINE = fileURLToPath(new URL("../../fixtures/motion-baseline.json", import.meta.url));
/** Pan/tilt slots (0-based) of the three moving heads: the only bytes left out. */
const MOTION_SLOTS = [59, 60, 61, 62, 69, 70, 79, 80];
const FRAMES_PER_DIGEST = 50;

type Event = [ms: number, op: "go" | "stop" | "manual" | "release" | "check", arg: string];

function play(): string[] {
  const dir = mkdtempSync(join(tmpdir(), "light-motion-base-"));
  const defs = join(dir, "fixtures");
  mkdirSync(defs);
  for (const f of ["bar4.qxf", "par-rgb.qxf", "machine.qxf", "spot.qxf", "wheel-spot.qxf"]) copyFileSync(new URL(`../../fixtures/${f}`, import.meta.url), join(defs, f));
  const venue = new Venue(new FolderStore(join(dir, "venue")), [defs]);
  const patch = { manufacturer: "Test", universe: 1 };
  venue.fixtures.put({ ...patch, id: "par", name: "Par", model: "Par RGB", mode: "3 Channel", address: 1 });
  venue.fixtures.put({ ...patch, id: "bar", name: "Bar", model: "Bar 4", mode: "15 Channel", address: 10 });
  venue.fixtures.put({ ...patch, id: "bar-t", name: "Bar with tracks", model: "Bar 4", mode: "15 Channel", address: 30, overrides: { tracks: { enabled: true, fade: ["Dimmer", "R1", "G1", "B1", "R2", "G2", "B2"] } } });
  venue.fixtures.put({ ...patch, id: "machine", name: "Machine", model: "Machine 1", mode: "1 Channel", address: 50 });
  venue.fixtures.put({ ...patch, id: "spot16", name: "Spot 16", model: "Spot 7", mode: "Standard", address: 60, position: { x: -2, y: 2, z: 5 }, mount: "hung" });
  venue.fixtures.put({ ...patch, id: "spot8", name: "Spot 8", model: "Spot 7", mode: "Basic", address: 70, position: { x: 2, y: 2, z: 5 }, mount: "hung", orientation: { yaw: 0, invertPan: true, invertTilt: true, swapPanTilt: true, panOffset: 0, tiltOffset: 0 } });
  venue.fixtures.put({ ...patch, id: "wspot", name: "Wheel spot", model: "Wheel Spot", mode: "Standard", address: 80, position: { x: 0, y: 2, z: 5 }, mount: "hung" });
  venue.fixtures.put({ ...patch, id: "nodef", name: "No definition", model: "Unknown", mode: "x", address: 90 });
  venue.canvases.put({ id: "wash", name: "Wash", topology: "line", cells: 3, render: [{ from: 0, to: 0, targets: [{ fixture: "par" }] }, { from: 1, to: 1, targets: [{ fixture: "bar" }] }, { from: 2, to: 2, targets: [{ fixture: "bar-t" }] }] });
  venue.canvases.put({ id: "lyres", name: "Lyres", topology: "line", cells: 3, render: [{ from: 0, to: 0, targets: [{ fixture: "spot16" }] }, { from: 1, to: 1, targets: [{ fixture: "spot8" }] }, { from: 2, to: 2, targets: [{ fixture: "wspot" }] }] });
  let beats = 0;
  let now = 0;
  const show = new ShowRuntime(new FolderStore(join(dir, "show")), venue, { state: () => ({ beats }) }, () => now);
  const look = (id: string, canvas: string, technique: unknown, fades: [number, number], more: object = {}) =>
    show.looks.put({ id, name: id, canvas, technique, timing: { entryFade: fades[0], exitFade: fades[1] }, ...more } as never);
  look("red", "wash", { kind: "plat", color: "#ff0000" }, [1, 1]);
  look("blue", "wash", { kind: "plat", color: "#0000ff" }, [0.5, 2]);
  look("white", "lyres", { kind: "plat", color: "#ffffff" }, [1, 1], { move: { shape: "cercle", size: { pan: 0.2, tilt: 0.1 }, every: { beats: 2 } } });
  look("green", "lyres", { kind: "plat", color: "#00ff00" }, [2, 0.5]);
  look("sweep", "lyres", { kind: "aucune" }, [0, 0], { move: { shape: "pan", size: { pan: 0.3 }, spread: 1 } });
  look("scene", "wash", { kind: "aucune" }, [1, 2], {
    channels: {
      targets: [
        { fixture: "bar", offset: 1 },
        { fixture: "bar", offset: 2 },
        { fixture: "bar-t", offset: 2 },
        { fixture: "machine", offset: 0 },
        { fixture: "spot16", offset: 0 },
        { fixture: "spot16", offset: 2 },
        { fixture: "spot16", offset: 5 },
        { fixture: "nodef", offset: 0 },
        { fixture: "nodef", offset: 1 },
      ],
      steps: [[40, 120, 60, 200, 30, 220, 180, 11, 22]],
    },
  });
  // a scene that only places heads: pan/tilt and nothing else, with fades
  look("place", "wash", { kind: "aucune" }, [2, 2], {
    channels: {
      targets: [
        { fixture: "spot8", offset: 0 },
        { fixture: "spot8", offset: 1 },
        { fixture: "wspot", offset: 0 },
        { fixture: "wspot", offset: 1 },
        { fixture: "spot16", offset: 2 },
      ],
      steps: [[10, 240, 200, 20, 90]],
    },
  });
  show.groups.put({ id: "ex-wash", name: "Wash", exclusive: true, members: { looks: ["red", "blue"] } });
  show.groups.put({ id: "ex-lyres", name: "Lyres", exclusive: true, members: { looks: ["white", "green"] } });
  show.groups.put({ id: "dca", name: "DCA", members: { fixtures: ["bar", "spot16"] }, master: { level: 0.7 } });
  show.faders.put({ id: "f", name: "F", channels: [{ fixture: "par", offset: 2 }], level: 0.4 });
  const events: Event[] = [
    [200, "go", "red"],
    [600, "go", "white"],
    [1500, "go", "scene"],
    [2200, "go", "blue"],
    [2600, "manual", "spot16"],
    [3000, "go", "place"],
    [3400, "go", "green"],
    [3700, "check", "sweep"],
    [3800, "go", "sweep"],
    [4500, "release", ""],
    [5000, "stop", "scene"],
    [5400, "go", "white"],
    [5800, "stop", "place"],
    [6000, "go", "red"],
    [6300, "manual", "spot8"],
    [7000, "stop", "sweep"],
    [7400, "stop", "white"],
    [8000, "release", ""],
    [8200, "go", "place"],
    [8600, "stop", "red"],
    [9000, "stop", "place"],
  ];
  const digests: string[] = [];
  let hash = createHash("sha256");
  let count = 0;
  let e = 0;
  for (let ms = 0; ms <= 13_000; ms += 20) {
    for (; e < events.length && events[e]![0] <= ms; e++) {
      const [, op, arg] = events[e]!;
      if (op === "go") show.go(arg);
      else if (op === "stop") show.stop(arg);
      else if (op === "manual") show.setPosition([arg], { pan: 0.2, tilt: 0.8 });
      else if (op === "release") show.releasePositions();
      else show.strictBounds(arg);
    }
    const b = new Uint8Array(512);
    show.render([b]);
    for (const i of MOTION_SLOTS) b[i] = 0;
    hash.update(b.subarray(0, 128));
    if (++count === FRAMES_PER_DIGEST) {
      digests.push(hash.digest("hex").slice(0, 16));
      hash = createHash("sha256");
      count = 0;
    }
    now += 20;
    beats += 0.04;
  }
  digests.push(hash.digest("hex").slice(0, 16));
  return digests;
}

describe("motion layer: bytes outside pan/tilt (differential)", () => {
  it("sends what it sent before the layer on every channel that is not a moving head's pan or tilt", () => {
    const digests = play();
    if (process.env.UPDATE_MOTION_BASELINE === "1" || !existsSync(BASELINE)) {
      if (process.env.UPDATE_MOTION_BASELINE !== "1") throw new Error("missing baseline: test/fixtures/motion-baseline.json");
      writeFileSync(BASELINE, `${JSON.stringify({ framesPerDigest: FRAMES_PER_DIGEST, digests }, null, 1)}\n`);
    }
    const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as { digests: string[] };
    const firstDiff = digests.findIndex((d, i) => d !== baseline.digests[i]);
    expect(firstDiff, `first second that differs: ${firstDiff}`).to.equal(-1);
    expect(digests).to.have.length(baseline.digests.length);
  });
});
