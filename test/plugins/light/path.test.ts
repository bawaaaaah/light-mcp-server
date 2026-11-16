import { expect } from "chai";
import { MoveSchema } from "../../../src/plugins/light/engine/move.js";
import { mixSeed, pathPosition, pathSequence, pathStep, PathSchema, stopOffset, travelPairs, type Path } from "../../../src/plugins/light/engine/path.js";
import { checkPath, num, tripSamples, type PathHead } from "../../../src/plugins/light/venue/path-check.js";
import { inLang } from "../../../src/core/lang.js";
import { aimAt, type AimSetup } from "../../../src/plugins/light/venue/aim.js";
import { ZoneSchema } from "../../../src/plugins/light/venue/stage.js";

/**
 * The path of a look's move (T28; docs/specs/engine-effects-timing.md, « Parcours »), pure: the order of its stops (loop,
 * ping-pong, random, weighted, deterministic), the heads together, one behind the other or each on its own draw, the
 * travel with its cosine ease, and the checks said ahead (stops out of reach, speed per axis, no-aim zones crossed).
 */
const path = (more: object = {}): Path => PathSchema.parse({ stops: [{ zone: "a" }, { zone: "b" }, { zone: "c" }], ...more });
/** The stop each step rests on, over `n` steps. */
const visits = (p: Path, n: number, seed = 7, index = 0, offset = 0): number[] => {
  const seq = pathSequence(p, seed, index);
  return Array.from({ length: n }, (_, k) => pathStep(p, seq, k + 0.99, offset).to);
};

describe("path of a move (T28)", () => {
  it("validates its stops: exactly one destination, a height for a zone only, 1 to 32 stops", () => {
    expect(PathSchema.safeParse({ stops: [{ zone: "a", point: { x: 0, y: 0, z: 0 } }] }).success).to.equal(false);
    expect(PathSchema.safeParse({ stops: [{}] }).success).to.equal(false);
    expect(PathSchema.safeParse({ stops: [{ point: { x: 0, y: 0, z: 0 }, height: 1 }] }).success).to.equal(false);
    expect(PathSchema.safeParse({ stops: [{ zone: "a", height: 1 }] }).success).to.equal(true);
    expect(PathSchema.safeParse({ stops: [] }).success).to.equal(false);
    expect(PathSchema.safeParse({ stops: Array.from({ length: 33 }, () => ({ zone: "a" })) }).success).to.equal(false);
    const p = PathSchema.parse({ stops: [{ target: "t" }] });
    expect([p.order, p.travel, p.heads]).to.deep.equal(["loop", 0.5, "ensemble"]);
  });

  it("is a base of the move: a version that does not know `at.path` strips it, the look keeps its shape", () => {
    const m = MoveSchema.parse({ at: { path: { stops: [{ zone: "a" }] } } });
    expect(m.at?.path?.stops).to.have.length(1);
    expect(MoveSchema.parse({ at: { somethingNew: 1 } }).at).to.deep.equal({});
  });

  it("loop goes through the stops in order, ping-pong comes back, one stop stays", () => {
    expect(visits(path(), 7)).to.deep.equal([0, 1, 2, 0, 1, 2, 0]);
    expect(visits(path({ order: "pingpong" }), 7)).to.deep.equal([0, 1, 2, 1, 0, 1, 2]);
    expect(visits(PathSchema.parse({ stops: [{ zone: "a" }], order: "random" }), 5)).to.deep.equal([0, 0, 0, 0, 0]);
  });

  it("random never goes to the same stop twice in a row, and replays the same draw (deterministic)", () => {
    const p = path({ order: "random" });
    const a = visits(p, 300);
    expect(visits(p, 300)).to.deep.equal(a);
    for (let k = 1; k < a.length; k++) expect(a[k]).to.not.equal(a[k - 1]);
    expect(new Set(a).size).to.equal(3);
    // another look (another seed) draws another sequence
    expect(visits(p, 300, 8)).to.not.deep.equal(a);
  });

  it("weighted respects the weights over 1 000 steps", () => {
    const p = PathSchema.parse({ stops: [{ zone: "a", weight: 1 }, { zone: "b", weight: 3 }, { zone: "c", weight: 0 }], order: "weighted" });
    const counts = [0, 0, 0];
    for (const v of visits(p, 1000)) counts[v]!++;
    expect(counts[2]).to.equal(0);
    expect(counts[1]! / 1000).to.be.within(0.68, 0.82);
  });

  it("chacune: in a drawn order each head has its own sequence, distinct and deterministic; ensemble shares one", () => {
    const own = path({ order: "random", heads: "chacune" });
    const h0 = visits(own, 100, 7, 0);
    const h1 = visits(own, 100, 7, 1);
    expect(h0).to.not.deep.equal(h1);
    expect(visits(own, 100, 7, 1)).to.deep.equal(h1);
    const together = path({ order: "random" });
    expect(visits(together, 100, 7, 0)).to.deep.equal(visits(together, 100, 7, 1));
    // in loop there is only one sequence: chacune plays as ensemble
    expect(visits(path({ heads: "chacune" }), 6, 7, 1)).to.deep.equal([0, 1, 2, 0, 1, 2]);
    // the seed mix is the murmur3 finaliser: neighbouring inputs, unrelated seeds
    expect(mixSeed(1, 2)).to.not.equal(mixSeed(2, 1));
  });

  it("decales: each head one stop behind the one before it, in row order, reverse and shuffle followed", () => {
    const p = path({ heads: "decales" });
    const offsets = [0, 1, 2].map((i) => stopOffset(p, {}, i, 3));
    expect(offsets).to.deep.equal([2, 1, 0]);
    const at = offsets.map((o) => visits(p, 4, 7, 0, o));
    expect(at[0]).to.deep.equal([2, 0, 1, 2]);
    expect(at[1]).to.deep.equal([1, 2, 0, 1]);
    expect(at[2]).to.deep.equal([0, 1, 2, 0]);
    expect([0, 1, 2].map((i) => stopOffset(p, { reverse: true }, i, 3))).to.deep.equal([0, 1, 2]);
    expect(new Set([0, 1, 2].map((i) => stopOffset(p, { shuffle: true }, i, 3))).size).to.equal(3);
    expect(stopOffset(path(), {}, 2, 3)).to.equal(0);
  });

  it("travels the first `travel` part of a step with a cosine ease, then rests; the first step rests on its stop", () => {
    const p = path({ travel: 0.5 });
    const seq = pathSequence(p, 7, 0);
    expect(pathStep(p, seq, 0.3)).to.include({ from: 0, to: 0 });
    const s = pathStep(p, seq, 1.25);
    expect([s.from, s.to]).to.deep.equal([0, 1]);
    expect(s.ease).to.be.closeTo(0.5, 1e-9);
    expect(pathStep(p, seq, 1.6)).to.include({ from: 0, to: 1, ease: 1 });
    expect(pathStep(path({ travel: 0 }), seq, 1.01).ease).to.equal(1);
    expect(pathPosition({ pan: 0.2, tilt: 0.8 }, { pan: 0.6, tilt: 0.4 }, 0.5)).to.deep.equal({ pan: 0.4, tilt: 0.6000000000000001 });
  });

  it("never jumps: frame to frame, the steepest move is the cosine ease's slope bound", () => {
    const p = path({ travel: 0.5, order: "random" });
    const seq = pathSequence(p, 3, 0);
    const stops = [{ pan: 0.1, tilt: 0.2 }, { pan: 0.9, tilt: 0.8 }, { pan: 0.5, tilt: 0.1 }];
    const dt = 0.01; // a hundredth of a step per frame
    let prev = pathPosition(stops[0]!, stops[0]!, 0);
    for (let c = 0; c < 40; c += dt) {
      const s = pathStep(p, seq, c);
      const at = pathPosition(stops[s.from]!, stops[s.to]!, s.ease);
      const bound = (Math.PI / 2 / p.travel) * dt * 1.0001; // max of d(ease)/dphase × the largest gap (≤ 1)
      expect(Math.abs(at.pan - prev.pan)).to.be.at.most(bound);
      expect(Math.abs(at.tilt - prev.tilt)).to.be.at.most(bound);
      if (s.ease === 1) expect(Math.abs(at.pan - prev.pan)).to.be.below(0.1);
      prev = at;
    }
  });

  it("names the trips a head may make: loop around, ping-pong between neighbours, random any two", () => {
    expect(travelPairs(path())).to.deep.equal([[0, 1], [1, 2], [0, 2]]);
    expect(travelPairs(path({ order: "pingpong" }))).to.deep.equal([[0, 1], [1, 2]]);
    expect(travelPairs(path({ order: "random" }))).to.have.length(3);
    expect(travelPairs(PathSchema.parse({ stops: [{ zone: "a" }, { zone: "b" }] }))).to.deep.equal([[0, 1]]);
    expect(travelPairs(PathSchema.parse({ stops: [{ zone: "a" }] }))).to.deep.equal([]);
  });
});

describe("path checks (T28)", () => {
  const setup: AimSetup = { position: { x: 0, y: 0, z: 5 }, hung: true, yaw: 0, panMax: 540, tiltMax: 270, panOffset: 0, tiltOffset: 0 };
  const pts = [
    { x: -3, y: 3, z: 0 },
    { x: 3, y: 3, z: 0 },
    { x: 0, y: 6, z: 0 },
  ];
  const stopsOf = (s: AimSetup) => pts.map((p) => {
    const r = aimAt(s, p);
    return "error" in r ? { error: r.error } : { pan: r.pan, tilt: r.tilt };
  });
  const head = (more: Partial<PathHead> = {}): PathHead => ({ id: "h", name: "Lyre 1", panMax: 540, tiltMax: 270, setup, stops: stopsOf(setup), ...more });
  const input = (heads: PathHead[], more: object = {}) => ({ path: path(), heads, travelSeconds: 1, noAim: [], stopName: (i: number) => `S${i + 1}`, ...more });

  it("says nothing without a rule or a zone, and every head reaching every stop", () => {
    expect(checkPath(input([head()]))).to.deep.equal([]);
  });

  it("speed: per head and per axis, only where a rule applies, the worst trip named", () => {
    const h = head();
    const degs = (axis: "pan" | "tilt") => Math.max(...travelPairs(path()).map(([a, b]) => Math.abs((h.stops[b] as { pan: number; tilt: number })[axis] - (h.stops[a] as { pan: number; tilt: number })[axis]) * (axis === "pan" ? 540 : 270)));
    const pan = degs("pan");
    const tilt = degs("tilt");
    // a rule on pan only, just below what the worst trip needs: pan said, tilt not
    const ws = checkPath(input([head({ speed: { pan: pan * 0.9 } })]));
    expect(ws.map((w) => w.kind)).to.deep.equal(["speed"]);
    expect(ws[0]!.message).to.match(/pan/);
    // a rule on tilt only: tilt said, pan not; enough speed: nothing
    expect(checkPath(input([head({ speed: { tilt: tilt * 0.5 } })]))[0]!.message).to.match(/tilt/);
    expect(checkPath(input([head({ speed: { pan: pan * 1.01, tilt: tilt * 1.01 } })]))).to.deep.equal([]);
    // the trip's time is every × travel: half as long, twice the speed
    expect(checkPath(input([head({ speed: { pan: pan * 1.5 } })], { travelSeconds: 0.5 }))).to.have.length(1);
    // a travel of 0 is a cut: said as instant
    expect(checkPath(input([head({ speed: { pan: 10000 } })], { travelSeconds: 0 }))[0]!.kind).to.equal("speed");
  });

  it("stops out of reach: for some heads (they hold), or for every head", () => {
    const blind = head({ id: "b", name: "Lyre 2", stops: [{ pan: 0.5, tilt: 0.5 }, { error: "out of reach" }, { pan: 0.4, tilt: 0.5 }] });
    const ws = checkPath(input([head(), blind]));
    expect(ws.map((w) => [w.kind, w.stops, w.heads])).to.deep.equal([["unreachable", [1], ["b"]]]);
    expect(checkPath(input([blind]))[0]!.kind).to.equal("nowhere");
  });

  it("no-aim zones: a trip whose beam crosses one is said, the zone named; a stop sitting in one too", () => {
    // a lectern between the first two stops, on the line the head sweeps
    const lectern = ZoneSchema.parse({ id: "pupitre", name: "Pupitre", polygon: [[-0.5, 2], [0.5, 2], [0.5, 4], [-0.5, 4]], noAim: true });
    const ws = checkPath(input([head()], { noAim: [lectern] }));
    expect(ws.map((w) => [w.kind, w.stops])).to.deep.equal([["noAimStop", [2]], ["noAim", [0, 1]]]);
    expect(ws[1]).to.include({ zone: "pupitre" });
    expect(ws[0]!.message).to.match(/Pupitre/);
    // far from every trip: nothing
    const far = ZoneSchema.parse({ id: "loin", name: "Loin", polygon: [[8, 8], [9, 8], [9, 9], [8, 9]], noAim: true });
    expect(checkPath(input([head()], { noAim: [far] }))).to.deep.equal([]);
    // a single stop inside a zone
    const on = ZoneSchema.parse({ id: "s", name: "S", polygon: [[-1, 5], [1, 5], [1, 7], [-1, 7]], noAim: true });
    const one = PathSchema.parse({ stops: [{ point: pts[2] }] });
    const landing = checkPath(input([head({ stops: [stopsOf(setup)[2]!] })], { path: one, noAim: [on] }));
    expect(landing.map((w) => w.kind)).to.deep.equal(["noAimStop"]);
    expect(landing[0]!.message).to.match(/vise « S » pour Lyre 1 : elle y restera éteinte/);
  });

  it("a stop landing in a no-aim zone is said as such, never again as a crossing of the trips to it", () => {
    const lectern = ZoneSchema.parse({ id: "pupitre", name: "Pupitre", polygon: [[2.5, 2.5], [3.5, 2.5], [3.5, 3.5], [2.5, 3.5]], noAim: true });
    const ws = checkPath(input([head()], { noAim: [lectern] }));
    expect(ws.map((w) => [w.kind, w.stops])).to.deep.equal([["noAimStop", [1]]]);
  });

  it("every no-aim zone a trip crosses is said, not only the first", () => {
    const a = ZoneSchema.parse({ id: "a", name: "A", polygon: [[-1.6, 2.5], [-1.2, 2.5], [-1.2, 3.5], [-1.6, 3.5]], noAim: true });
    const b = ZoneSchema.parse({ id: "b", name: "B", polygon: [[1.2, 2.5], [1.6, 2.5], [1.6, 3.5], [1.2, 3.5]], noAim: true });
    const ws = checkPath(input([head()], { path: PathSchema.parse({ stops: [{ point: pts[0] }, { point: pts[1] }] }), noAim: [a, b] }));
    expect(ws.filter((w) => w.kind === "noAim").map((w) => w.zone).sort()).to.deep.equal(["a", "b"]);
  });

  it("a long trip is sampled by angle: a narrow zone the guard blanks is never missed", () => {
    // a head hung low, sweeping 176° of pan between two points either side of it; a 0.3 m zone just below its path
    const low: AimSetup = { ...setup, position: { x: 0, y: 3, z: 2 } };
    const ends = [aimAt(low, { x: -6, y: 3.2, z: 0 }), aimAt(low, { x: 6, y: 3.2, z: 0 })].map((r) => ("error" in r ? { error: r.error } : { pan: r.pan, tilt: r.tilt }));
    // the beam sweeps a circle on the floor around the head, through (0, 9) or (0, −3): a 0.3 m strip across each
    const narrow = [9, -3].map((y, k) => ZoneSchema.parse({ id: `n${k}`, name: "Étroite", polygon: [[-0.15, y - 0.4], [0.15, y - 0.4], [0.15, y + 0.4], [-0.15, y + 0.4]], noAim: true }));
    const h = head({ setup: low, stops: ends });
    const deg = Math.abs((ends[1] as { pan: number }).pan - (ends[0] as { pan: number }).pan) * 540;
    expect(tripSamples(h, ends[0] as { pan: number; tilt: number }, ends[1] as { pan: number; tilt: number })).to.be.at.least(Math.ceil(deg / 1.5));
    const ws = checkPath(input([h], { path: PathSchema.parse({ stops: [{ point: { x: -6, y: 3.2, z: 0 } }, { point: { x: 6, y: 3.2, z: 0 } }] }), noAim: narrow }));
    expect(ws.map((w) => w.kind)).to.deep.equal(["noAim"]);
  });

  it("says the causes head by head, with the right agreement, and numbers as the language writes them", () => {
    const blind = (id: string, name: string) => head({ id, name, stops: [{ pan: 0.5, tilt: 0.5 }, { error: "hors de portée (pan 126°, tilt 47°)" }, { pan: 0.4, tilt: 0.5 }] });
    const one = checkPath(input([head(), blind("b", "Lyre 3")]))[0]!.message;
    expect(one).to.contain("Lyre 3 : hors de portée (pan 126°, tilt 47°)");
    expect(one).to.contain("elle reste en place");
    const two = checkPath(input([head(), blind("b", "Lyre 3"), blind("c", "Lyre 4")]))[0]!.message;
    expect(two).to.contain("Lyre 3 : hors de portée (pan 126°, tilt 47°) ; Lyre 4 : hors de portée");
    expect(two).to.contain("elles restent en place");
    const speed = checkPath(input([head({ speed: { pan: 10 } })], { travelSeconds: 7 }))[0]!.message;
    expect(speed).to.match(/demande \d+(,\d)? °\/s en pan/);
    expect(speed).to.contain("la règle en permet 10 °/s");
    expect(num(30.5)).to.equal("30,5");
    expect(inLang("en", () => num(30.5))).to.equal("30.5");
    // instant: said in degrees at once, with the rule's °/s
    expect(checkPath(input([head({ speed: { pan: 10 } })], { travelSeconds: 0 }))[0]!.message).to.match(/instantané.*la règle en permet 10 °\/s/);
  });

  it("the speed check reads the trip's time: a shorter part of the step travelling warns where a longer one does not", () => {
    const h = head();
    const worst = Math.max(...travelPairs(path()).map(([a, b]) => Math.abs((h.stops[b] as { pan: number }).pan - (h.stops[a] as { pan: number }).pan) * 540));
    const limited = head({ speed: { pan: worst / 1.5 } });
    expect(checkPath(input([limited], { travelSeconds: 2 }))).to.deep.equal([]);
    expect(checkPath(input([limited], { travelSeconds: 1 }))).to.have.length(1);
  });
});

describe("path order and weights (T28, review 1)", () => {
  it("travelPairs leaves out the stops of weight 0 in weighted order; all weights 0 is refused", () => {
    const p = PathSchema.parse({ stops: [{ zone: "a" }, { zone: "b", weight: 0 }, { zone: "c" }], order: "weighted" });
    expect(travelPairs(p)).to.deep.equal([[0, 2]]);
    expect(PathSchema.safeParse({ stops: [{ zone: "a", weight: 0 }, { zone: "b", weight: 0 }], order: "weighted" }).success).to.equal(false);
    expect(PathSchema.safeParse({ stops: [{ zone: "a", weight: 0 }, { zone: "b", weight: 0 }], order: "loop" }).success).to.equal(true);
  });

  it("chacune: distinct heads start on different sequences as often as chance says (the seeds are well mixed)", () => {
    const p = PathSchema.parse({ stops: [{ zone: "a" }, { zone: "b" }, { zone: "c" }, { zone: "d" }], order: "random", heads: "chacune" });
    let same = 0;
    const looks = 600;
    for (let look = 0; look < looks; look++) {
      const a = pathSequence(p, look * 7919 + 13, 0);
      const b = pathSequence(p, look * 7919 + 13, 1);
      if ([0, 1, 2].every((i) => a(i) === b(i))) same++;
    }
    // 4 stops, no repeat: 4 × 3 × 3 = 36 sequences of three; by chance 1/36 of the looks, never most of them
    expect(same / looks).to.be.below(0.06);
    // and a head's sequence differs from its neighbour's within its first steps for the very first looks
    for (let look = 1; look <= 5; look++) {
      const a = Array.from({ length: 8 }, (_, i) => pathSequence(p, look, 0)(i));
      const b = Array.from({ length: 8 }, (_, i) => pathSequence(p, look, 1)(i));
      expect(a).to.not.deep.equal(b);
    }
  });
});
