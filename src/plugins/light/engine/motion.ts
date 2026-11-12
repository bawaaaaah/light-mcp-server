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
 *   (read back after the guard) to the new owner's, never a jump: a cubic leaving at the speed the head
 *   had and landing at rest (engine/hermite.ts), over a duration fixed when the transition starts.
 *
 * Pure: no clock, no venue. The caller gives the time, the tempo and what was sent; `resolveMotion`
 * never mutates its state, it returns the next one (sampling future frames, `strictBounds`, must not
 * change anything: only the real render keeps `next`).
 */
import { hermiteAt, maxStartSpeed } from "./hermite.js";
import { DEFAULT_MOVE_FADE, movePosition, type Move, type MoveFade, type Position } from "./move.js";

export type Axis = "pan" | "tilt";
export const AXES: readonly Axis[] = ["pan", "tilt"];

/** The layers a claim belongs to, strongest first. A named position recalled directly (T32) is manual. */
export type MotionLayer = "manual" | "target" | "look";
/** Who holds an axis: a claim layer, a lock (T26), the hold left by a Panic, or the head's rest position. */
export type AxisLayer = "lock" | MotionLayer | "hold" | "rest";
export type LockLevel = "off" | "soft" | "hard";
/** What an axis does when its owner changes (T5 « Pistes fondables », `ResolvedTracks.motion`). */
export type AxisMode = "glide" | "cut";

/** Tempo used to turn beats into time when none is known (a non-positive or non-finite BPM). */
export const FALLBACK_BPM = 120;
export const CENTRE: Readonly<Position> = { pan: 0.5, tilt: 0.5 };

/**
 * Milliseconds for a `MoveFade` at `bpm`. Read once, when a transition starts: a tempo change during a
 * transition does not stretch it (a head never speeds up or turns back because the tempo moved).
 * A negative or non-finite duration is a cut.
 */
export function motionDurationMs(d: MoveFade, bpm: number): number {
  const tempo = Number.isFinite(bpm) && bpm > 0 ? bpm : FALLBACK_BPM;
  const ms = "seconds" in d ? d.seconds * 1000 : (d.beats * 60_000) / tempo;
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
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
  /** Inside a layer, later wins: the launch order (a look launch, a manual command — one counter). */
  order: number;
  /** Heads claimed, in row order: index and count feed the shape (spread, fan, wings). */
  heads: readonly string[];
  /** Absent: the shape's own centre. A claim with neither base nor shape claims nothing. */
  base?: MotionBase;
  shape?: MotionShape;
  /** How this claim takes a head over (`look.move.fade`); absent: `moveFade`. `{ seconds: 0 }` = direct (the pad, R8). */
  fade?: MoveFade;
}

/** What the layer does not store: named positions, targets and aiming stay in their own objects. */
export interface MotionContext {
  presetOf?: (id: string, head: string) => Position | undefined;
  /** Position aiming `head` at a point, or null when the point is out of the head's reach. */
  aim?: (head: string, point: { x: number; y: number; z: number }) => Position | null;
}

export interface MotionSettings {
  /** Show setting `moveFade`: a claim without its own fade, a release, a return to rest. Absent: 1 s. */
  moveFade?: MoveFade;
  /** Show setting `restPositions`, passed as is: rest position per fixture id; absent: the centre. */
  rest?: Readonly<Record<string, Position>>;
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
  /** The winning claim's launch order (0 without one): handing back to an older claim of the same layer is a release. */
  order: number;
  /** Last value resolved, at `t`, moving at `v` (per ms). */
  value: number;
  t: number;
  v: number;
  /** Transition: from `from` at `t0` over `dur` ms (0: none), leaving at speed `v0`. */
  from: number;
  t0: number;
  dur: number;
  v0: number;
  /** Held value (lock, hold, or a claim in error): frozen at the first held frame. */
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
  /** Time of the last frame resolved: a non-finite `now` falls back to it. */
  readonly now?: number;
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
  /** Claims released on this head (`claimKey`), ignored until they stop claiming it. */
  released: string[];
}

export interface MotionResult {
  positions: Map<string, Position>;
  status: Map<string, HeadStatus>;
  next: MotionState;
}

/** A claim's identity for a release: a relaunch (a new order) claims again. */
export const claimKey = (c: Pick<MotionClaim, "owner" | "order">): string => `${c.owner}#${c.order}`;

const OWNER_RANK: Record<Exclude<AxisLayer, "lock">, number> = { manual: 1, target: 3, look: 4, hold: 5, rest: 6 };
/** Strength of an axis owner: a hard lock is above the manual layer, a soft one below it. */
const rankOf = (layer: AxisLayer, lock: LockLevel): number => (layer === "lock" ? (lock === "hard" ? 0 : 2) : OWNER_RANK[layer]);
const CLAIM_RANK: Record<MotionLayer, number> = { manual: 0, target: 1, look: 2 };
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const NO_HOLD: Readonly<Record<Axis, boolean>> = { pan: false, tilt: false };
/** Beyond this gap between two frames, a transition starts at the new frame rather than at the previous one. */
const MAX_FRAME_GAP = 100;
const finite = (v: number | undefined): v is number => v !== undefined && Number.isFinite(v);

function claimsAxis(c: MotionClaim, axis: Axis): boolean {
  if (c.shape) return true;
  if (!c.base) return false;
  return c.base.kind === "fixed" ? c.base[axis] !== undefined : true;
}
const claimsAny = (c: MotionClaim) => AXES.some((a) => claimsAxis(c, a));

/** Rest position of a head: the show's, bounded to the travel, else the centre. */
function restOf(settings: MotionSettings | undefined, head: string): Position {
  const r = settings?.rest && Object.hasOwn(settings.rest, head) ? settings.rest[head] : undefined;
  return {
    pan: finite(r?.pan) ? clamp01(r.pan) : CENTRE.pan,
    tilt: finite(r?.tilt) ? clamp01(r.tilt) : CENTRE.tilt,
  };
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
  const out: Partial<Position> = {};
  for (const axis of AXES) {
    const v = pos[axis];
    if (v === undefined) continue;
    if (!Number.isFinite(v)) return { error: `${axis} is not a number` };
    out[axis] = clamp01(v);
  }
  return { pos: out };
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

/** Who holds one axis this frame, and where it asks the head to be (undefined: stay where it is). */
interface Owner {
  layer: AxisLayer;
  owner: string;
  claim?: MotionClaim;
  target?: number;
  error?: string;
}

function ownerOf(w: MotionClaim | "lock" | undefined, axis: Axis, holding: boolean, rest: Position, evalOf: (c: MotionClaim) => Evaluated): Owner {
  if (w === "lock") return { layer: "lock", owner: "lock" };
  if (w) {
    // a relaunch is a new owner: a shape restarting from its first cycle glides there
    const e = evalOf(w);
    const base = { layer: w.layer, owner: claimKey(w), claim: w };
    return "error" in e ? { ...base, error: e.error } : { ...base, target: e.pos[axis] };
  }
  if (holding) return { layer: "hold", owner: "hold" };
  // a rest position changed in the show is a new owner: the head glides there
  return { layer: "rest", owner: `rest:${rest[axis]}`, target: rest[axis] };
}

interface AxisFrame {
  prev: AxisState | undefined;
  /** Where the head is: sent on the previous frame, else the last value resolved, else its rest. */
  current: number;
  now: number;
  rank: number;
  moveFade: MoveFade;
  bpm: number;
  cut: boolean;
}

/** One axis, one frame: keep, hold or start a transition, then the value at `now`. */
function stepAxis(o: Owner, f: AxisFrame): AxisState {
  const { prev, current, now, rank } = f;
  const changed = !prev || prev.owner !== o.owner;
  const order = o.claim?.order ?? 0;
  const v = prev && now > prev.t ? prev.v : 0;
  const fresh = { owner: o.owner, layer: o.layer, rank, order, value: current, t: now, v, from: current, t0: now, dur: 0, v0: 0, held: current };
  let s: AxisState;
  let cut = false;
  if (o.target === undefined) {
    // lock, hold, or a claim that cannot place the head: frozen where it was on the first held frame
    const entering = changed || (o.error !== undefined && prev.error === undefined);
    s = entering ? { ...fresh, error: o.error } : { ...prev, layer: o.layer, rank, order, error: o.error };
    s.value = s.held;
  } else {
    if (changed || prev.error !== undefined) {
      // a new owner (or a claim back in reach): glide from what was really sent, at the speed it had
      const releasing = prev !== undefined && (prev.rank < rank || (prev.rank === rank && order < prev.order));
      const fade = o.claim && !releasing ? (o.claim.fade ?? f.moveFade) : f.moveFade;
      const dur = f.cut ? 0 : motionDurationMs(fade, f.bpm);
      const vmax = maxStartSpeed(o.target - current, dur);
      const v0 = Math.sign(v) * Math.min(Math.abs(v), vmax);
      // a moving head keeps its pace: its curve starts when the position it leaves from was sent
      const t0 = v0 !== 0 && prev && now - prev.t <= MAX_FRAME_GAP ? prev.t : now;
      s = { ...fresh, t0, dur, v0 };
      cut = dur === 0;
    } else s = { ...prev, layer: o.layer, rank, order };
    const arrived = s.dur <= 0 || now - s.t0 >= s.dur;
    s.value = arrived ? o.target : clamp01(hermiteAt({ from: s.from, to: o.target, start: s.t0, duration: s.dur, v0: s.v0 }, now));
    if (arrived) s.dur = 0;
  }
  // the speed the head has (a cut or a held axis has none): the next transition leaves at it
  if (cut || o.target === undefined) s.v = 0;
  else if (prev && now > prev.t) s.v = (s.value - prev.value) / (now - prev.t);
  s.t = now;
  return s;
}

/**
 * Resolve every head for one frame. Returns the positions to send, the status per head (why it is
 * there), and the next state. Never mutates `state`.
 */
export function resolveMotion(input: MotionInput, state: MotionState): MotionResult {
  const now = Number.isFinite(input.now) ? input.now : (state.now ?? 0);
  const { ctx } = input;
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
    const rest = restOf(input.settings, head);
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
      const w = winnerOf(ranked, axis, lock);
      if (w && w !== "lock") {
        winners.add(w);
        holding[axis] = false;
      }
      const o = ownerOf(w, axis, holding[axis], rest, evalOf);
      const sentAxis = sent?.[axis];
      const current = finite(sentAxis) ? clamp01(sentAxis) : (prev?.value ?? rest[axis]);
      const cut = input.axisMode?.(head, axis) === "cut";
      const s = stepAxis(o, { prev, current, now, rank: rankOf(o.layer, lock), moveFade, bpm: input.bpm, cut });
      next[axis] = s;
      pos[axis] = s.value;
      axisStatus[axis] = {
        layer: o.layer,
        owner: o.claim?.owner ?? null,
        position: s.value,
        moving: s.dur > 0 && s.value !== o.target,
        ...(o.error === undefined ? {} : { error: o.error }),
      };
    }

    const winning = new Set([...winners].map((c) => c.owner));
    const masked = [...new Set(ranked.filter(claimsAny).map((c) => c.owner))].filter((o) => !winning.has(o));
    positions.set(head, pos);
    status.set(head, { pan: axisStatus.pan, tilt: axisStatus.tilt, lock, masked, released: [...released] });
    nextHeads.set(head, next);
  }
  return { positions, status, next: { heads: nextHeads, now } };
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

/** The claims a release may take off `head` under its lock: none under a hard lock, the manual layer only under a soft one. */
function releasable(ranked: readonly MotionClaim[], lock: LockLevel, scope: "top" | "all"): readonly MotionClaim[] {
  if (lock === "hard") return [];
  const open = lock === "soft" ? ranked.filter((c) => c.layer === "manual") : ranked;
  if (scope === "all") return open;
  const out: MotionClaim[] = [];
  for (const axis of AXES) {
    const w = open.find((c) => claimsAxis(c, axis));
    if (w) out.push(w);
  }
  return out;
}

/**
 * Release what holds heads: the released claims are ignored on those heads until they stop claiming
 * them (a look relaunched has a new order and claims again). A Panic hold is released too, unless a
 * lock covers the head. A lock is never released here (T26 unlocks): under a hard lock nothing is,
 * under a soft one only the manual layer — the claims the lock hides are kept. The heads then glide
 * to their new owner on the next frame.
 */
export function releaseMotion(input: Pick<MotionInput, "heads" | "claims" | "lock">, state: MotionState, opts: ReleaseOptions): MotionState {
  const heads = new Map(state.heads);
  for (const head of opts.heads ?? input.heads) {
    const prev = heads.get(head);
    const lock = input.lock?.(head) ?? "off";
    const released = new Set(prev?.released ?? []);
    for (const c of releasable(contenders(input.claims, head, released), lock, opts.scope)) released.add(claimKey(c));
    const holding = lock === "off" ? NO_HOLD : (prev?.holding ?? NO_HOLD);
    heads.set(head, { ...prev, released: [...released], holding });
  }
  return { ...state, heads };
}

/**
 * Panic (R10): nothing moves by itself. Every claim present on these heads is released (a look still
 * fading out does not keep moving them) and every axis holds where it is until a new claim takes it:
 * a rescue snapshot, launched with a new order, glides in. Without one, the head never returns to
 * rest on its own. Locks stay as they are.
 */
export function holdMotion(input: Pick<MotionInput, "claims">, state: MotionState, heads: readonly string[]): MotionState {
  const next = new Map(state.heads);
  for (const head of heads) {
    const prev = next.get(head);
    const released = new Set(prev?.released ?? []);
    for (const c of input.claims) if (c.heads.includes(head)) released.add(claimKey(c));
    next.set(head, { ...prev, released: [...released], holding: { pan: true, tilt: true } });
  }
  return { ...state, heads: next };
}
