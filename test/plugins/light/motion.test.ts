import { expect } from "chai";
import {
  AXES,
  CENTRE,
  emptyMotionState,
  holdMotion,
  motionDurationMs,
  releaseMotion,
  resolveMotion,
  type Axis,
  type AxisMode,
  type HeadStatus,
  type LockLevel,
  type MotionClaim,
  type MotionContext,
  type MotionInput,
  type MotionResult,
  type MotionSettings,
  type MotionState,
} from "../../../src/plugins/light/engine/motion.js";
import { DEFAULT_MOVE_FADE, MoveSchema, type MoveFade as MotionDuration, type Position } from "../../../src/plugins/light/engine/move.js";
import { rng } from "../../../src/plugins/light/engine/techniques.js";

const FRAME = 20;
const SEC = (seconds: number): MotionDuration => ({ seconds });

const look = (id: string, order: number, heads: string[], at: Partial<Position>, fade?: MotionDuration): MotionClaim => ({
  owner: `look:${id}`,
  layer: "look",
  order,
  heads,
  base: { kind: "fixed", ...at },
  ...(fade ? { fade } : {}),
});
const manual = (order: number, heads: string[], at: Partial<Position>): MotionClaim => ({
  owner: "manual",
  layer: "manual",
  order,
  heads,
  base: { kind: "fixed", ...at },
  fade: SEC(0),
});
const target = (id: string, order: number, heads: string[], point = { x: 0, y: 0, z: 0 }): MotionClaim => ({
  owner: `target:${id}`,
  layer: "target",
  order,
  heads,
  base: { kind: "point", ...point },
});

interface SimOptions {
  heads?: string[];
  bpm?: number;
  settings?: MotionSettings;
  ctx?: MotionContext;
  lock?: (head: string) => LockLevel;
  axisMode?: (head: string, axis: Axis) => AxisMode;
  /** What the guard does to the position asked before it is sent (a speed rule…). Default: sent as asked. */
  guard?: (head: string, asked: Position, before: Position | undefined) => Position;
}

/** Drives the pure layer like the runtime will: one frame at a time, `sent` read back from the previous one. */
class Sim {
  state: MotionState = emptyMotionState();
  sent = new Map<string, Position>();
  claims: MotionClaim[] = [];
  bpm: number;
  last!: MotionResult;
  constructor(readonly o: SimOptions = {}) {
    this.bpm = o.bpm ?? 120;
  }
  input(now: number): MotionInput {
    return {
      heads: this.o.heads ?? ["h1"],
      claims: this.claims,
      now,
      bpm: this.bpm,
      sent: this.sent,
      ...(this.o.settings ? { settings: this.o.settings } : {}),
      ...(this.o.ctx ? { ctx: this.o.ctx } : {}),
      ...(this.o.lock ? { lock: this.o.lock } : {}),
      ...(this.o.axisMode ? { axisMode: this.o.axisMode } : {}),
    };
  }
  frame(now: number): MotionResult {
    this.last = resolveMotion(this.input(now), this.state);
    this.state = this.last.next;
    const sent = new Map<string, Position>();
    for (const [h, p] of this.last.positions) sent.set(h, this.o.guard ? this.o.guard(h, p, this.sent.get(h)) : p);
    this.sent = sent;
    return this.last;
  }
  at(now: number, head = "h1"): Position {
    return this.frame(now).positions.get(head)!;
  }
  /** Frames every 20 ms over [from, to], returning the positions of `head`. */
  run(from: number, to: number, head = "h1"): Position[] {
    const out: Position[] = [];
    for (let t = from; t <= to; t += FRAME) out.push(this.at(t, head));
    return out;
  }
}

const maxStep = (ps: Position[]) => {
  let m = 0;
  for (let i = 1; i < ps.length; i++) m = Math.max(m, Math.abs(ps[i]!.pan - ps[i - 1]!.pan), Math.abs(ps[i]!.tilt - ps[i - 1]!.tilt));
  return m;
};
/** Steepest a smoothstep moves over one frame: slope 1.5 × travel / duration. */
const bound = (travel: number, ms: number) => (1.5 * travel * FRAME) / ms + 1e-9;

describe("motion layer (pure)", () => {
  describe("durations (Q3)", () => {
    const cases: [MotionDuration, number, number][] = [
      [{ beats: 2 }, 120, 1000],
      [{ beats: 2 }, 60, 2000],
      [{ beats: 0.5 }, 120, 250],
      [{ seconds: 1.5 }, 90, 1500],
      [{ seconds: 0.25 }, 0, 250],
      [{ seconds: 0 }, 120, 0],
      [{ beats: 0 }, 120, 0],
      [{ beats: 2 }, 0, 1000], // no tempo known: 120 BPM
      [{ beats: 2 }, Number.NaN, 1000],
      [{ seconds: -1 }, 120, 0],
    ];
    for (const [d, bpm, ms] of cases)
      it(`${JSON.stringify(d)} at ${bpm} BPM = ${ms} ms`, () => {
        expect(motionDurationMs(d, bpm)).to.be.closeTo(ms, 1e-9);
      });

    it("defaults to 1 s", () => {
      expect(DEFAULT_MOVE_FADE).to.deep.equal({ seconds: 1 });
    });

    it("fixes the duration when the transition starts: a tempo change does not stretch it", () => {
      const sim = new Sim({ bpm: 120, settings: { moveFade: { beats: 2 } } });
      sim.at(0); // rest
      sim.claims = [look("a", 1, ["h1"], { pan: 1, tilt: 0.5 })];
      sim.at(1000); // starts: 2 beats at 120 BPM = 1000 ms
      sim.bpm = 60; // would be 2000 ms now
      expect(sim.at(1500).pan).to.be.closeTo(0.75, 1e-9);
      expect(sim.at(2000).pan).to.equal(1);
      expect(sim.last.status.get("h1")!.pan.moving).to.equal(false);
    });

    it("reads the tempo at the start of each new transition", () => {
      const sim = new Sim({ bpm: 60, settings: { moveFade: { beats: 1 } } });
      sim.at(0);
      sim.claims = [look("a", 1, ["h1"], { pan: 1 })];
      sim.at(0);
      expect(sim.at(500).pan).to.be.closeTo(0.75, 1e-9); // 1 beat at 60 BPM = 1000 ms
    });
  });

  describe("rest (Q2, Q7)", () => {
    it("puts a head nobody claims at the centre on the first frame", () => {
      const sim = new Sim();
      expect(sim.at(0)).to.deep.equal(CENTRE);
      expect(sim.last.status.get("h1")!.pan).to.include({ layer: "rest", owner: null, moving: false });
    });

    it("puts it at its own rest position when the show sets one", () => {
      const sim = new Sim({ heads: ["h1", "h2"], settings: { rest: { h2: { pan: 0.2, tilt: 0.9 } } } });
      sim.frame(0);
      expect(sim.last.positions.get("h1")).to.deep.equal(CENTRE);
      expect(sim.last.positions.get("h2")).to.deep.equal({ pan: 0.2, tilt: 0.9 });
    });

    it("glides back to rest with the show's default when the last look releases it", () => {
      const sim = new Sim({ settings: { moveFade: SEC(1) } });
      sim.claims = [look("a", 1, ["h1"], { pan: 1, tilt: 1 }, SEC(0))];
      expect(sim.at(0)).to.deep.equal({ pan: 1, tilt: 1 }); // the look cuts in
      sim.claims = [];
      expect(sim.at(20)).to.deep.equal({ pan: 1, tilt: 1 }); // starts from where it is
      expect(sim.at(520).pan).to.be.closeTo(0.75, 1e-9);
      expect(sim.at(1020)).to.deep.equal(CENTRE);
    });

    it("glides to a rest position changed in the show", () => {
      const rest: Record<string, Position> = {};
      const sim = new Sim({ settings: { moveFade: SEC(1), rest } });
      sim.at(0);
      rest.h1 = { pan: 1, tilt: 0.5 };
      sim.at(100);
      expect(sim.at(600).pan).to.be.closeTo(0.75, 1e-9);
      expect(sim.at(1100).pan).to.equal(1);
    });
  });

  describe("the stack (Q1)", () => {
    const ctx: MotionContext = { aim: () => ({ pan: 0.3, tilt: 0.3 }) };
    const cases: { name: string; claims: MotionClaim[]; layer: string; owner: string; pan: number }[] = [
      { name: "a look alone", claims: [look("a", 1, ["h1"], { pan: 0.1, tilt: 0.1 })], layer: "look", owner: "look:a", pan: 0.1 },
      {
        name: "the look launched last",
        claims: [look("b", 2, ["h1"], { pan: 0.2, tilt: 0.2 }), look("a", 1, ["h1"], { pan: 0.1, tilt: 0.1 })],
        layer: "look",
        owner: "look:b",
        pan: 0.2,
      },
      {
        name: "a target over looks launched after it",
        claims: [target("t", 1, ["h1"]), look("b", 9, ["h1"], { pan: 0.2, tilt: 0.2 })],
        layer: "target",
        owner: "target:t",
        pan: 0.3,
      },
      {
        name: "manual over everything",
        claims: [look("b", 9, ["h1"], { pan: 0.2, tilt: 0.2 }), manual(1, ["h1"], { pan: 0.9, tilt: 0.9 }), target("t", 5, ["h1"])],
        layer: "manual",
        owner: "manual",
        pan: 0.9,
      },
      {
        name: "same order: the later claim in the list",
        claims: [look("a", 1, ["h1"], { pan: 0.1, tilt: 0.1 }), look("b", 1, ["h1"], { pan: 0.2, tilt: 0.2 })],
        layer: "look",
        owner: "look:b",
        pan: 0.2,
      },
      {
        name: "a look on other heads does not claim this one",
        claims: [look("a", 1, ["h1"], { pan: 0.1, tilt: 0.1 }), look("b", 2, ["h2"], { pan: 0.2, tilt: 0.2 })],
        layer: "look",
        owner: "look:a",
        pan: 0.1,
      },
      {
        name: "a look without motion claims nothing (R5)",
        claims: [look("a", 1, ["h1"], { pan: 0.1, tilt: 0.1 }), { owner: "look:colour", layer: "look", order: 2, heads: ["h1"] }],
        layer: "look",
        owner: "look:a",
        pan: 0.1,
      },
    ];
    for (const c of cases)
      it(`wins: ${c.name}`, () => {
        const sim = new Sim({ ctx, settings: { moveFade: SEC(0) } });
        sim.claims = c.claims;
        expect(sim.at(0).pan).to.be.closeTo(c.pan, 1e-9);
        expect(sim.last.status.get("h1")!.pan).to.include({ layer: c.layer, owner: c.owner });
      });

    it("reports every active layer per axis, strongest first and rest last", () => {
      const sim = new Sim({ ctx, settings: { moveFade: SEC(0) } });
      sim.claims = [look("a", 1, ["h1"], { pan: 0.1, tilt: 0.1 }), target("t", 2, ["h1"]), manual(3, ["h1"], { pan: 0.9 })];
      sim.frame(0);
      const status = sim.last.status.get("h1")!;
      expect(status.pan.layers).to.deep.equal(["manual", "target", "look", "rest"]);
      expect(status.tilt.layers).to.deep.equal(["target", "look", "rest"]);
    });

    it("places hard and soft locks at their own ranks in the reported stack", () => {
      const hard = new Sim({ lock: () => "hard", settings: { moveFade: SEC(0) } });
      hard.claims = [look("a", 1, ["h1"], { pan: 0.1, tilt: 0.1 }), manual(2, ["h1"], { pan: 0.9, tilt: 0.9 })];
      hard.frame(0);
      expect(hard.last.status.get("h1")!.pan.layers).to.deep.equal(["lock", "manual", "look", "rest"]);
      const soft = new Sim({ lock: () => "soft", settings: { moveFade: SEC(0) } });
      soft.claims = hard.claims;
      soft.frame(0);
      expect(soft.last.status.get("h1")!.pan.layers).to.deep.equal(["manual", "lock", "look", "rest"]);
    });

    it("says which owners it masks", () => {
      const sim = new Sim({ ctx, settings: { moveFade: SEC(0) } });
      sim.claims = [look("a", 1, ["h1"], { pan: 0.1, tilt: 0.1 }), manual(2, ["h1"], { pan: 0.9, tilt: 0.9 }), { owner: "look:c", layer: "look", order: 3, heads: ["h1"] }];
      sim.frame(0);
      expect(sim.last.status.get("h1")!.masked).to.deep.equal(["look:a"]);
    });

    it("a look stopping hands the head back to the one below, gliding (R3)", () => {
      const sim = new Sim({ settings: { moveFade: SEC(1) } });
      const ambient = look("ambient", 1, ["h1"], { pan: 0.2, tilt: 0.5 }, SEC(0));
      sim.claims = [ambient, look("accent", 2, ["h1"], { pan: 0.8, tilt: 0.5 }, SEC(0))];
      const ps = [sim.at(0)];
      expect(ps[0]!.pan).to.equal(0.8);
      sim.claims = [ambient];
      ps.push(...sim.run(20, 1020));
      expect(ps.at(-1)!.pan).to.be.closeTo(0.2, 1e-9);
      // the ambient look cuts when it takes over, but taking a head back is a release: the show's default
      expect(maxStep(ps)).to.be.at.most(bound(0.6, 1000));
      expect(ps[1]!.pan).to.be.above(0.79);
    });

    it("a newer look cutting in takes the head at once; the older one taking it back glides", () => {
      const sim = new Sim({ settings: { moveFade: SEC(1) } });
      const older = look("a", 1, ["h1"], { pan: 0.2, tilt: 0.5 }, SEC(0));
      sim.claims = [older];
      expect(sim.at(0).pan).to.equal(0.2); // first frame: from rest, cut
      sim.claims = [older, look("b", 2, ["h1"], { pan: 0.8, tilt: 0.5 }, SEC(0))];
      expect(sim.at(20).pan).to.equal(0.8); // newer, same layer, its own cut
      sim.claims = [older];
      expect(sim.at(40).pan).to.equal(0.8); // a release, not a take-over: moveFade
      expect(sim.at(540).pan).to.be.closeTo(0.5, 1e-9);
    });
  });

  describe("per axis", () => {
    it("a pan-only claim takes the pan; the tilt stays with the layer below, without a transition", () => {
      const sim = new Sim({ settings: { moveFade: SEC(1) } });
      const a = look("a", 1, ["h1"], { pan: 0.2, tilt: 0.8 }, SEC(0));
      sim.claims = [a];
      sim.at(0);
      sim.claims = [a, { ...manual(2, ["h1"], { pan: 0.9 }), fade: SEC(1) }];
      sim.at(20);
      const mid = sim.at(520);
      expect(mid.pan).to.be.closeTo(0.55, 1e-9);
      expect(mid.tilt).to.equal(0.8);
      const st = sim.last.status.get("h1")!;
      expect(st.pan).to.include({ layer: "manual", moving: true });
      expect(st.tilt).to.include({ layer: "look", owner: "look:a", moving: false });
      expect(st.masked).to.deep.equal([]); // look:a still wins the tilt
    });

    it("raw pan/tilt of a look (Q6) are a look claim: a tilt-only raw channel obeys the manual layer", () => {
      const sim = new Sim({ settings: { moveFade: SEC(0) } });
      const raw = look("scene", 1, ["h1"], { tilt: 0.1 });
      sim.claims = [raw];
      expect(sim.at(0)).to.deep.equal({ pan: 0.5, tilt: 0.1 }); // the pan rests
      sim.claims = [raw, manual(2, ["h1"], { pan: 0.7, tilt: 0.7 })];
      expect(sim.at(20)).to.deep.equal({ pan: 0.7, tilt: 0.7 });
    });

    it("an axis that cuts (T5 track unticked) jumps at a change of owner, the other glides", () => {
      const sim = new Sim({ settings: { moveFade: SEC(1) }, axisMode: (_h, axis) => (axis === "pan" ? "cut" : "glide") });
      sim.at(0);
      sim.claims = [look("a", 1, ["h1"], { pan: 1, tilt: 1 })];
      const p = sim.at(20);
      expect(p.pan).to.equal(1);
      expect(p.tilt).to.equal(0.5);
      expect(sim.at(520).tilt).to.be.closeTo(0.75, 1e-9);
    });
  });

  describe("transitions (R7, R8)", () => {
    it("eases from the position sent to the new look's, over the look's own fade", () => {
      const sim = new Sim({ settings: { moveFade: SEC(5) } });
      sim.at(0);
      sim.claims = [look("a", 1, ["h1"], { pan: 1, tilt: 0 }, SEC(2))];
      const ps = sim.run(0, 2000);
      expect(ps[0]).to.deep.equal(CENTRE);
      expect(ps[25]!.pan).to.be.below(0.5 + 0.5 * 0.25); // eased: slower than linear at the start
      expect(ps[50]!.pan).to.be.closeTo(0.75, 1e-9);
      expect(ps.at(-1)).to.deep.equal({ pan: 1, tilt: 0 });
      expect(maxStep(ps)).to.be.at.most(bound(0.5, 2000));
      for (const p of ps) expect(p.pan).to.be.within(0.5, 1);
    });

    it("a look's fade of 0 cuts; the pad (direct) follows the finger without delay", () => {
      const sim = new Sim({ settings: { moveFade: SEC(1) } });
      sim.at(0);
      sim.claims = [look("a", 1, ["h1"], { pan: 0, tilt: 0 }, SEC(0))];
      expect(sim.at(20)).to.deep.equal({ pan: 0, tilt: 0 });
      for (const [t, x] of [[40, 0.3], [60, 0.9], [80, 0.1]] as const) {
        sim.claims = [look("a", 1, ["h1"], { pan: 0, tilt: 0 }), manual(2, ["h1"], { pan: x, tilt: x })];
        expect(sim.at(t)).to.deep.equal({ pan: x, tilt: x });
      }
    });

    it("a named position recalled to the manual layer (Q5) glides with the show's default", () => {
      const ctx: MotionContext = { presetOf: (id) => (id === "lectern" ? { pan: 1, tilt: 0.5 } : undefined) };
      const sim = new Sim({ ctx, settings: { moveFade: SEC(1) } });
      sim.at(0);
      sim.claims = [{ owner: "manual", layer: "manual", order: 1, heads: ["h1"], base: { kind: "preset", id: "lectern" } }];
      sim.at(0);
      expect(sim.at(500).pan).to.be.closeTo(0.75, 1e-9);
      expect(sim.at(1000).pan).to.equal(1);
    });

    it("releasing the manual layer glides back with the show's default, not the look's cut", () => {
      const sim = new Sim({ settings: { moveFade: SEC(1) } });
      const a = look("a", 1, ["h1"], { pan: 0, tilt: 0.5 }, SEC(0));
      sim.claims = [a, manual(2, ["h1"], { pan: 1, tilt: 0.5 })];
      sim.at(0);
      sim.claims = [a];
      sim.at(20);
      expect(sim.at(520).pan).to.be.closeTo(0.5, 1e-9);
      expect(sim.at(1020).pan).to.equal(0);
    });

    it("starts from what was really sent, not from what it asked (a speed rule held it back)", () => {
      // the guard lets the pan move 0.01 per frame at most
      const guard = (_h: string, asked: Position, before: Position | undefined): Position =>
        before ? { pan: before.pan + Math.max(-0.01, Math.min(0.01, asked.pan - before.pan)), tilt: asked.tilt } : asked;
      const sim = new Sim({ settings: { moveFade: SEC(0) }, guard });
      sim.at(0);
      sim.claims = [look("a", 1, ["h1"], { pan: 1, tilt: 0.5 })];
      sim.run(20, 200); // asked 1 at once, sent crawls
      const sent = sim.sent.get("h1")!.pan;
      expect(sent).to.be.closeTo(0.6, 1e-9);
      sim.claims = [look("a", 1, ["h1"], { pan: 1, tilt: 0.5 }), look("b", 2, ["h1"], { pan: 0, tilt: 0.5 }, SEC(1))];
      expect(sim.at(220).pan).to.be.closeTo(sent, 1e-9); // the new transition leaves from the sent position
    });

    it("follows a moving shape: the formula converges on it", () => {
      const move = MoveSchema.parse({ shape: "cercle", size: { pan: 0.2, tilt: 0.2 } });
      const sim = new Sim({ settings: { moveFade: SEC(1) } });
      sim.at(0);
      const circle = (t: number): MotionClaim => ({ owner: "look:c", layer: "look", order: 1, heads: ["h1"], shape: { move, cycles: t / 2000 } });
      const ps: Position[] = [];
      for (let t = 0; t <= 3000; t += FRAME) {
        sim.claims = [circle(t)];
        ps.push(sim.at(t));
      }
      // after the transition the head is on the circle
      const onCircle = ps.at(-1)!;
      expect(Math.hypot(onCircle.pan - 0.5, onCircle.tilt - 0.5)).to.be.closeTo(0.2, 1e-9);
      // the circle's own speed (2π·0.2 per 2 s) plus the transition's slope
      expect(maxStep(ps)).to.be.at.most(bound(0.2, 1000) + (2 * Math.PI * 0.2 * FRAME) / 2000);
    });

    it("places each head of a shape around its own base, in row order", () => {
      const move = MoveSchema.parse({ shape: "fixe", fan: 0.2 });
      const sim = new Sim({ heads: ["h1", "h2"], settings: { moveFade: SEC(0) } });
      sim.claims = [{ owner: "look:f", layer: "look", order: 1, heads: ["h1", "h2"], base: { kind: "fixed", tilt: 0.3 }, shape: { move, cycles: 0 } }];
      const r = sim.frame(0);
      expect(r.positions.get("h1")!.pan).to.be.closeTo(0.3, 1e-9);
      expect(r.positions.get("h2")!.pan).to.be.closeTo(0.7, 1e-9);
      expect(r.positions.get("h1")!.tilt).to.be.closeTo(0.3, 1e-9);
    });

    // [fade of B, fade back to A, share of B's transition done when A is relaunched]
    const relaunches: [number, number, number][] = [
      [1, 1, 0.25],
      [1, 1, 0.5],
      [1, 1, 0.75],
      [0.5, 8, 0.9], // a fast move turned back by a slow one: the swing must stay short of B
      [0.5, 8, 0.5],
      [0.3, 4, 0.75],
      [2, 0.5, 0.5],
    ];
    for (const [fadeB, fadeA, at] of relaunches)
      it(`relaunch A → B (${fadeB} s) → A (${fadeA} s) at ${at * 100} %: no jump, never past B`, () => {
        const sim = new Sim({ settings: { moveFade: SEC(1) } });
        sim.claims = [look("a", 1, ["h1"], { pan: 0, tilt: 0 }, SEC(0))];
        sim.at(0);
        sim.claims = [look("b", 2, ["h1"], { pan: 0.8, tilt: 0.8 }, SEC(fadeB))];
        const ps = sim.run(20, 20 + Math.round((at * fadeB * 1000) / FRAME) * FRAME);
        const reached = ps.at(-1)!.pan;
        const speed = reached - ps.at(-2)!.pan;
        sim.claims = [look("a", 3, ["h1"], { pan: 0, tilt: 0 }, SEC(fadeA))];
        const back = sim.run(ps.length * FRAME + 20, ps.length * FRAME + 20 + fadeA * 1000 + 100);
        // leaves from where it is, carrying on its way at most at the speed it had: no jump, no sudden reversal
        expect(back[0]!.pan - reached).to.be.within(Math.min(0, speed) - 1e-3, Math.max(0, speed) + 1e-3);
        expect(back.at(-1)).to.deep.equal({ pan: 0, tilt: 0 });
        // it brakes before turning back, but never past the target it was heading for
        for (const p of back) expect(p.pan).to.be.within(0, 0.8 + 1e-9);
        expect(maxStep([...ps, ...back])).to.be.at.most(2 * bound(0.8, Math.min(fadeA, fadeB) * 1000));
      });

    it("released after a pad drag, the head starts at rest: no swing past where the finger left it", () => {
      const sim = new Sim({ settings: { moveFade: SEC(1) } });
      const a = look("a", 1, ["h1"], { pan: 0.2, tilt: 0.5 }, SEC(0));
      sim.claims = [a];
      sim.at(0);
      for (let t = 20, x = 0.2; t <= 400; t += FRAME, x = Math.min(0.6, x + 0.02)) {
        sim.claims = [a, manual(2, ["h1"], { pan: x, tilt: 0.5 })];
        sim.at(t);
      }
      sim.claims = [a];
      for (const p of sim.run(420, 1500)) expect(p.pan).to.be.within(0.2, 0.6 + 1e-9);
    });

    it("a target that moves under the same owner, then stops claiming: no swing past either target", () => {
      const sim = new Sim({ settings: { moveFade: SEC(1) } });
      sim.at(0);
      sim.claims = [look("a", 1, ["h1"], { pan: 0.8, tilt: 0.5 }, SEC(0.5))];
      const ps = sim.run(20, 200);
      sim.claims = [look("a", 1, ["h1"], { pan: 0.55, tilt: 0.5 }, SEC(0.5))]; // edited while it plays
      ps.push(...sim.run(220, 300));
      const top = Math.max(...ps.map((p) => p.pan));
      sim.claims = [];
      for (const p of sim.run(320, 1500)) expect(p.pan).to.be.within(0.5 - 1e-9, Math.max(top, 0.55) + 1e-9);
    });

    it("bounds the swing of a turn-back: √(12 × gap × remaining) / D keeps it short of the old target", () => {
      for (const gap of [0.001, 0.01, 0.1, 0.5, 1])
        for (const remaining of [0.0001, 0.001, 0.01, 0.1, 0.5, 1]) {
          const reach = Math.sqrt(12 * gap * remaining); // D × v0
          let swing = 0;
          for (let i = 0; i <= 1000; i++) {
            const s = i / 1000;
            swing = Math.max(swing, reach * s * (1 - s) ** 2 - gap * (3 * s * s - 2 * s ** 3));
          }
          expect(swing).to.be.at.most(remaining);
        }
    });
  });

  describe("a source that cannot place a head (R14)", () => {
    it("holds the head where it is instead of falling to the layer below, then glides back when in reach", () => {
      let reach = true;
      const ctx: MotionContext = { aim: () => (reach ? { pan: 0.9, tilt: 0.9 } : null) };
      const sim = new Sim({ ctx, settings: { moveFade: SEC(1) } });
      sim.claims = [look("a", 1, ["h1"], { pan: 0.1, tilt: 0.1 }, SEC(0)), { ...target("t", 1, ["h1"]), fade: SEC(0) }];
      expect(sim.at(0)).to.deep.equal({ pan: 0.9, tilt: 0.9 });
      reach = false;
      expect(sim.at(20)).to.deep.equal({ pan: 0.9, tilt: 0.9 });
      expect(sim.at(40)).to.deep.equal({ pan: 0.9, tilt: 0.9 });
      expect(sim.last.status.get("h1")!.pan).to.include({ layer: "target", owner: "target:t", error: "point out of reach" });
      reach = true;
      sim.claims[1] = { ...target("t", 1, ["h1"], { x: 1, y: 0, z: 0 }), fade: SEC(1) };
      const ctx2 = { pan: 0.5, tilt: 0.5 };
      sim.o.ctx!.aim = () => ctx2;
      sim.at(60);
      expect(sim.at(560).pan).to.be.closeTo(0.7, 1e-9); // glides from 0.9 to 0.5
      expect(sim.last.status.get("h1")!.pan.error).to.equal(undefined);
    });

    it("an unknown named position holds and says so", () => {
      const sim = new Sim({ ctx: { presetOf: () => undefined }, settings: { moveFade: SEC(0) } });
      sim.claims = [look("a", 1, ["h1"], { pan: 0.2, tilt: 0.2 })];
      sim.at(0);
      sim.claims.push({ owner: "manual", layer: "manual", order: 2, heads: ["h1"], base: { kind: "preset", id: "gone" } });
      expect(sim.at(20)).to.deep.equal({ pan: 0.2, tilt: 0.2 });
      expect(sim.last.status.get("h1")!.tilt.error).to.equal("unknown position « gone »");
    });

    it("no context at all is an error, not a crash", () => {
      const sim = new Sim();
      sim.claims = [target("t", 1, ["h1"])];
      expect(sim.at(0)).to.deep.equal(CENTRE);
      expect(sim.last.status.get("h1")!.pan.error).to.equal("point out of reach");
    });

    it("clamps a fixed position outside the travel", () => {
      const sim = new Sim({ settings: { moveFade: SEC(0) } });
      sim.claims = [look("a", 1, ["h1"], { pan: 1.4, tilt: -0.2 })];
      expect(sim.at(0)).to.deep.equal({ pan: 1, tilt: 0 });
    });
  });

  describe("lock (T26 hook, R9)", () => {
    it("soft: everything below the manual layer is frozen, the pad still moves the head", () => {
      let lock: LockLevel = "off";
      const sim = new Sim({ lock: () => lock, settings: { moveFade: SEC(1) } });
      sim.claims = [look("a", 1, ["h1"], { pan: 0.2, tilt: 0.2 }, SEC(0))];
      sim.at(0);
      lock = "soft";
      sim.claims = [look("b", 2, ["h1"], { pan: 0.8, tilt: 0.8 }, SEC(0))];
      expect(sim.at(20)).to.deep.equal({ pan: 0.2, tilt: 0.2 });
      expect(sim.last.status.get("h1")).to.deep.include({ lock: "soft", masked: ["look:b"] });
      sim.claims.push(manual(3, ["h1"], { pan: 0.4, tilt: 0.4 }));
      expect(sim.at(40)).to.deep.equal({ pan: 0.4, tilt: 0.4 });
      sim.claims.pop();
      expect(sim.at(60)).to.deep.equal({ pan: 0.4, tilt: 0.4 }); // the manual released under the lock: held there
      lock = "off";
      sim.at(80);
      expect(sim.at(580).pan).to.be.closeTo(0.6, 1e-9); // unlocking glides with the show's default
    });

    it("hard: nothing moves the head, the manual layer included", () => {
      const sim = new Sim({ lock: () => "hard" });
      sim.claims = [manual(1, ["h1"], { pan: 1, tilt: 1 })];
      expect(sim.at(0)).to.deep.equal(CENTRE);
      expect(sim.last.status.get("h1")!.pan).to.include({ layer: "lock", owner: null });
    });
  });

  describe("release what holds (Q1) and home (Q7)", () => {
    it("releasing the top hands the head to the layer below, one layer at a time, then to rest", () => {
      const sim = new Sim({ ctx: { aim: () => ({ pan: 0.3, tilt: 0.3 }) }, settings: { moveFade: SEC(0) } });
      sim.claims = [look("a", 1, ["h1"], { pan: 0.1, tilt: 0.1 }), target("t", 2, ["h1"]), manual(3, ["h1"], { pan: 0.9, tilt: 0.9 })];
      expect(sim.at(0).pan).to.equal(0.9);
      const release = () => (sim.state = releaseMotion(sim.input(0), sim.state, { scope: "top" }));
      release();
      expect(sim.at(20).pan).to.equal(0.3);
      release();
      expect(sim.at(40).pan).to.equal(0.1);
      release();
      expect(sim.at(60)).to.deep.equal(CENTRE);
      expect(sim.last.status.get("h1")!.masked).to.deep.equal([]);
    });

    it("a look relaunched claims the head again; a released claim that stopped is forgotten", () => {
      const sim = new Sim({ settings: { moveFade: SEC(0) } });
      sim.claims = [look("a", 1, ["h1"], { pan: 0.1, tilt: 0.1 })];
      sim.at(0);
      sim.state = releaseMotion(sim.input(0), sim.state, { scope: "top" });
      expect(sim.at(20)).to.deep.equal(CENTRE);
      sim.claims = [look("a", 2, ["h1"], { pan: 0.1, tilt: 0.1 })];
      expect(sim.at(40).pan).to.equal(0.1);
      sim.claims = [];
      sim.at(60);
      sim.claims = [look("a", 1, ["h1"], { pan: 0.1, tilt: 0.1 })]; // same key as the released one, gone meanwhile
      expect(sim.at(80).pan).to.equal(0.1);
    });

    it("on a mixed target releases only the strongest top layer, then the next one", () => {
      const sim = new Sim({ heads: ["h1", "h2"], settings: { moveFade: SEC(0) } });
      sim.claims = [look("a", 1, ["h1", "h2"], { pan: 0.2, tilt: 0.2 }), manual(2, ["h1"], { pan: 0.9, tilt: 0.9 })];
      sim.frame(0);
      sim.state = releaseMotion(sim.input(0), sim.state, { scope: "top", heads: ["h1", "h2"] });
      let status = sim.frame(20).status;
      expect(status.get("h1")!.pan.layer).to.equal("look");
      expect(status.get("h2")!.pan.layer).to.equal("look");
      expect(status.get("h1")!.released).to.deep.equal(["manual#2"]);
      expect(status.get("h2")!.released).to.deep.equal([]); // its weaker look survived the first press
      sim.state = releaseMotion(sim.input(0), sim.state, { scope: "top", heads: ["h1", "h2"] });
      status = sim.frame(40).status;
      expect(status.get("h1")!.pan.layer).to.equal("rest");
      expect(status.get("h2")!.pan.layer).to.equal("rest");
      expect(status.get("h2")!.released).to.deep.equal(["look:a#1"]);
    });

    it("a stronger look on one head does not release a Panic hold on another", () => {
      const sim = new Sim({ heads: ["h1", "h2"], settings: { moveFade: SEC(0) } });
      sim.claims = [look("a", 1, ["h1", "h2"], { pan: 0.8, tilt: 0.8 })];
      sim.frame(0);
      sim.claims = [look("a", 1, ["h1"], { pan: 0.8, tilt: 0.8 })];
      sim.state = holdMotion(sim.input(20), sim.state, ["h2"]);
      sim.frame(20);
      sim.state = releaseMotion(sim.input(40), sim.state, { scope: "top", heads: ["h1", "h2"] });
      let status = sim.frame(40).status;
      expect(status.get("h1")!.pan.layer).to.equal("rest");
      expect(status.get("h2")!.pan.layer).to.equal("hold");
      sim.state = releaseMotion(sim.input(60), sim.state, { scope: "top", heads: ["h1", "h2"] });
      status = sim.frame(60).status;
      expect(status.get("h2")!.pan.layer).to.equal("rest");
    });

    it("a hard lock anywhere in the target is the strongest layer and releases nothing", () => {
      const sim = new Sim({ heads: ["h1", "h2"], lock: (head) => (head === "h1" ? "hard" : "off"), settings: { moveFade: SEC(0) } });
      sim.claims = [manual(1, ["h1", "h2"], { pan: 0.9, tilt: 0.9 })];
      sim.frame(0);
      sim.state = releaseMotion(sim.input(0), sim.state, { scope: "top", heads: ["h1", "h2"] });
      const status = sim.frame(20).status;
      expect(status.get("h1")!.released).to.deep.equal([]);
      expect(status.get("h2")!.released).to.deep.equal([]);
      expect(status.get("h2")!.pan.layer).to.equal("manual");
    });

    it("releases one head only, or every head", () => {
      const sim = new Sim({ heads: ["h1", "h2"], settings: { moveFade: SEC(0) } });
      sim.claims = [manual(1, ["h1", "h2"], { pan: 0.9, tilt: 0.9 })];
      sim.frame(0);
      sim.state = releaseMotion(sim.input(0), sim.state, { scope: "top", heads: ["h2"] });
      let r = sim.frame(20);
      expect(r.positions.get("h1")!.pan).to.equal(0.9);
      expect(r.positions.get("h2")).to.deep.equal(CENTRE);
      sim.state = releaseMotion(sim.input(0), sim.state, { scope: "top" });
      r = sim.frame(40);
      expect(r.positions.get("h1")).to.deep.equal(CENTRE);
    });

    it("home releases every layer: the head glides to its rest position", () => {
      const sim = new Sim({ settings: { moveFade: SEC(1), rest: { h1: { pan: 0, tilt: 0.5 } } } });
      sim.claims = [look("a", 1, ["h1"], { pan: 1, tilt: 0.5 }, SEC(0)), manual(2, ["h1"], { pan: 1, tilt: 0.5 })];
      sim.at(0);
      sim.state = releaseMotion(sim.input(0), sim.state, { scope: "all" });
      sim.at(20);
      expect(sim.at(520).pan).to.be.closeTo(0.5, 1e-9);
      expect(sim.at(1020).pan).to.equal(0);
    });

    it("does not release a lock", () => {
      const sim = new Sim({ lock: () => "hard" });
      sim.claims = [manual(1, ["h1"], { pan: 1, tilt: 1 })];
      sim.at(0);
      sim.state = releaseMotion(sim.input(0), sim.state, { scope: "all" });
      expect(sim.at(20)).to.deep.equal(CENTRE);
      expect(sim.last.status.get("h1")!.pan.layer).to.equal("lock");
    });
  });

  describe("Panic (Q4, R10)", () => {
    it("moves nothing by itself: the heads hold where they are", () => {
      const sim = new Sim({ settings: { moveFade: SEC(1) } });
      sim.claims = [look("a", 1, ["h1"], { pan: 0.9, tilt: 0.1 }, SEC(0))];
      sim.at(0);
      sim.claims = []; // Panic stops the looks and releases the manual positions…
      sim.state = holdMotion(sim.input(0), sim.state, ["h1"]); // …and holds the heads
      for (const p of sim.run(20, 3000)) expect(p).to.deep.equal({ pan: 0.9, tilt: 0.1 });
      expect(sim.last.status.get("h1")!.pan).to.include({ layer: "hold", owner: null });
    });

    it("holds even while a stopped look still claims the head during its fade-out", () => {
      const sim = new Sim({ settings: { moveFade: SEC(1) } });
      const fading = { ...look("a", 1, ["h1"], { pan: 0.9, tilt: 0.1 }, SEC(0)), shape: { move: MoveSchema.parse({ shape: "pan", size: { pan: 0.05, tilt: 0 } }), cycles: 0 } };
      sim.claims = [fading];
      const at0 = sim.at(0);
      sim.state = holdMotion(sim.input(0), sim.state, ["h1"]);
      for (let t = 20; t <= 400; t += FRAME) {
        sim.claims = [{ ...fading, shape: { ...fading.shape, cycles: t / 1000 } }]; // still turning, for one more fade
        expect(sim.at(t)).to.deep.equal(at0);
      }
      sim.claims = [];
      expect(sim.at(420)).to.deep.equal(at0);
      expect(sim.last.status.get("h1")!.pan.layer).to.equal("hold");
    });

    it("a rescue snapshot carrying motion glides in; once released later, the head goes to rest", () => {
      const sim = new Sim({ settings: { moveFade: SEC(1) } });
      sim.claims = [look("a", 1, ["h1"], { pan: 0.9, tilt: 0.5 }, SEC(0))];
      sim.at(0);
      sim.state = holdMotion(sim.input(0), sim.state, ["h1"]);
      sim.claims = [look("rescue", 2, ["h1"], { pan: 0.5, tilt: 0.5 })];
      sim.at(20);
      expect(sim.at(520).pan).to.be.closeTo(0.7, 1e-9);
      sim.at(1020);
      sim.claims = [look("x", 3, ["h1"], { pan: 0.1, tilt: 0.5 }, SEC(0))];
      sim.at(1040);
      sim.claims = [];
      sim.at(1060);
      expect(sim.at(2060)).to.deep.equal(CENTRE); // the hold was taken by a claim, it no longer latches
    });

    it("releasing the hold sends the head to rest", () => {
      const sim = new Sim({ settings: { moveFade: SEC(0) } });
      sim.claims = [look("a", 1, ["h1"], { pan: 0.9, tilt: 0.1 })];
      sim.at(0);
      sim.claims = [];
      sim.state = holdMotion(sim.input(0), sim.state, ["h1"]);
      expect(sim.at(20).pan).to.equal(0.9);
      sim.state = releaseMotion(sim.input(40), sim.state, { scope: "top" });
      expect(sim.at(40)).to.deep.equal(CENTRE);
    });
  });

  describe("held values (M1)", () => {
    it("a lock freezes the position sent on its first frame, even if what is sent drifts afterwards", () => {
      let drift = 0;
      const guard = (_h: string, asked: Position): Position => ({ pan: asked.pan + drift, tilt: asked.tilt });
      let lock: LockLevel = "off";
      const sim = new Sim({ lock: () => lock, guard, settings: { moveFade: SEC(0) } });
      sim.claims = [look("a", 1, ["h1"], { pan: 0.3, tilt: 0.3 })];
      sim.at(0);
      lock = "hard";
      expect(sim.at(20).pan).to.equal(0.3);
      drift = 0.01; // the console or a rule moves what is sent
      for (let t = 40; t < 400; t += FRAME) expect(sim.at(t).pan).to.be.closeTo(0.3, 1e-12);
    });

    it("a Panic hold is frozen the same way", () => {
      const guard = (_h: string, asked: Position): Position => ({ pan: asked.pan + 0.01, tilt: asked.tilt });
      const sim = new Sim({ guard, settings: { moveFade: SEC(0) } });
      sim.claims = [look("a", 1, ["h1"], { pan: 0.3, tilt: 0.3 })];
      sim.at(0);
      sim.claims = [];
      sim.state = holdMotion(sim.input(20), sim.state, ["h1"]);
      const held = sim.at(20).pan; // sent on the previous frame: 0.31
      expect(held).to.be.closeTo(0.31, 1e-12);
      for (let t = 40; t < 400; t += FRAME) expect(sim.at(t).pan).to.equal(held);
    });
  });

  describe("release under a lock (I1)", () => {
    it("a hard lock releases nothing: the claims it hides are kept", () => {
      let lock: LockLevel = "hard";
      const sim = new Sim({ lock: () => lock, settings: { moveFade: SEC(0) } });
      sim.claims = [look("a", 1, ["h1"], { pan: 0.1, tilt: 0.1 }), manual(2, ["h1"], { pan: 0.9, tilt: 0.9 })];
      sim.at(0);
      sim.state = releaseMotion(sim.input(0), sim.state, { scope: "all" });
      sim.at(20);
      expect(sim.last.status.get("h1")!.released).to.deep.equal([]);
      lock = "off";
      expect(sim.at(40).pan).to.equal(0.9);
    });

    it("a soft lock releases the manual layer only", () => {
      let lock: LockLevel = "soft";
      const sim = new Sim({ lock: () => lock, settings: { moveFade: SEC(0) } });
      sim.claims = [look("a", 1, ["h1"], { pan: 0.1, tilt: 0.1 }), manual(2, ["h1"], { pan: 0.9, tilt: 0.9 })];
      sim.at(0);
      sim.state = releaseMotion(sim.input(0), sim.state, { scope: "top" });
      expect(sim.at(20).pan).to.equal(0.9); // the manual released: frozen where it was by the lock
      expect(sim.last.status.get("h1")!.released).to.deep.equal(["manual#2"]);
      sim.state = releaseMotion(sim.input(0), sim.state, { scope: "all" });
      expect(sim.last.status.get("h1")!.pan.layer).to.equal("lock");
      lock = "off";
      expect(sim.at(40).pan).to.equal(0.1); // the look under the lock was not eaten
    });
  });

  describe("inputs out of their range (I4)", () => {
    it("ignores a non-finite sent position, a NaN time, and a rest outside the travel", () => {
      const sim = new Sim({ settings: { moveFade: SEC(1), rest: { h1: { pan: Number.NaN, tilt: 1.7 } } } });
      expect(sim.at(0)).to.deep.equal({ pan: 0.5, tilt: 1 });
      sim.sent = new Map([["h1", { pan: Number.NaN, tilt: Number.POSITIVE_INFINITY }]]);
      expect(sim.at(20)).to.deep.equal({ pan: 0.5, tilt: 1 });
      sim.claims = [look("a", 1, ["h1"], { pan: 1, tilt: 1 })];
      sim.at(40);
      const r = sim.frame(Number.NaN); // treated as the last frame's time
      expect(r.positions.get("h1")!.pan).to.equal(0.5);
      expect(sim.at(540).pan).to.be.closeTo(0.75, 1e-9);
    });

    it("a non-finite duration is a cut", () => {
      expect(motionDurationMs({ seconds: Number.NaN }, 120)).to.equal(0);
      expect(motionDurationMs({ beats: Number.POSITIVE_INFINITY }, 120)).to.equal(0);
    });
  });

  describe("purity (strictBounds samples future frames)", () => {
    it("never mutates the state it is given: the same input gives the same output", () => {
      const sim = new Sim({ settings: { moveFade: SEC(1) } });
      sim.at(0);
      sim.claims = [look("a", 1, ["h1"], { pan: 1, tilt: 1 })];
      sim.at(20);
      const before = JSON.stringify([...sim.state.heads]);
      const input = sim.input(400);
      const first = resolveMotion(input, sim.state);
      for (let t = 400; t < 2000; t += 50) resolveMotion({ ...input, now: t, claims: [] }, sim.state); // sampling « à blanc »
      expect(JSON.stringify([...sim.state.heads])).to.equal(before);
      expect(resolveMotion(input, sim.state).positions).to.deep.equal(first.positions);
    });

    it("is total: a position for every head, claimed or not", () => {
      const r = resolveMotion({ heads: ["a", "b", "c"], claims: [look("x", 1, ["b"], { pan: 0 })], now: 0, bpm: 120 }, emptyMotionState());
      expect([...r.positions.keys()]).to.deep.equal(["a", "b", "c"]);
      expect([...r.status.keys()]).to.deep.equal(["a", "b", "c"]);
    });
  });

  describe("continuity (property)", () => {
    it("random launches, stops, releases and relaunches never move a head more than the steepest glide per 20 ms frame", () => {
      for (let seed = 1; seed <= 60; seed++) {
        const r = rng(seed);
        const minFade = 300;
        const heads = ["h1", "h2", "h3"];
        const settings: MotionSettings = { moveFade: { beats: 1 + r() * 3 } }; // ≥ 1 beat at 180 BPM = 333 ms
        const ctx: MotionContext = { aim: (h) => (h === "h3" ? null : { pan: 0.2, tilt: h === "h1" ? 0.9 : 0.4 }) };
        const sim = new Sim({ heads, bpm: 60 + r() * 120, settings, ctx });
        let order = 0;
        const steps: Map<string, Position[]> = new Map(heads.map((h) => [h, []]));
        const statuses: Map<string, HeadStatus[]> = new Map(heads.map((h) => [h, []]));
        const cutAt = new Set<string>(); // frame:head where a newer claim took heads with a fade of 0
        for (let t = 0; t < 8000; t += FRAME) {
          if (r() < 0.04) {
            const ev = r();
            const hs = heads.filter(() => r() < 0.6);
            const at = () => ({ pan: r(), tilt: r() });
            if (ev < 0.25) sim.claims.push(look(`l${Math.floor(r() * 4)}`, ++order, hs, at(), SEC(minFade / 1000 + r() * 2)));
            else if (ev < 0.35) {
              sim.claims.push(look(`cut${Math.floor(r() * 2)}`, ++order, hs, at(), SEC(0)));
              for (const h of hs) cutAt.add(`${t / FRAME}:${h}`);
            }
            else if (ev < 0.55) sim.claims.splice(Math.floor(r() * sim.claims.length), 1);
            else if (ev < 0.65) sim.claims.push({ ...target(`t${Math.floor(r() * 2)}`, ++order, hs), fade: SEC(minFade / 1000 + r()) });
            else if (ev < 0.75) sim.claims.push({ ...look("named", ++order, hs, at()), owner: "manual", layer: "manual" }); // a recall: glides with the default
            else if (ev < 0.85) sim.state = releaseMotion(sim.input(t), sim.state, { scope: r() < 0.5 ? "top" : "all", heads: hs });
            else if (ev < 0.9) sim.state = holdMotion(sim.input(0), sim.state, hs);
            else if (ev < 0.95) sim.bpm = 60 + r() * 120;
            else settings.rest = Object.fromEntries(hs.map((h) => [h, at()]));
          }
          const res = sim.frame(t);
          for (const h of heads) {
            steps.get(h)!.push(res.positions.get(h)!);
            statuses.get(h)!.push(res.status.get(h)!);
          }
        }
        for (const h of heads) {
          const ps = steps.get(h)!;
          for (const p of ps) {
            expect(p.pan).to.be.within(0, 1);
            expect(p.tilt).to.be.within(0, 1);
          }
          // no jump except a newer claim taking the head with a fade of 0; a glide leaving at the speed
          // the head had is at most 3 × gap / duration steep (hermite.ts, maxStartSpeed)
          // the interval a transition must stay in: [where it started, the target it was heading for, its own target]
          const first = statuses.get(h)![0]!;
          const hulls = { pan: [ps[0]!.pan, first.pan.target ?? ps[0]!.pan, CENTRE.pan], tilt: [ps[0]!.tilt, first.tilt.target ?? ps[0]!.tilt, CENTRE.tilt] };
          for (let i = 1; i < ps.length; i++) {
            const before = statuses.get(h)![i - 1]!;
            const after = statuses.get(h)![i]!;
            for (const axis of AXES) {
              const was = ps[i - 1]![axis];
              const a = after[axis];
              const b = before[axis];
              // a new owner or a moved target starts a new transition from where the head was
              if (a.layer !== b.layer || a.owner !== b.owner || a.target !== b.target) hulls[axis] = [was, b.target ?? was, a.target ?? was];
              const hull = hulls[axis];
              expect(ps[i]![axis], `seed ${seed}, ${h}, frame ${i}, ${axis}`).to.be.within(Math.min(...hull) - 1e-9, Math.max(...hull) + 1e-9);
            }
            if (cutAt.has(`${i}:${h}`)) continue;
            const d = Math.max(Math.abs(ps[i]!.pan - ps[i - 1]!.pan), Math.abs(ps[i]!.tilt - ps[i - 1]!.tilt));
            expect(d, `seed ${seed}, ${h}, frame ${i}`).to.be.at.most(2 * bound(1, minFade));
          }
        }
      }
    });
  });
});
