/**
 * The motion layer (docs/specs/engine-effects-timing.md, « Couche Mouvement », T25): one place that says,
 * for each moving head and each axis, who may place it, where it goes and how it gets there.
 *
 * - **Who**: a fixed stack, strongest first — hard lock, manual, soft lock, target, looks, then the
 *   bottom (rest, or hold after a Panic). Inside a layer the claim launched last wins. Resolved per axis:
 *   a claim may give only the pan or only the tilt, the other axis comes from below.
 * - **Where**: the winning claim gives a logical position (0..1 of the travel, 0.5 = centre): a fixed
 *   base, a named position (T32), a 3D point aimed per head (T24, T27), plus an optional Move FX shape
 *   around that base. A head nobody claims glides to its **rest** position (set per head in the show,
 *   centre by default). A claim that cannot place a head (point out of reach, unknown position) keeps it
 *   where it is: it does not fall through to the layer below (R14).
 * - **How**: whenever the owner of an axis changes, the axis glides from the position really sent
 *   (read back after the guard) to the new owner's, never a jump: smoothstep over a duration fixed when
 *   the transition starts. A relaunch mid-transition restarts from where the head is.
 *
 * Pure: no clock, no venue. The caller gives the time, the tempo and what was sent; `resolveMotion`
 * never mutates its state, it returns the next one (sampling future frames, `strictBounds`, must not
 * change anything: only the real render keeps `next`).
 */
import { ease } from "./player.js";
import { movePosition, type Move, type Position } from "./move.js";

export type Axis = "pan" | "tilt";
export const AXES: readonly Axis[] = ["pan", "tilt"];

/** The layers a claim belongs to, strongest first. A named position recalled directly (T32) is manual. */
export type MotionLayer = "manual" | "target" | "look";
/** Who holds an axis: a claim layer, a lock (T26), the hold left by a Panic, or the head's rest position. */
export type AxisLayer = "lock" | MotionLayer | "hold" | "rest";
export type LockLevel = "off" | "soft" | "hard";
/** What an axis does when its owner changes (T5 « Pistes fondables », `ResolvedTracks.motion`). */
export type AxisMode = "glide" | "cut";

/**
 * How long a head takes to reach a new owner's position: beats at the current tempo or fixed seconds
 * (the shape of a step's `every`, zero allowed; milliseconds are a display unit, stored as seconds). 0 = cut.
 */
export type MotionDuration = { beats: number } | { seconds: number };

/** The show's `moveFade` when it sets none. */
export const DEFAULT_MOVE_FADE: MotionDuration = { seconds: 1 };
/** Tempo used to turn beats into time when none is known (a non-positive or non-finite BPM). */
export const FALLBACK_BPM = 120;
export const CENTRE: Readonly<Position> = { pan: 0.5, tilt: 0.5 };

/**
 * Milliseconds for a duration at `bpm`. Read once, when a transition starts: a tempo change during a
 * transition does not stretch it (a head never speeds up or turns back because the tempo moved).
 */
export function motionDurationMs(d: MotionDuration, bpm: number): number {
  if ("seconds" in d) return Math.max(0, d.seconds * 1000);
  const tempo = Number.isFinite(bpm) && bpm > 0 ? bpm : FALLBACK_BPM;
  return Math.max(0, (d.beats * 60_000) / tempo);
}

/** Where a claim centres its heads. */
export type MotionBase =
  /** Normalised; one axis alone claims that axis only (a raw pan or tilt channel of an imported scene, a MIDI CC). */
  | { kind: "fixed"; pan?: number; tilt?: number }
  /** A named position (T32), resolved per head through `ctx.presetOf`. */
  | { kind: "preset"; id: string }
  /** A 3D point (T24 target, T27 zone), aimed per head through `ctx.aim`. */
  | { kind: "point"; x: number; y: number; z: number };

/** A Move FX shape drawn around the base: `cycles` since the look started (the look's own cadence). */
export interface MotionShape {
  move: Move;
  cycles: number;
}

export interface MotionClaim {
  /**
   * "manual", "target:<id>", "look:<id>". A transition watches the owner **and** the order (`claimKey`):
   * the same claim moving (a shape turning, the pad followed) is no new transition, a relaunch is.
   */
  owner: string;
  layer: MotionLayer;
  /** Inside a layer, later wins: the launch order (a manual gesture, a look launch). */
  order: number;
  /** Heads claimed, in row order: index and count feed the shape (spread, fan, wings). */
  heads: readonly string[];
  /** Absent: the shape's own centre. A claim with neither base nor shape claims nothing. */
  base?: MotionBase;
  shape?: MotionShape;
  /** How this claim takes a head over; absent: the show's default. `{ seconds: 0 }` = direct (the pad follows the finger, R8). */
  fade?: MotionDuration;
}

/** What the layer does not store: named positions, targets and aiming stay in their own objects. */
export interface MotionContext {
  presetOf?: (id: string, head: string) => Position | undefined;
  /** Position aiming `head` at a point, or null when the point is out of the head's reach. */
  aim?: (head: string, point: { x: number; y: number; z: number }) => Position | null;
}

export interface MotionSettings {
  /** Default transition (show setting `moveFade`): a claim without its own (`look.move.fade ?? moveFade`), a release, a return to rest. */
  moveFade?: MotionDuration;
  /** Rest position per head (fixture id, set in the show); absent: the centre. */
  rest?: ReadonlyMap<string, Position>;
}

export interface MotionInput {
  /** Every installed moving head to resolve: the result is total, a position for each. */
  heads: readonly string[];
  claims: readonly MotionClaim[];
  /** Milliseconds. */
  now: number;
  bpm: number;
  /** The logical position really sent on the previous frame (read back after the guard). */
  sent?: ReadonlyMap<string, Position>;
  settings?: MotionSettings;
  ctx?: MotionContext;
  /** T26: "off" until the lock exists. */
  lock?: (head: string) => LockLevel;
  /** T5 tracks: an unticked axis cuts at a change of owner. Default: glide. */
  axisMode?: (head: string, axis: Axis) => AxisMode;
}

interface AxisState {
  owner: string;
  layer: AxisLayer;
  /** `rankOf` the owner: a change to a weaker owner is a release (the show's default duration). */
  rank: number;
  /** Last value resolved. */
  value: number;
  /** Transition: from `from` at `t0`, over `dur` ms (0: none). */
  from: number;
  t0: number;
  dur: number;
  /** Held value (lock, hold, or a claim in error). */
  held: number;
  error?: string;
}

interface HeadState {
  pan?: AxisState;
  tilt?: AxisState;
  /** Claims released on this head (`claimKey`): ignored until they stop claiming it. */
  released: readonly string[];
  /** Axes held where they are after a Panic, until a claim takes them. */
  holding: Readonly<Record<Axis, boolean>>;
}

/** Opaque per-head state carried from frame to frame. */
export interface MotionState {
  readonly heads: ReadonlyMap<string, HeadState>;
}

export const emptyMotionState = (): MotionState => ({ heads: new Map() });

export interface AxisStatus {
  layer: AxisLayer;
  /** The winning claim's owner; null for rest, hold and lock. */
  owner: string | null;
  position: number;
  /** A transition is running. */
  moving: boolean;
  /** Why the winning claim cannot place the head (the axis is held meanwhile). */
  error?: string;
}

export interface HeadStatus {
  pan: AxisStatus;
  tilt: AxisStatus;
  lock: LockLevel;
  /** Owners that claim the head but are beaten on both axes (« the look X would move it »). */
  masked: string[];
}

export interface MotionResult {
  positions: Map<string, Position>;
  status: Map<string, HeadStatus>;
  next: MotionState;
}

/** A claim's identity for a release: a relaunch (a new order) claims again. */
export const claimKey = (c: Pick<MotionClaim, "owner" | "order">): string => `${c.owner}#${c.order}`;

/** Strength of an axis owner: a hard lock is above the manual layer, a soft one below it. */
const rankOf = (layer: AxisLayer, lock: LockLevel): number =>
  layer === "lock" ? (lock === "hard" ? 0 : 2) : { manual: 1, target: 3, look: 4, hold: 5, rest: 6 }[layer];
const CLAIM_RANK: Record<MotionLayer, number> = { manual: 0, target: 1, look: 2 };
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const NO_HOLD: Readonly<Record<Axis, boolean>> = { pan: false, tilt: false };

function claimsAxis(c: MotionClaim, axis: Axis): boolean {
  if (c.shape) return true;
  if (!c.base) return false;
  return c.base.kind === "fixed" ? c.base[axis] !== undefined : true;
}

type Evaluated = { pos: Partial<Position> } | { error: string };

function evaluate(c: MotionClaim, head: string, ctx: MotionContext | undefined): Evaluated {
  let base: Partial<Position>;
  const b = c.base;
  if (!b) base = {};
  else if (b.kind === "fixed") base = { pan: b.pan, tilt: b.tilt };
  else if (b.kind === "preset") {
    const p = ctx?.presetOf?.(b.id, head);
    if (!p) return { error: `unknown position « ${b.id} »` };
    base = p;
  } else {
    const p = ctx?.aim?.(head, { x: b.x, y: b.y, z: b.z });
    if (!p) return { error: "point out of reach" };
    base = p;
  }
  let pos: Partial<Position> = base;
  if (c.shape) {
    const { move, cycles } = c.shape;
    const center = { pan: base.pan ?? move.center.pan, tilt: base.tilt ?? move.center.tilt };
    try {
      pos = movePosition({ ...move, center }, cycles, Math.max(0, c.heads.indexOf(head)), c.heads.length);
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }
  for (const axis of AXES) {
    const v = pos[axis];
    if (v !== undefined && !Number.isFinite(v)) return { error: `${axis} is not a number` };
  }
  return { pos: { pan: pos.pan === undefined ? undefined : clamp01(pos.pan), tilt: pos.tilt === undefined ? undefined : clamp01(pos.tilt) } };
}

/** Claims on `head`, strongest first; released ones left out. */
function contenders(claims: readonly MotionClaim[], head: string, released: ReadonlySet<string>): MotionClaim[] {
  const indexed = claims
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.heads.includes(head) && !released.has(claimKey(c)));
  indexed.sort((a, b) => CLAIM_RANK[a.c.layer] - CLAIM_RANK[b.c.layer] || b.c.order - a.c.order || b.i - a.i);
  return indexed.map(({ c }) => c);
}

function winnerOf(ranked: readonly MotionClaim[], axis: Axis, lock: LockLevel): MotionClaim | "lock" | undefined {
  if (lock === "hard") return "lock";
  const top = ranked.find((c) => claimsAxis(c, axis));
  if (lock === "soft" && top?.layer !== "manual") return "lock";
  return top;
}

/**
 * Resolve every head for one frame. Returns the positions to send, the status per head (why it is
 * there), and the next state. Never mutates `state`.
 */
export function resolveMotion(input: MotionInput, state: MotionState): MotionResult {
  const { now, ctx } = input;
  const moveFade = input.settings?.moveFade ?? DEFAULT_MOVE_FADE;
  const positions = new Map<string, Position>();
  const status = new Map<string, HeadStatus>();
  const nextHeads = new Map<string, HeadState>();

  for (const head of input.heads) {
    const prevHead = state.heads.get(head);
    const claimed = new Set(input.claims.filter((c) => c.heads.includes(head)).map(claimKey));
    const released = (prevHead?.released ?? []).filter((k) => claimed.has(k));
    const ranked = contenders(input.claims, head, new Set(released));
    const lock = input.lock?.(head) ?? "off";
    const rest = input.settings?.rest?.get(head) ?? CENTRE;
    const sent = input.sent?.get(head);
    const evaluated = new Map<MotionClaim, Evaluated>();
    const evalOf = (c: MotionClaim) => {
      let e = evaluated.get(c);
      if (!e) evaluated.set(c, (e = evaluate(c, head, ctx)));
      return e;
    };

    const holding = { ...(prevHead?.holding ?? NO_HOLD) };
    const next: HeadState = { released, holding };
    const winners = new Set<MotionClaim>();
    const axisStatus = {} as Record<Axis, AxisStatus>;
    const pos = {} as Position;

    for (const axis of AXES) {
      const prev = prevHead?.[axis];
      const current = sent?.[axis] ?? prev?.value ?? rest[axis];
      const w = winnerOf(ranked, axis, lock);
      let layer: AxisLayer;
      let owner: string;
      let target: number | undefined;
      let error: string | undefined;
      if (w === "lock") {
        layer = "lock";
        owner = "lock";
      } else if (w) {
        winners.add(w);
        holding[axis] = false;
        layer = w.layer;
        owner = claimKey(w); // a relaunch is a new owner: a shape restarting from its first cycle glides there
        const e = evalOf(w);
        if ("error" in e) error = e.error;
        else target = e.pos[axis];
      } else if (holding[axis]) {
        layer = "hold";
        owner = "hold";
      } else {
        layer = "rest";
        owner = `rest:${rest[axis]}`; // a rest position changed in the show is a new owner: the head glides there
        target = rest[axis];
      }

      const rank = rankOf(layer, lock);
      let s: AxisState;
      const changed = !prev || prev.owner !== owner;
      if (target === undefined) {
        // lock, hold, or a claim that cannot place the head: stay where it is
        s = changed || !prev || prev.error === undefined ? { owner, layer, rank, value: current, from: current, t0: now, dur: 0, held: current, error } : { ...prev, layer, rank, error };
        s.value = s.held;
      } else {
        if (changed || prev.error !== undefined) {
          // a new owner (or a claim back in reach): glide from what was really sent
          const releasing = prev !== undefined && prev.rank < rank;
          const d = w && w !== "lock" && !releasing ? (w.fade ?? moveFade) : moveFade;
          const cut = input.axisMode?.(head, axis) === "cut";
          s = { owner, layer, rank, value: current, from: current, t0: now, dur: cut ? 0 : motionDurationMs(d, input.bpm), held: current };
        } else s = { ...prev, layer, rank };
        const p = s.dur > 0 ? clamp01((now - s.t0) / s.dur) : 1;
        s.value = p >= 1 ? target : s.from + (target - s.from) * ease(p);
        if (p >= 1) s.dur = 0;
      }
      next[axis] = s;
      pos[axis] = s.value;
      axisStatus[axis] = {
        layer,
        owner: w && w !== "lock" ? w.owner : null,
        position: s.value,
        moving: s.dur > 0 && s.value !== target,
        ...(error === undefined ? {} : { error }),
      };
    }

    const winning = new Set([...winners].map((c) => c.owner));
    const masked = [...new Set(ranked.filter((c) => AXES.some((a) => claimsAxis(c, a))).map((c) => c.owner))].filter((o) => !winning.has(o));
    positions.set(head, pos);
    status.set(head, { pan: axisStatus.pan, tilt: axisStatus.tilt, lock, masked });
    nextHeads.set(head, next);
  }
  return { positions, status, next: { heads: nextHeads } };
}

export interface ReleaseOptions {
  /** Heads to release; absent: every head of the input. */
  heads?: readonly string[];
  /**
   * "top": the claims that win the head now are released, the layer below takes over (« rendre la
   * main », per head or for all). "all": every claim on the head is released, it glides to rest
   * (`position.home`).
   */
  scope: "top" | "all";
}

/**
 * Release what holds heads: the released claims are ignored on those heads until they stop claiming
 * them (a look relaunched has a new order and claims again). A Panic hold is released too. Locks are
 * not released here (T26 unlocks). The heads then glide to their new owner on the next frame.
 */
export function releaseMotion(input: Pick<MotionInput, "heads" | "claims" | "lock">, state: MotionState, opts: ReleaseOptions): MotionState {
  const heads = new Map(state.heads);
  for (const head of opts.heads ?? input.heads) {
    const prev = heads.get(head);
    const released = new Set(prev?.released ?? []);
    const ranked = contenders(input.claims, head, released);
    if (opts.scope === "all") for (const c of ranked) released.add(claimKey(c));
    else
      for (const axis of AXES) {
        const w = winnerOf(ranked, axis, "off");
        if (w && w !== "lock") released.add(claimKey(w));
      }
    heads.set(head, { ...prev, released: [...released], holding: NO_HOLD });
  }
  return { heads };
}

/**
 * Panic (R10): nothing moves by itself. Every axis of these heads holds where it is until a claim
 * takes it (a rescue snapshot carrying motion glides in); without one, it never returns to rest
 * on its own.
 */
export function holdMotion(state: MotionState, heads: readonly string[]): MotionState {
  const next = new Map(state.heads);
  for (const head of heads) {
    const prev = next.get(head);
    next.set(head, { ...prev, released: prev?.released ?? [], holding: { pan: true, tilt: true } });
  }
  return { heads: next };
}
