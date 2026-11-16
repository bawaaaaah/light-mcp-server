/**
 * The motion layer of the show runtime (T25; docs/specs/engine-effects-timing.md, « Couche Mouvement »): what claims
 * the moving heads on every frame — the moves of the looks (a shape, a named position T32, a target T24, a zone or a
 * path T28), their raw pan/tilt, the targets engaged by hand, the manual positions (the pad, aiming, a named position
 * recalled) — resolved by engine/motion.ts into one position per head, with its holds and releases (« Rendre la
 * main », the Panic), and the motion lock (« Figer les lyres », T26) kept in show.json. The looks' playback stays in
 * the runtime: this reads it through `MotionHost` only.
 */
import { stableStringify, type Collection } from "../data/store.js";
import { Glide } from "../engine/glide.js";
import type { LookPlayer } from "../engine/player.js";
import type { MoveFade, Position } from "../engine/move.js";
import { AXES, claimKey, claimsAxis, ownerOfClaimKey, emptyMotionState, FALLBACK_BPM, holdMotion, isHeld, motionDurationMs, releasedOf, releaseMotion, resolveMotion, UNLOCK_MIN_MS, type Axis, type AxisLayer, type AxisMode, type HeadStatus, type LockLevel, type MotionClaim, type MotionState } from "../engine/motion.js";
import { aimAt, aimNear, angleBetween, boundPosition, pointing, type AimOptions } from "../venue/aim.js";
import { motionOffsets } from "../venue/tracks.js";
import { aimSetupOf, type AttributeFrame, type ResolvedFixture, type Venue } from "../venue/venue.js";
import { checkPath, type PathHead, type PathWarning } from "../venue/path-check.js";
import { speedLimits, type Rule } from "../rules/rules.js";
import { zoneAimPoint, type Zone } from "../venue/stage.js";
import { pathPosition, pathSequence, pathStep, sequenceKey, stopOffset, type Path, type PathStop, type StopPosition } from "../engine/path.js";
import type { Look, PositionPreset, ShowSettings, Snapshot, Target } from "./model.js";
import { basisOf, legacyBasisOf, type HeadNow } from "./position-presets.js";
import { beyondStops } from "../venue/stops-check.js";
import { aimHead, clampPoint, type TargetHold, fromNormal, stageBounds, toNormal, type Bounds, type Point3, type StageAxis } from "../venue/target-aim.js";
import { heldOf, lockState, sameFlips, sameLock, type HeadFlips, type MotionLockState } from "./motion-lock.js";
import { hermiteAt } from "../engine/hermite.js";
import { ownerNamer } from "./motion-report.js";
import { seedOf, type TempoSource } from "./runtime-pure.js";
import { say } from "../../../core/lang.js";

/** T26: a soft-locked head moved by the pad is written to show.json this long after the last move (and a failed write retried). */
export const HELD_WRITE_DELAY_MS = 1000;

/** What can be deleted while a look still cites it (T28): said by its last name. */
export type GoneKind = "zone" | "position" | "target";

/** What a look following a named position covers through it (T32, `MotionController.lookCoverage`). */
interface LookCoverage {
  order?: number;
  heads: readonly string[];
  late: readonly string[];
}

/** The heads of `moved` a named position places: all of them for a point, else those it has a pan/tilt for. */
function coveredBy(p: PositionPreset, moved: readonly string[]): string[] {
  return p.point ? [...moved] : moved.filter((h) => Object.hasOwn(p.values, h));
}

/** A manual position (XY pad, aiming, a named position recalled): one claim of the motion layer per head. */
interface ManualPosition {
  /** The axes it places: one alone leaves the other to the layer below. Ignored when `preset` is set. */
  position: Partial<Position>;
  /**
   * A named position recalled (T32): both axes read from it on every frame (`ctx.presetOf`), so that a position
   * readjusted moves the heads that recalled it. A gesture over it (the pad) turns the entry into a fixed position.
   */
  preset?: string;
  /**
   * The zone it was aimed at (T28, position.aim {zone}: the Live's « Zones » widget lights the zone its heads hold). Only
   * said, never read by the render: the entry holds the pan/tilt aimed; a gesture over it (the pad) forgets it.
   */
  zone?: string;
  /** The launch order of the command that set it (the counter of the look launches): a transition watches it. */
  order: number;
  /** It glides there over the show's `moveFade` (a destination recalled) instead of following the gesture at once. */
  glide: boolean;
  /**
   * The pad given one axis while a recall (or any manual glide) still glides the other (T32): that older claim keeps
   * the axes not given, so they carry on gliding instead of jumping, until they arrive (`settleTrails`): they then
   * become this entry's fixed position, where they arrived.
   */
  trail?: { axes: readonly Axis[]; claim: Omit<ManualPosition, "trail"> };
}

/** One pass of the motion layer: the state it starts from, what was really sent and the tempo; `place` leaves the next state and the status in it. */
export interface MotionRun {
  state: MotionState;
  /** The tempo a glide given in beats is timed at when it starts. */
  bpm: number;
  sent?: ReadonlyMap<string, Position> | undefined;
  status: ReadonlyMap<string, HeadStatus>;
  /** The logical position the layer gave each head (T32 `lastPositions`); `place` leaves it, only a real frame (`frame`) keeps it. */
  positions?: ReadonlyMap<string, Position>;
  /**
   * The base each claim with a shape aimed a head at on the previous frame (`claimKey@head`, T24): a shape around a
   * point aims the point from its last base, not from the position sent (base + the shape's offset), or the base
   * would drift with the shape. `place` leaves the new table in it; only a real frame (`frame`) keeps it.
   */
  bases: ReadonlyMap<string, Position>;
  /** Why a head held for a target on this frame, by its error message (T24, lot 4: the screens say it in their language). */
  holds?: ReadonlyMap<string, TargetHold>;
}

/** The pad and the commands that follow a continuous gesture are direct (R8). */
const DIRECT: MoveFade = { seconds: 0 };

const STAGE_AXES: readonly StageAxis[] = ["x", "y", "z"];

/**
 * What the motion layer reads of the show runtime, and nothing more: the venue and the collections it aims with, the
 * clock and the tempo, the show settings (the lock lives in show.json), the looks that claim heads and their launch
 * order (one counter shared with the manual positions), the groups' fixtures, the rules and zones a path is checked
 * against, the slots the DMX console forces and the lock hook.
 */
export interface MotionHost {
  readonly venue: Venue;
  readonly looks: Collection<Look>;
  readonly targets: Collection<Target>;
  readonly positionPresets: Collection<PositionPreset>;
  readonly zones: Collection<Zone>;
  readonly tempo: TempoSource;
  now(): number;
  settings(): ShowSettings;
  /** Replaces the settings in memory only (the lock levels): `saveSettings` writes them. */
  setSettings(settings: ShowSettings): void;
  saveSettings(patch: Partial<ShowSettings>): ShowSettings;
  /** The effective lock level of a head (`ShowRuntime.motionLock`, a hook). */
  motionLock(head: string): LockLevel;
  /** The slots (0-based, per universe) the DMX console forces. */
  consoleSlots(): ReadonlyMap<number, ReadonlySet<number>>;
  /** Fixtures of a group, sub-groups and selector included. */
  fixturesOf(groupId: string): Set<string>;
  /** The next launch order (the counter of the look launches): a manual position is a new claim. */
  nextOrder(): number;
  /** When a look's player was (re)launched. */
  launchOrderOf(player: LookPlayer): number | undefined;
  /** The looks that claim heads at `now`, in this order: those fading out on exit, those leaving under a crossfade, those playing. */
  claimingLooks(now: number): readonly { look: Look; player: LookPlayer }[];
  /** The ids of the looks playing. */
  activeLooks(): string[];
  rulesInForce(): Rule[];
  /** The zone each fixture stands in, for rules scoped to a zone. */
  zoneLookup(): (id: string) => string | undefined;
}

/** Who places the axis a pan or tilt channel drives (`ShowRuntime.explainChannel`, ChannelExplanation.motion). */
export interface MotionExplanation {
  axis: Axis;
  layer: AxisLayer;
  owner: string | null;
  name?: string;
  lock: LockLevel;
  position: number;
  moving: boolean;
  from?: number;
  to?: number;
  remainingMs?: number;
  error?: string;
  masked: { owner: string; name?: string; released?: true }[];
}

export class MotionController {
  private readonly venue: Venue;
  private readonly looks: Collection<Look>;
  private readonly targets: Collection<Target>;
  private readonly positionPresets: Collection<PositionPreset>;
  private readonly zones: Collection<Zone>;
  /** The targets' points on their way (T24, `target.smoothing`): per axis, 0..1 across the target's bounds. */
  private targetGlide = new Glide();
  /** Per raw-channel table of a look, the targets whose value changes from one step to another (computed once per table). */
  private readonly changingTargets = new WeakMap<object, ReadonlySet<number>>();
  /** The last names of the zones, named positions and targets deleted (`kind:id`): what still cites one says its name. */
  private readonly goneNames = new Map<string, string>();
  /** The stop sequences of each path (T28), per head key (`sequenceKey`): memoised draws, dropped with the path object. */
  private readonly pathSequences = new WeakMap<Path, Map<number, (i: number) => number>>();
  /** Manual positions (XY pad, aiming): the manual claims of the motion layer, one per head, until released. */
  private readonly manualPositions = new Map<string, ManualPosition>();
  /**
   * The motion layer (engine/motion.ts, T25): its state from the last frame really rendered, and the logical position
   * each head was really sent then — read back in the output after the rules, and again after the guard (the DMX
   * console, the locked rules, the speed limits). Only `render` and the commands keep a state: a frame played in
   * memory (strictBounds) starts from it and drops its own.
   */
  private motionState: MotionState = emptyMotionState();
  private sentPositions: ReadonlyMap<string, Position> = new Map();
  /** MotionRun.bases of the last frame really rendered. */
  private aimBases: ReadonlyMap<string, Position> = new Map();
  /** MotionRun.holds of the last frame really rendered. */
  private aimHolds: ReadonlyMap<string, TargetHold> = new Map();
  /** Targets whose point has a glide in `targetGlide`: those a real frame does not read are forgotten at its end (a look restarted later glides from where the point is). */
  private readonly glidingTargets = new Set<string>();
  /** The targets whose point a real frame read (render): undefined outside one. */
  private targetsRead: Set<string> | undefined;
  private lastMotion: ReadonlyMap<string, HeadStatus> = new Map();
  /**
   * The logical position the motion layer gave each head on the last frame really rendered (T32): before the rules and
   * the guard, so that saving a position keeps what was asked, not a byte a rule bounded.
   */
  private lastPositions: ReadonlyMap<string, Position> = new Map();
  /**
   * The revision of a named position's placing part (T32, `MotionClaim.rev`): its pan/tilt or its point, so that a
   * readjustment glides the heads following it, a rename or a new colour does not. One per stored object.
   */
  private readonly presetRevs = new WeakMap<PositionPreset, string>();
  /**
   * The heads a look following a named position covers through it (T32), kept while the position exists and noted
   * when it is saved or deleted: deleted, the look holds those heads where they are, and only those (the others stay
   * with the layer below). `order`: the launch it was last seen under (undefined: noted before any frame of the look);
   * `late`: the heads that entered the coverage under that launch, which glide in over `moveFade` whatever the look's
   * own fade (decision P1: never a jump), until the look is launched again.
   */
  private readonly lookCoverage = new Map<string, LookCoverage>();
  /**
   * Where each locked head is frozen (logical pan/tilt): the position sent when it was locked, taken again when its
   * lock hardens, followed by the pad under a soft lock; dropped when it is unlocked. Mirrored in show.json
   * (`motionLock.held`): a restart under a lock sends the heads back there on the first frame.
   */
  private lockHeld: Map<string, Position>;
  /** Each head's lock level on the last frame: a soft lock hardening takes `held` again. */
  private readonly lockLevels = new Map<string, LockLevel>();
  /** Since when a change of `held` made by the pad (or a failed write) waits to be written to show.json (one second after). */
  private heldDirtySince: number | undefined;
  /** A freeze or a release of `held` to write to show.json as soon as the frame is over. */
  private heldUrgent = false;
  /** A write of `held` is queued after the current frame (never inside it: a failing disk must not blank a frame). */
  private heldWriteQueued = false;
  /**
   * T26, decision D4: a show opened (or restored) while its heads were already sent somewhere, with locked heads held
   * elsewhere: they glide from where they were sent to their stored `held` (at least UNLOCK_MIN_MS), they do not jump.
   * `t0`/`dur` are set on the first frame that renders it.
   */
  private readonly lockArrivals = new Map<string, { from: Position; t0?: number; dur?: number }>();
  /** The moving heads while a frame is composed: listed once for the frame (compose, the claims, the read-back). */
  private frameHeads: string[] | undefined;
  /** While a frame is composed: the stage volume and each target's heads (by target object), computed once for the frame. */
  private frameTargets: { stage?: Bounds; heads: WeakMap<object, string[]> } | undefined;

  /** `lock` of the motion layer: the runtime's hook, read at each call. */
  private readonly lockOf = (head: string): LockLevel => this.host.motionLock(head);

  constructor(private readonly host: MotionHost) {
    this.venue = host.venue;
    this.looks = host.looks;
    this.targets = host.targets;
    this.positionPresets = host.positionPresets;
    this.zones = host.zones;
    this.lockHeld = heldOf(host.settings().motionLock);
  }

  /**
   * The lock of the show just (re)loaded (`ShowRuntime.reloadSettings`): its heads where that show froze them (what was
   * pending for the show before is the caller's to flush first: flushHeld).
   */
  reloadLock(): void {
    this.lockHeld = heldOf(this.host.settings().motionLock);
    this.lockLevels.clear();
    this.heldDirtySince = undefined;
    this.heldUrgent = false;
    // decision D4: heads already sent somewhere glide to where the opened show holds them; after a restart (nothing
    // sent yet) they take it at once on the first frame
    this.lockArrivals.clear();
    for (const [head, to] of this.lockHeld) {
      const from = this.sentPositions.get(head);
      if (from && this.host.motionLock(head) !== "off" && (from.pan !== to.pan || from.tilt !== to.tilt)) this.lockArrivals.set(head, { from });
    }
  }

  /** Forgets everything live (manual positions, the targets' glides, the layer's state): another show opens. What was sent is kept, so that the heads glide from where they are. */
  resetLive(): void {
    this.manualPositions.clear();
    this.targetGlide = new Glide();
    this.glidingTargets.clear();
    this.aimBases = new Map();
    this.motionState = emptyMotionState();
    this.lastMotion = new Map();
    this.lastPositions = new Map();
    this.lookCoverage.clear();
    // the last names of what the other show deleted (T28): never said for this one
    this.goneNames.clear();
  }

  /** The logical position each moving head was really sent on the last frame (after the rules and the guard). */
  get sent(): ReadonlyMap<string, Position> {
    return this.sentPositions;
  }

  /**
   * Before a real frame: where the locked heads are frozen (T26), from what was sent on the last frame; show.json right
   * after the frame on a freeze or a release, a second after the last move of the pad otherwise (not every frame), never
   * inside it. A show opened over heads sent elsewhere (D4): their glide to `held` starts now, gone once arrived.
   */
  beginFrame(now: number, bpm: number | undefined): void {
    if (this.syncLockHeld(now)) this.heldUrgent = true;
    if (this.heldUrgent || (this.heldDirtySince !== undefined && now - this.heldDirtySince >= HELD_WRITE_DELAY_MS)) this.queueHeldWrite();
    for (const [head, a] of this.lockArrivals) {
      if (a.t0 === undefined || a.dur === undefined) Object.assign(a, { t0: now, dur: Math.max(UNLOCK_MIN_MS, motionDurationMs(this.host.settings().moveFade, bpm ?? FALLBACK_BPM)) });
      else if (now - a.t0 >= a.dur) this.lockArrivals.delete(head);
    }
  }

  /** A pass of the layer from the state of the last frame really rendered (`render`, or a frame played in memory by strictBounds). */
  run(bpm: number): MotionRun {
    return { state: this.motionState, sent: this.sentPositions, bpm, status: this.lastMotion, bases: this.aimBases };
  }

  /**
   * A real frame: `compose` runs with the targets it reads noted, then the layer keeps what `run` left (its state, the
   * status, the positions, the bases and holds), the trailing axes settle, and a target's glide nobody read this frame
   * is forgotten (a look following it stopped, the target deleted): read again later, its point starts where it is
   * instead of gliding from a stale value.
   */
  frame<T>(run: MotionRun, compose: () => T): T {
    const read = new Set<string>();
    this.targetsRead = read;
    let out: T;
    try {
      out = compose();
    } finally {
      this.targetsRead = undefined;
    }
    this.motionState = run.state;
    this.lastMotion = run.status;
    this.lastPositions = run.positions ?? new Map();
    this.settleTrails();
    this.aimBases = run.bases;
    this.aimHolds = run.holds ?? new Map();
    for (const id of this.glidingTargets)
      if (!read.has(id)) {
        for (const a of STAGE_AXES) this.targetGlide.forget(`${id}:${a}`);
        this.glidingTargets.delete(id);
      }
    return out;
  }

  /** What the heads were really sent (read back in the output): where the layer starts from on the next frame. */
  noteSent(buffers: readonly Uint8Array[]): void {
    this.sentPositions = this.readBack(buffers);
  }

  /**
   * The motion layer on one frame (engine/motion.ts, T25): a position for every installed moving head — who claims it
   * (looks, raw pan/tilt, targets, manual), where its rest is, and how it glides there from what was really sent —
   * written into `frame`; `motion` is left with the next state and the status.
   */
  place(frame: AttributeFrame, now: number, beats: number, motion: MotionRun, errors: string[]): void {
    const movers = this.movingHeads();
    if (movers.length) {
      let noAim: Zone[] | undefined;
      const bases = new Map<string, Position>();
      const holds = new Map<string, TargetHold>();
      // a claim with a shape aims from its own last base on that head (MotionRun.bases); without one, from the position
      // sent (the frames strictBounds plays after its first follow the layer's own course: what render last sent)
      const aim = (head: string, point: Point3, claim: MotionClaim): Position | { error: string } => {
        const key = claim.shape ? `${claimKey(claim)}@${head}` : undefined;
        const last = key === undefined ? undefined : motion.bases.get(key);
        const res = this.aimFor(head, point, last ?? motion.sent?.get(head) ?? this.sentPositions.get(head), (noAim ??= this.closedNoAim()));
        if (key !== undefined) {
          const kept = "error" in res ? last : res;
          if (kept) bases.set(key, kept);
        }
        if ("error" in res) holds.set(res.error, res.hold);
        return res;
      };
      const settings = this.host.settings();
      const resolved = resolveMotion(
        {
          heads: movers,
          claims: this.motionClaims(movers, now, beats, errors),
          now,
          bpm: motion.bpm,
          ...(motion.sent ? { sent: motion.sent } : {}),
          settings: { moveFade: settings.moveFade, rest: settings.restPositions },
          ctx: { aim, presetOf: (id, head, claim) => this.presetOfClaim(id, head, claim, aim) },
          lock: this.lockOf,
          heldOf: (head) => this.heldAt(head, now),
          axisMode: (head, axis) => this.axisMode(head, axis),
        },
        motion.state,
      );
      for (const [head, p] of resolved.positions) frame.positions.set(head, p);
      // a claim that cannot place a head (a shape in error) holds it where it is, and says so
      for (const [head, status] of resolved.status) for (const axis of [status.pan, status.tilt]) if (axis.error && !errors.includes(`${head}: ${axis.error}`)) errors.push(`${head}: ${axis.error}`);
      motion.state = resolved.next;
      motion.status = resolved.status;
      motion.positions = resolved.positions;
      motion.bases = bases;
      motion.holds = holds;
    } else if (motion.status.size) motion.status = new Map();
  }

  /**
   * Sets the lock levels (global and per head) as given — the commands (lot 3) decide what may harden or loosen.
   * A head newly locked is frozen where it was really sent; a soft lock hardening is frozen again there; a head
   * unlocked forgets where it was held and glides back to what claims it (at least a second). Saved in show.json.
   */
  setLock(state: MotionLockState): void {
    // the same levels: nothing to do, nothing written (a show without a lock does not get `motionLock: off`)
    if (sameLock(state, lockState(this.host.settings().motionLock))) return;
    // the levels in effect first, `held` brought in line with them, then one write
    this.host.setSettings({ ...this.host.settings(), motionLock: { level: state.level, heads: { ...state.heads }, held: Object.fromEntries(this.lockHeld) } });
    this.syncLockHeld();
    // a failed write (a full disk during a Panic) is said and retried, never thrown: the Panic goes on
    this.heldUrgent = true;
    this.flushHeld();
  }

  /**
   * A fixture gone from the patch leaves the motion lock (T26): its own level and where it was held, so a fixture
   * patched later under this id is not frozen by a stale entry (the global lock still applies to it, as to any head).
   * Saved at once; nothing to do when the lock does not name it.
   */
  forgetLockedHead(id: string): void {
    const lock = this.host.settings().motionLock;
    const own = lock !== undefined && Object.hasOwn(lock.heads, id);
    if (!own && !this.lockHeld.has(id)) return;
    this.lockHeld.delete(id);
    this.lockArrivals.delete(id);
    this.lockLevels.delete(id);
    const { [id]: _gone, ...heads } = lock?.heads ?? {};
    this.host.setSettings({ ...this.host.settings(), motionLock: { level: lock?.level ?? "off", heads, held: Object.fromEntries(this.lockHeld) } });
    this.heldUrgent = true;
    this.flushHeld();
  }

  /**
   * Whether new pan/tilt inversions or swap would move a hard-frozen moving head (T26): its frozen position is logical,
   * its bytes follow them, so the change is refused until it is unfrozen. False for any other head or the same flips.
   */
  flipsMoveFrozen(fixture: string, before: HeadFlips, after: HeadFlips): boolean {
    return this.host.motionLock(fixture) === "hard" && this.movingHeads().includes(fixture) && !sameFlips(before, after);
  }

  /** Where a locked head is frozen (T26 `held`); undefined for a free head. */
  heldPosition(fixture: string): Position | undefined {
    return this.host.motionLock(fixture) === "off" ? undefined : this.lockHeld.get(fixture);
  }

  /**
   * Brings `held` in line with the lock levels: frozen on the position sent when a head is locked (or when its soft
   * lock hardens), following the pad while a manual position holds a soft-locked head, dropped when it is free.
   * Returns true when it changed in a way to write at once (a freeze or a release); a change by the pad only marks
   * `held` to be written a second after the last one (`now`).
   */
  private syncLockHeld(now?: number): boolean {
    let urgent = false;
    for (const head of this.movingHeads()) {
      const level = this.host.motionLock(head);
      const was = this.lockLevels.get(head);
      this.lockLevels.set(head, level);
      if (level === "off") continue; // dropped below, with the heads no longer listed
      const sent = this.sentPositions.get(head);
      if (!sent) continue; // nothing sent yet: the layer freezes the head where it starts, `held` follows on the next frame
      const held = this.lockHeld.get(head);
      const same = held !== undefined && held.pan === sent.pan && held.tilt === sent.tilt;
      if (!held || (level === "hard" && was === "soft")) {
        if (!same) urgent = true;
        this.lockHeld.set(head, { pan: sent.pan, tilt: sent.tilt });
        this.lockArrivals.delete(head);
        continue;
      }
      // the pad moves a soft-locked head: it is frozen where the pad leaves it
      const status = this.lastMotion.get(head);
      if (level === "soft" && !same && (status?.pan.layer === "manual" || status?.tilt.layer === "manual")) {
        this.lockHeld.set(head, { pan: sent.pan, tilt: sent.tilt });
        this.lockArrivals.delete(head);
        if (now !== undefined) this.heldDirtySince = now;
        else urgent = true;
      }
    }
    // a head free now forgets where it was held, listed or not (an absent head unlocked must not snap back to a stale
    // `held` when it is locked again)
    for (const head of [...this.lockHeld.keys()]) {
      if (this.host.motionLock(head) !== "off") continue;
      this.lockHeld.delete(head);
      this.lockArrivals.delete(head);
      urgent = true;
    }
    return urgent;
  }

  /** Writes `held` to show.json (with the lock levels as they are); nothing is pending after it. Throws on a failed write. */
  private writeHeld(): void {
    const lock = this.host.settings().motionLock;
    if (lock || this.lockHeld.size) this.host.saveSettings({ motionLock: { ...lockState(lock), held: Object.fromEntries(this.lockHeld) } });
    this.heldDirtySince = undefined;
    this.heldUrgent = false;
  }

  /**
   * Writes a pending change of `held` now (a freeze, a release, the pad's last move under a soft lock), and nothing
   * otherwise: before the show changes (show.open, an archive restored) and on stop, so that nothing is lost and
   * nothing is written into another show. A failed write is said and retried a second later, never thrown.
   */
  flushHeld(): void {
    if (!this.heldUrgent && this.heldDirtySince === undefined) return;
    try {
      this.writeHeld();
    } catch (err) {
      console.warn("verrou des lyres : position figée non enregistrée, nouvel essai dans une seconde :", (err as Error).message);
      this.heldUrgent = false;
      this.heldDirtySince = this.host.now();
    }
  }

  /** Queues `flushHeld` right after the current frame, once. */
  private queueHeldWrite(): void {
    if (this.heldWriteQueued) return;
    this.heldWriteQueued = true;
    queueMicrotask(() => {
      this.heldWriteQueued = false;
      this.flushHeld();
    });
  }

  /**
   * Where a locked head is frozen at `now` (T26 `held`): its stored `held`, or on the way there after a show opened
   * (decision D4). Pure in `now`: the arrival starts on the first frame that renders it.
   */
  private heldAt(head: string, now: number): Position | undefined {
    const to = this.lockHeld.get(head);
    const a = to && this.lockArrivals.get(head);
    if (!to || !a) return to;
    const { from, t0, dur } = a;
    if (t0 === undefined || dur === undefined) return from;
    if (now - t0 >= dur) return to;
    const at = (axis: Axis) => hermiteAt({ from: from[axis], to: to[axis], start: t0, duration: dur, v0: 0 }, now);
    return { pan: at("pan"), tilt: at("tilt") };
  }

  /**
   * The targets as a snapshot saved them (T24, decision Q4): each point put back, each engaged one engaged again in the
   * order they had (with new orders: a recall is a new claim, the heads glide from where they are), the targets it does
   * not list disengaged. Returns the saved ids no longer in the show.
   */
  applyTargets(saved: NonNullable<Snapshot["targets"]>): string[] {
    const skipped = Object.keys(saved).filter((id) => !this.targets.get(id));
    for (const t of this.targets.list()) {
      const s = Object.hasOwn(saved, t.id) ? saved[t.id] : undefined;
      if (!s) {
        if (t.engaged) this.targets.putLive({ ...t, engaged: false });
        continue;
      }
      this.targets.putLive({ ...t, point: clampPoint(s.point, this.targetBounds(t)), engaged: false });
    }
    const engaged = Object.entries(saved)
      .filter(([id, s]) => s.engaged && this.targets.get(id))
      .sort(([, a], [, b]) => (a.engagedAt ?? 0) - (b.engagedAt ?? 0));
    for (const [id] of engaged) this.engageTarget(id, true);
    return skipped;
  }

  /** Runs `fn` with the moving heads listed once. */
  withHeads<T>(fn: () => T): T {
    const had = this.frameHeads;
    const hadTargets = this.frameTargets;
    this.frameHeads ??= this.movingHeads();
    this.frameTargets ??= { heads: new WeakMap() };
    try {
      return fn();
    } finally {
      this.frameHeads = had;
      this.frameTargets = hadTargets;
    }
  }

  /** Moving heads of the venue (fixtures with pan or tilt), in patch order. */
  movingHeads(): string[] {
    if (this.frameHeads) return this.frameHeads;
    return this.venue.fixtures.list().filter((f) => {
      if (this.venue.absent.has(f.id)) return false;
      const r = this.venue.resolve(f.id);
      return !("error" in r) && (r.pan || r.tilt);
    }).map((f) => f.id);
  }

  /** The moving heads of a group, sorted by X position (then patch order). */
  private groupHeads(groupId: string): string[] {
    const heads = new Set(this.movingHeads());
    const pos = (id: string) => this.venue.fixtures.get(id)?.position?.x ?? 0;
    const order = this.venue.fixtures.list().map((f) => f.id);
    return [...this.host.fixturesOf(groupId)].filter((f) => heads.has(f)).sort((a, b) => pos(a) - pos(b) || order.indexOf(a) - order.indexOf(b));
  }

  /** Fixtures moved by a look, in row order (canvas order, or by X position for a group). */
  movedBy(look: Look): string[] {
    const heads = new Set(this.movingHeads());
    if (look.move?.group) return this.groupHeads(look.move.group);
    const out: string[] = [];
    for (const cell of this.venue.cellTargets(look.canvas)) for (const t of cell) if (heads.has(t.fixture) && !out.includes(t.fixture)) out.push(t.fixture);
    return out;
  }

  /**
   * Sets a manual position (normalised pan/tilt) on fixtures: the manual claim of the motion layer, above the looks
   * until released. Pan or tilt alone keeps the other axis as it was claimed, or leaves it to the layer below. Each
   * command is a new claim (a new launch order, the counter of the looks). "direct": the head follows at once (the
   * pad, a gesture); "glide": it goes there over the show's `moveFade` (a destination recalled, T32).
   */
  setPosition(fixtures: string[], p: Partial<Position>, how: "direct" | "glide" = "direct"): void {
    const order = this.host.nextOrder();
    const given = AXES.filter((a) => p[a] !== undefined);
    for (const f of fixtures) {
      const prev = this.manualPositions.get(f);
      const trail = this.trailOf(f, prev, given);
      // over a named position recalled, the axis not given stays where the position puts it; one still gliding there
      // is left to the trailing claim
      const cur: Partial<Position> = { ...(prev?.trail ? prev.position : this.manualAxes(f)) };
      for (const a of trail?.axes ?? []) delete cur[a];
      const position = { ...cur, ...(p.pan === undefined ? {} : { pan: p.pan }), ...(p.tilt === undefined ? {} : { tilt: p.tilt }) };
      this.manualPositions.set(f, { position, order, glide: how === "glide", ...(trail ? { trail } : {}) });
    }
  }

  /**
   * The axes not `given` that the head's manual claim still glides on the last frame (a recall on its way): the claim
   * that glides them keeps them (`ManualPosition.trail`). A trail already there keeps those of its axes not given.
   */
  private trailOf(head: string, prev: ManualPosition | undefined, given: readonly Axis[]): ManualPosition["trail"] {
    if (!prev) return undefined;
    if (prev.trail) {
      const left = prev.trail.axes.filter((a) => !given.includes(a));
      return left.length ? { axes: left, claim: prev.trail.claim } : undefined;
    }
    if (!prev.glide) return undefined;
    const status = this.lastMotion.get(head);
    const key = claimKey({ owner: "manual", order: prev.order });
    // a recall no frame has resolved yet (pressed, then the pad before the next frame) is still on its way
    const gliding = (a: Axis) => (status?.[a].claims.includes(key) === true ? status[a].moving && status[a].claims[0] === key : true);
    const axes = AXES.filter((a) => !given.includes(a) && gliding(a));
    return axes.length ? { axes, claim: { position: prev.position, order: prev.order, glide: prev.glide, ...(prev.preset === undefined ? {} : { preset: prev.preset }) } } : undefined;
  }

  /**
   * After a frame: a trailing axis (`ManualPosition.trail`) that arrived, or that its claim no longer holds, becomes the
   * entry's own fixed position where it is, as the pad over a recall keeps it.
   */
  private settleTrails(): void {
    for (const [head, m] of this.manualPositions) {
      if (!m.trail) continue;
      const status = this.lastMotion.get(head);
      const key = claimKey({ owner: "manual", order: m.trail.claim.order });
      const still = m.trail.axes.filter((a) => status?.[a].moving === true && status[a].claims[0] === key);
      for (const a of m.trail.axes) if (!still.includes(a) && status) m.position = { ...m.position, [a]: status[a].target ?? status[a].position };
      if (still.length) m.trail = { ...m.trail, axes: still };
      else delete m.trail;
    }
  }

  /** Releases manual positions (all when no fixture is given): the layer below takes the heads, gliding; returns the released fixtures. */
  releasePositions(fixtures?: string[]): string[] {
    const ids = fixtures ?? [...this.manualPositions.keys()];
    return ids.filter((f) => this.manualPositions.delete(f));
  }

  /**
   * Recalls a named position on heads (T32, decision Q2: a manual gesture): one manual claim per head reading the
   * position on every frame, gliding there over the show's `moveFade`. Released like the pad (« Rendre la main »,
   * position.release, the Panic). The caller picks the heads (covered, placed, unlocked).
   */
  recallPreset(id: string, fixtures: string[]): void {
    const order = this.host.nextOrder();
    for (const f of fixtures) this.manualPositions.set(f, { position: {}, preset: id, order, glide: true });
  }

  /**
   * Deletes a named position (T32), its coverage noted first for the looks following it: deleted, they hold the heads
   * it covered, even a look never played or stopped since.
   */
  deletePositionPreset(id: string): boolean {
    this.notePositionCoverage(id);
    return this.positionPresets.delete(id);
  }

  /** Notes what the named position `id` covers for each look following it (`lookCoverage`); nothing when it is gone. */
  notePositionCoverage(id: string): void {
    const p = this.positionPresets.get(id);
    if (!p) return;
    for (const look of this.looks.list()) {
      if (look.move?.at?.position !== id) continue;
      let moved: string[];
      try {
        moved = this.movedBy(look);
      } catch {
        continue;
      }
      this.coverLook(look.id, undefined, coveredBy(p, moved));
    }
  }

  /**
   * Records the heads a look covers through its named position (`lookCoverage`) and returns the entry it claims with.
   * `order` undefined (noted outside a frame) keeps the launch known. An older launch still fading out reads the entry
   * without rewriting it: the newer launch keeps its own.
   */
  private coverLook(lookId: string, order: number | undefined, heads: readonly string[]): LookCoverage {
    const last = this.lookCoverage.get(lookId);
    if (order !== undefined && last?.order !== undefined && order < last.order) return { order, heads, late: [] };
    const at = order ?? last?.order;
    const same = last !== undefined && at !== undefined && last.order === at;
    const late = same ? [...last.late.filter((h) => heads.includes(h)), ...heads.filter((h) => !last.heads.includes(h) && !last.late.includes(h))] : [];
    const entry: LookCoverage = { ...(at === undefined ? {} : { order: at }), heads, late };
    this.lookCoverage.set(lookId, entry);
    return entry;
  }

  /** The revision of what a named position places (`presetRevs`); undefined when no position has that id. */
  private presetRev(id: string): string | undefined {
    const p = this.positionPresets.get(id);
    if (!p) return undefined;
    let rev = this.presetRevs.get(p);
    if (rev === undefined) this.presetRevs.set(p, (rev = stableStringify({ values: p.values, point: p.point ?? null })));
    return rev;
  }

  /** Notes the zone the heads were just aimed at (T28): their manual entries say it until a gesture replaces them. */
  markAimedZone(fixtures: readonly string[], zone: string): void {
    for (const f of fixtures) {
      const m = this.manualPositions.get(f);
      if (m) m.zone = zone;
    }
  }

  /** The zone a head was aimed at and still holds by hand, if any (T28). */
  aimedZone(fixture: string): string | undefined {
    return this.manualPositions.get(fixture)?.zone;
  }

  /** The named position a head was recalled to and still holds by hand, if any (T32). */
  recalledPreset(fixture: string): string | undefined {
    return this.manualPositions.get(fixture)?.preset;
  }

  /**
   * Where a named position puts a head now (T32): its pan/tilt for a covered head; for a point, the aim from where the
   * head was sent (the solution closest to it, aimNear); or why it cannot (unknown, not covered, out of reach, no stage
   * position, a no-aim zone closed now).
   */
  presetPosition(id: string, head: string, from: Position | undefined = this.sentPositions.get(head)): Position | { error: string; limited?: true } {
    const p = this.positionPresets.get(id);
    if (!p) return { error: say(`position nommée inconnue : ${id}`, `unknown named position: ${id}`) };
    if (p.point) return this.aimNow(head, p.point, from);
    const v = Object.hasOwn(p.values, head) ? p.values[head] : undefined;
    return v ? { pan: v.pan, tilt: v.tilt } : { error: say(`« ${p.name} » ne couvre pas cette lyre`, `“${p.name}” does not cover this head`) };
  }

  /**
   * Where `head` points to aim at `point` now: the solution closest to `from` (the position sent by default; never the
   * long way round, aimNear), or why it cannot (out of reach, no stage position, a no-aim zone closed now); `limited`
   * when the point is in the travel but beyond the head's useful stops (T8).
   */
  aimNow(head: string, point: Point3, from: Position | undefined = this.sentPositions.get(head)): Position | { error: string; limited?: true } {
    const res = this.aimFor(head, point, from, this.closedNoAim());
    if (!("error" in res)) return res;
    return { error: res.error, ...(res.hold.limited ? { limited: true as const } : {}) };
  }

  /** The axes a head's manual claim places: a named position recalled gives both, as it puts the head now. */
  private manualAxes(fixture: string): Partial<Position> | undefined {
    const m = this.manualPositions.get(fixture);
    if (!m) return undefined;
    const own = this.entryAxes(fixture, m);
    if (!m.trail) return own;
    const trailing = this.entryAxes(fixture, m.trail.claim);
    const out: Partial<Position> = { ...own };
    for (const a of m.trail.axes) if (trailing[a] !== undefined) out[a] = trailing[a];
    return out;
  }

  /** The axes one manual entry places, a recalled named position read as it puts the head now. */
  private entryAxes(fixture: string, m: Omit<ManualPosition, "trail">): Partial<Position> {
    if (!m.preset) return m.position;
    const at = this.presetPosition(m.preset, fixture);
    return "error" in at ? { ...this.sentPositions.get(fixture) } : at;
  }

  /** The manual position of a head, if any; an axis it does not place is where the head was last sent. */
  manualPosition(fixture: string): Position | undefined {
    const manual = this.manualAxes(fixture);
    if (!manual) return undefined;
    const sent = this.sentPositions.get(fixture);
    return { pan: manual.pan ?? sent?.pan ?? 0.5, tilt: manual.tilt ?? sent?.tilt ?? 0.5 };
  }

  /**
   * Where a head is now, as saving a named position captures it (T32): per axis, the manual position when one is set and
   * no lock holds the axis (where the pad or a recall asked it to go, even while it glides there), else the position the motion layer gave
   * it on the last frame rendered (a look's shape at that instant, a target, its rest — before the rules and the guard),
   * else the centre. An instant capture: during a fade or a glide it is the value of the moment.
   */
  positionNow(fixture: string): Position {
    const manual = this.manualPosition(fixture);
    const last = this.lastPositions.get(fixture);
    const status = this.lastMotion.get(fixture);
    // the manual position holds an axis unless a lock does (a hard lock masks it: the head is not going there)
    const axis = (a: Axis): number => (manual && status?.[a].layer !== "lock" ? manual[a] : (last?.[a] ?? manual?.[a] ?? 0.5));
    return { pan: axis("pan"), tilt: axis("tilt") };
  }

  /** A fixture's basis now (show/position-presets.ts `basisOf`): undefined when it is not patched. */
  positionBasis(fixture: string): string | undefined {
    return this.positionHeadNow(fixture)?.basis;
  }

  /** A covered head as `positionStale` judges it now (its basis, its stops): undefined when it is not patched. */
  positionHeadNow(fixture: string): HeadNow | undefined {
    const patch = this.venue.fixtures.get(fixture);
    if (!patch) return undefined;
    const r = this.venue.resolve(fixture);
    const src = { patch, ...("error" in r ? {} : { panMax: r.panMax, tiltMax: r.tiltMax }) };
    const limits = patch.orientation?.limits;
    return {
      basis: basisOf(src),
      legacy: legacyBasisOf(src),
      beyondStops: (p) => !("error" in r) && beyondStops({ panMax: r.panMax, tiltMax: r.tiltMax, limits }, p),
    };
  }

  /**
   * Whether a stored pan/tilt of `head` points at `point` with the head as it is now (within 0.05°): its bytes still aim
   * there. False for a head unpatched, without a stage position, or one the point is on.
   */
  pointsAt(head: string, p: Position, point: Point3): boolean {
    const r = this.venue.resolve(head);
    const setup = "error" in r ? undefined : aimSetupOf(r);
    if (!setup) return false;
    const towards = { x: point.x - setup.position.x, y: point.y - setup.position.y, z: point.z - setup.position.z };
    return Math.hypot(towards.x, towards.y, towards.z) > 1e-6 && angleBetween(pointing(setup, p), towards) <= 0.05;
  }

  /** Why each moving head is where it is (engine/motion.ts, HeadStatus), on the last frame rendered. */
  motionStatus(): ReadonlyMap<string, HeadStatus> {
    return this.lastMotion;
  }

  /** The logical position a moving head was really sent on the last frame (after the rules and the guard). */
  sentPosition(fixture: string): Position | undefined {
    return this.sentPositions.get(fixture);
  }

  /**
   * « Rendre la main »: on a target, releases only the strongest top layer present among its heads, axis by axis.
   * Other heads keep their layer until a later press reaches it. The layer below takes over, gliding, down to rest.
   * A look released keeps playing: it claims the head again once started again. Returns, per head, the owners released.
   */
  releaseTop(fixtures?: string[]): { fixture: string; released: string[] }[] {
    return this.releaseClaims("top", fixtures);
  }

  /** `position.home`: releases every claim on heads (but a lock): they glide to their rest position. */
  homePositions(fixtures?: string[]): { fixture: string; released: string[] }[] {
    return this.releaseClaims("all", fixtures);
  }

  private releaseClaims(scope: "top" | "all", fixtures?: string[]): { fixture: string; released: string[] }[] {
    const all = this.movingHeads();
    const heads = fixtures ? fixtures.filter((f) => all.includes(f)) : all;
    const before = this.motionState;
    this.motionState = releaseMotion({ heads: all, claims: this.motionClaims(all, this.host.now(), this.host.tempo.state().beats), lock: this.lockOf }, before, { heads, scope });
    return heads.map((head) => {
      const was = new Set(releasedOf(before, head));
      const added = releasedOf(this.motionState, head).filter((key) => !was.has(key));
      // a manual claim released is gone: the next command is a new one
      const manual = this.manualPositions.get(head);
      if (manual && added.includes(claimKey({ owner: "manual", order: manual.order }))) this.manualPositions.delete(head);
      // a Panic hold let go is told like a claim
      const hold = isHeld(before, head) && !isHeld(this.motionState, head) ? ["hold"] : [];
      return { fixture: head, released: [...new Set([...added.map(ownerOfClaimKey), ...hold])] };
    });
  }

  /**
   * Lets heads out of the hold a Panic left (all the moving heads when none is given), and nothing else: they glide
   * to the look that claims them, else to rest. Returns the heads that were held. `position.release` calls it: after
   * a Panic, the button that hands a head back must not leave it stuck.
   */
  releaseHold(fixtures?: string[]): string[] {
    const all = this.movingHeads();
    const held = (fixtures ?? all).filter((f) => all.includes(f) && isHeld(this.motionState, f));
    if (held.length) this.motionState = releaseMotion({ heads: all, claims: [], lock: this.lockOf }, this.motionState, { heads: held, scope: "hold" });
    return held.filter((f) => !isHeld(this.motionState, f));
  }

  /**
   * Panic (R10): no head moves by itself. Every claim present is released and the heads hold where they are until a
   * new claim takes them — the safe look or snapshot, started after, glides in. Call it before stopping the looks.
   */
  holdPositions(): void {
    const heads = this.movingHeads();
    this.motionState = holdMotion({ claims: this.motionClaims(heads, this.host.now(), this.host.tempo.state().beats) }, this.motionState, heads);
  }

  /**
   * What claims the moving heads at `now` (engine/motion.ts), each claim with its launch order: the moves of the
   * looks — those leaving keep theirs to the end of their fade, as their colours do —, the raw pan/tilt channels of
   * the looks (question 6: the bytes turned into a logical position by venue.readPosition, on the axes written only),
   * then the manual positions. A look's raw pan/tilt comes after its own move: it wins on the axes it writes.
   */
  private motionClaims(heads: readonly string[], now: number, beats: number, errors: string[] = []): MotionClaim[] {
    const claims: MotionClaim[] = [];
    if (!heads.length) return claims;
    const isHead = new Set(heads);
    const resolved = new Map<string, ResolvedFixture | undefined>();
    const headAt = (id: string): ResolvedFixture | undefined => {
      if (!resolved.has(id)) {
        const r = isHead.has(id) ? this.venue.resolve(id) : undefined;
        resolved.set(id, r && !("error" in r) ? r : undefined);
      }
      return resolved.get(id);
    };
    const ofLook = (look: Look, player: LookPlayer): void => {
      const own = { owner: `look:${look.id}`, layer: "look" as const, order: this.host.launchOrderOf(player) ?? 0, ...(look.move?.fade ? { fade: look.move.fade } : {}) };
      if (look.move?.enabled === false) {
        // « Ne pas bouger les lyres » (T26, decision V3): the look keeps its move settings and holds the heads it would
        // move (its move's, and those its raw pan/tilt write) where they are while it is the top look — they do not
        // go back to rest; its colours play on
        const held = new Set<string>();
        try {
          for (const f of this.movedBy(look)) held.add(f);
        } catch (err) {
          errors.push((err as Error).message);
        }
        for (const t of look.channels?.targets ?? []) {
          const r = headAt(t.fixture);
          if (r && motionOffsets(r).has(t.offset)) held.add(t.fixture);
        }
        if (held.size) claims.push({ ...own, heads: [...held], base: { kind: "hold" } });
        return;
      }
      if (look.move) {
        try {
          const moved = this.movedBy(look);
          // centred on a named position (T32, move.at.position), read at render: its pan/tilt on the heads it covers
          // (the look's others go to the layer below), or its point aimed head by head; a position gone holds the heads
          const named = look.move.at?.position;
          // centred on a target's point (T24, move.at.target), aimed head by head; a target gone holds the heads where they are
          const at = named === undefined ? look.move.at?.target : undefined;
          const target = at === undefined ? undefined : this.targets.get(at);
          // aimed at a zone (T28, move.at.zone, « un bouton par zone »), head by head, or along a path of stops (move.at.path)
          const zoneId = named === undefined && at === undefined ? look.move.at?.zone : undefined;
          const path = named === undefined && at === undefined && zoneId === undefined ? look.move.at?.path : undefined;
          if (named !== undefined) {
            const p = this.positionPresets.get(named);
            if (!p) errors.push(say(`look « ${look.name} » : position nommée inconnue : ${named}`, `look “${look.name}”: unknown named position: ${named}`));
            // gone, it still claims the heads it covered last: the layer holds them where they are (R14), even mid-show;
            // with no coverage known, it claims nothing (the unknown position is said)
            const last = this.lookCoverage.get(look.id);
            const { heads: covered, late } = this.coverLook(look.id, own.order, p ? coveredBy(p, moved) : last ? moved.filter((h) => last.heads.includes(h)) : []);
            const rev = this.presetRev(named);
            if (covered.length) claims.push({ ...own, heads: covered, base: { kind: "preset", id: named }, shape: { move: look.move, cycles: player.position(now, beats, look.move.every) }, ...(rev === undefined ? {} : { rev }), ...(late.length ? { late } : {}) });
          } else if (at !== undefined && !target) {
            errors.push(say(`look « ${look.name} » : cible inconnue : ${at}`, `look “${look.name}”: unknown target: ${at}`));
            if (moved.length) claims.push({ ...own, heads: moved, base: { kind: "hold" } });
          } else if (zoneId !== undefined) {
            const zone = this.zones.get(zoneId);
            // a zone gone holds the heads where they are (R14), as a target gone does, and says why on each of them
            const zoneGone = zone ? undefined : say(`look « ${look.name} » : zone inconnue : ${this.goneName("zone", zoneId)}`, `look “${look.name}”: unknown zone: ${this.goneName("zone", zoneId)}`);
            if (zoneGone) errors.push(zoneGone);
            if (moved.length) claims.push({ ...own, heads: moved, base: zone ? { kind: "point", ...zoneAimPoint(zone, look.move.at?.height) } : { kind: "hold", reason: zoneGone! }, ...(zone ? { shape: { move: look.move, cycles: player.position(now, beats, look.move.every) } } : {}) });
          } else if (path) claims.push(...this.pathClaims(look, path, player.position(now, beats, look.move.every), own, moved));
          else if (moved.length) claims.push({ ...own, heads: moved, ...(target ? { base: { kind: "point" as const, ...this.targetPoint(target) } } : {}), shape: { move: look.move, cycles: player.position(now, beats, look.move.every) } });
        } catch (err) {
          errors.push((err as Error).message);
        }
      }
      if (!look.channels) return;
      const row = look.channels.steps[player.rawStep(now, beats, look.channels.steps.length)] ?? [];
      const changing = this.changingTargetsOf(look.channels);
      const bytes = new Map<string, Map<number, number>>();
      const stepping = new Set<string>();
      look.channels.targets.forEach((t, k) => {
        const r = headAt(t.fixture);
        if (!r || !motionOffsets(r).has(t.offset)) return;
        const mine = bytes.get(t.fixture) ?? new Map<number, number>();
        bytes.set(t.fixture, mine.set(t.offset, Math.max(mine.get(t.offset) ?? 0, row[k] ?? 0)));
        if (changing.has(k)) stepping.add(t.fixture);
      });
      for (const [f, mine] of bytes) {
        const at = this.venue.readPosition(headAt(f)!, (offset) => mine.get(offset));
        // steps writing other pan/tilt bytes move the head under the same claim, with no glide: the pad must keep reading it
        if (at.pan !== undefined || at.tilt !== undefined) claims.push({ ...own, heads: [f], base: { kind: "fixed", ...at }, ...(stepping.has(f) ? { animated: true as const } : {}) });
      }
    };
    for (const { look, player } of this.host.claimingLooks(now)) ofLook(look, player);
    // the targets engaged by hand (T24): one claim each at the target layer, ordered by when they were engaged
    for (const t of this.targets.list()) {
      if (!t.engaged) continue;
      const mine = this.targetHeads(t).filter((h) => isHead.has(h));
      if (mine.length) claims.push({ owner: `target:${t.id}`, layer: "target", order: t.engagedAt ?? 0, heads: mine, base: { kind: "point", ...this.targetPoint(t) }, ...(t.fade ? { fade: t.fade } : {}) });
    }
    const manualClaim = (f: string, m: Omit<ManualPosition, "trail">): MotionClaim => {
      const rev = m.preset === undefined ? undefined : this.presetRev(m.preset);
      return { owner: "manual", layer: "manual", order: m.order, heads: [f], base: m.preset === undefined ? { kind: "fixed", ...m.position } : { kind: "preset", id: m.preset }, ...(m.glide ? {} : { fade: DIRECT }), ...(rev === undefined ? {} : { rev }) };
    };
    for (const [f, m] of this.manualPositions) {
      if (!isHead.has(f)) continue;
      claims.push(manualClaim(f, m));
      // the older claim still gliding the axes the pad did not give (it loses the others to the newer claim)
      if (m.trail) claims.push(manualClaim(f, m.trail.claim));
    }
    return claims;
  }

  /**
   * The claims of a look's path (T28, `move.at.path`): one per head, the position between the two stops of its step
   * (`pathStep`, interpolated in pan/tilt), a fixed base the motion layer glides into like any other (no new kind of
   * base). A step one of whose two stops the head cannot reach (out of reach, no stage position, a zone, position or
   * target gone) holds the head where it is for that step (R14, never the layer below) and says why.
   */
  private pathClaims(look: Look, path: Path, cycles: number, own: Pick<MotionClaim, "owner" | "layer" | "order" | "fade">, moved: readonly string[]): MotionClaim[] {
    let sequences = this.pathSequences.get(path);
    if (!sequences) this.pathSequences.set(path, (sequences = new Map<number, (i: number) => number>()));
    const seed = seedOf(look.id);
    const claims: MotionClaim[] = [];
    moved.forEach((head, index) => {
      const key = sequenceKey(path, index);
      let seq = sequences.get(key);
      if (!seq) sequences.set(key, (seq = pathSequence(path, seed, index)));
      const step = pathStep(path, seq, cycles, stopOffset(path, look.move ?? {}, index, moved.length));
      const a = this.pathStopAt(path.stops[step.from]!, head);
      const b = step.to === step.from ? a : this.pathStopAt(path.stops[step.to]!, head);
      const bad = "error" in a ? { stop: step.from, error: a.error } : "error" in b ? { stop: step.to, error: b.error } : undefined;
      if (bad) {
        // the reason rides on the hold: the motion layer says it as the head's error (pads, position.list, render errors)
        const reason = say(`look « ${look.name} », arrêt ${bad.stop + 1} (${this.pathStopName(path.stops[bad.stop]!)}) : ${bad.error}`, `look “${look.name}”, stop ${bad.stop + 1} (${this.pathStopName(path.stops[bad.stop]!)}): ${bad.error}`);
        claims.push({ ...own, heads: [head], base: { kind: "hold", reason } });
        return;
      }
      const p = pathPosition(a as Position, b as Position, step.ease);
      claims.push({ ...own, heads: [head], base: { kind: "fixed", pan: p.pan, tilt: p.tilt }, animated: true });
    });
    return claims;
  }

  /**
   * Where a path stop puts `head` (T28): a zone's aiming point, a point, a named position's pan/tilt or point, a target's
   * point now — a point aimed by `aimAt` (the solution closest to the centre of the travel: no state, the same stop gives
   * the same position every time), or why the head cannot go there.
   */
  pathStopAt(stop: PathStop, head: string): StopPosition {
    const r = this.venue.resolve(head);
    if ("error" in r) return { error: r.error };
    const aimPoint = (p: Point3): StopPosition => {
      const setup = aimSetupOf(r);
      if (!setup) return { error: say("position sur la scène inconnue", "stage position unknown") };
      const res = aimAt(setup, p);
      return "error" in res ? { error: res.error } : { pan: res.pan, tilt: res.tilt };
    };
    if (stop.zone !== undefined) {
      const zone = this.zones.get(stop.zone);
      return zone ? aimPoint(zoneAimPoint(zone, stop.height)) : { error: say(`zone inconnue : ${this.goneName("zone", stop.zone)}`, `unknown zone: ${this.goneName("zone", stop.zone)}`) };
    }
    if (stop.point) return aimPoint(stop.point);
    if (stop.position !== undefined) {
      const p = this.positionPresets.get(stop.position);
      if (!p) return { error: say(`position nommée inconnue : ${this.goneName("position", stop.position)}`, `unknown named position: ${this.goneName("position", stop.position)}`) };
      if (p.point) return aimPoint(p.point);
      const v = Object.hasOwn(p.values, head) ? p.values[head] : undefined;
      return v ? { pan: v.pan, tilt: v.tilt } : { error: say(`« ${p.name} » ne couvre pas cette lyre`, `“${p.name}” does not cover this head`) };
    }
    if (stop.target !== undefined) {
      const t = this.targets.get(stop.target);
      return t ? aimPoint(this.targetPoint(t)) : { error: say(`cible inconnue : ${this.goneName("target", stop.target)}`, `unknown target: ${this.goneName("target", stop.target)}`) };
    }
    return { error: say("arrêt sans destination", "stop without a destination") };
  }

  /** How a path stop is named in a message and in the editor: its zone, position or target by name, a point by its metres. */
  pathStopName(stop: PathStop): string {
    // as the editor writes them: a decimal comma and « ; » between the metres in French
    const m = (v: number) => say(String(Math.round(v * 100) / 100).replace(".", ","), String(Math.round(v * 100) / 100));
    const named = (kind: GoneKind, id: string, name: string | undefined, fr: string, en: string) =>
      name !== undefined ? say(`${fr} « ${name} »`, `${en} “${name}”`) : say(`${fr} supprimée (${this.goneName(kind, id)})`, `${en} deleted (${this.goneName(kind, id)})`);
    if (stop.zone !== undefined) return named("zone", stop.zone, this.zones.get(stop.zone)?.name, "zone", "zone");
    if (stop.position !== undefined) return named("position", stop.position, this.positionPresets.get(stop.position)?.name, "position", "position");
    if (stop.target !== undefined) return named("target", stop.target, this.targets.get(stop.target)?.name, "cible", "target");
    if (stop.point) return say(`point (${m(stop.point.x)} ; ${m(stop.point.y)} ; ${m(stop.point.z)})`, `point (${m(stop.point.x)}; ${m(stop.point.y)}; ${m(stop.point.z)})`);
    return "?";
  }

  /** Remembers the name of a zone, named position or target being deleted: what still cites it says it by name (T28). */
  rememberGoneName(kind: GoneKind, id: string, name: string): void {
    this.goneNames.set(`${kind}:${id}`, name);
  }

  /** The last known name of something deleted (`rememberGoneName`), else its id. */
  goneName(kind: GoneKind, id: string): string {
    return this.goneNames.get(`${kind}:${id}`) ?? id;
  }

  /**
   * A look's path as it will play (T28): each stop resolved for each head it moves (the render's own `pathStopAt`), and
   * what to know ahead (venue/path-check.ts): stops out of reach, trips too fast for a speed rule that applies, trips
   * crossing a no-aim zone this look does not open. Undefined for a look without a path. A group gone moves no head.
   */
  pathReport(look: Look): { heads: string[]; stops: { name: string; gone?: string; heads: ({ id: string } & StopPosition)[] }[]; warnings: PathWarning[] } | undefined {
    const at = look.move?.at;
    if (!at || !look.move || at.target !== undefined || at.position !== undefined) return undefined;
    // a look aimed at a zone is checked as a path of one stop: out of reach, landing in a no-aim zone (T28)
    const path: Path | undefined = at.path ?? (at.zone === undefined ? undefined : { stops: [{ zone: at.zone, ...(at.height === undefined ? {} : { height: at.height }) }], order: "loop", travel: 0.5, heads: "ensemble" });
    if (!path) return undefined;
    let moved: string[];
    try {
      moved = this.movedBy(look);
    } catch {
      moved = [];
    }
    const rules = this.host.rulesInForce();
    const zoneById = this.host.zoneLookup();
    const heads: PathHead[] = moved.map((id) => {
      const r = this.venue.resolve(id);
      const stops = path.stops.map((s) => this.pathStopAt(s, id));
      if ("error" in r) return { id, name: id, panMax: 0, tiltMax: 0, stops };
      const limits = speedLimits(rules, r, zoneById);
      return { id, name: r.patch.name, panMax: r.panMax, tiltMax: r.tiltMax, setup: aimSetupOf(r), stops, speed: { pan: limits.pan?.degPerSecond, tilt: limits.tilt?.degPerSecond } };
    });
    const every = look.move.every;
    const bpm = "beats" in every ? this.bpmNow() : undefined;
    const stepSeconds = "beats" in every ? (every.beats * 60) / bpm! : every.seconds;
    const warnings = checkPath({
      path,
      heads,
      travelSeconds: stepSeconds * path.travel,
      // a zone this look opens (allowLooks) does not darken it
      noAim: this.zones.list().filter((z) => z.noAim && !z.allowLooks.includes(look.id)),
      ...(at.path ? {} : { zoneLook: true }),
      stopName: (i) => this.pathStopName(path.stops[i]!),
      ...(bpm === undefined ? {} : { bpm }),
    });
    // what a stop names deleted since: its last name, for the editor to say (« Zone supprimée (Balcon) »)
    const goneOf = (s: PathStop): string | undefined =>
      s.zone !== undefined && !this.zones.get(s.zone)
        ? this.goneName("zone", s.zone)
        : s.position !== undefined && !this.positionPresets.get(s.position)
          ? this.goneName("position", s.position)
          : s.target !== undefined && !this.targets.get(s.target)
            ? this.goneName("target", s.target)
            : undefined;
    return {
      heads: moved,
      stops: path.stops.map((s, i) => {
        const lastKnown = goneOf(s);
        return { name: this.pathStopName(s), ...(lastKnown === undefined ? {} : { gone: lastKnown }), heads: heads.map((h) => ({ id: h.id, ...h.stops[i]! })) };
      }),
      warnings,
    };
  }

  /** The tempo now, for a cadence in beats said in seconds (the motion layer's fallback when none is known). */
  private bpmNow(): number {
    const bpm = this.host.tempo.state().bpm;
    return bpm !== undefined && Number.isFinite(bpm) && bpm > 0 ? bpm : FALLBACK_BPM;
  }

  /** The targets of a raw-channel table whose value differs between two of its steps. */
  private changingTargetsOf(channels: NonNullable<Look["channels"]>): ReadonlySet<number> {
    let changing = this.changingTargets.get(channels);
    if (!changing) {
      const found = new Set<number>();
      const first = channels.steps[0] ?? [];
      for (let k = 0; k < channels.targets.length; k++) if (channels.steps.some((step) => (step[k] ?? 0) !== (first[k] ?? 0))) found.add(k);
      this.changingTargets.set(channels, (changing = found));
    }
    return changing;
  }

  /** Whether an axis of a head glides or cuts at a change of owner: the box of the channel that axis drives (T5, ResolvedTracks.motion). */
  private axisMode(head: string, axis: Axis): AxisMode {
    const r = this.venue.resolve(head);
    if ("error" in r || !r.tracks) return "glide";
    const channel: Axis = r.patch.orientation?.swapPanTilt ? (axis === "pan" ? "tilt" : "pan") : axis;
    return r.tracks.motion[channel] ?? "glide";
  }

  /** The logical position each moving head has in `buffers`; an axis a head does not have keeps the layer's own value. */
  private readBack(buffers: readonly Uint8Array[]): Map<string, Position> {
    const sent = new Map<string, Position>();
    for (const id of this.movingHeads()) {
      const r = this.venue.resolve(id);
      const buf = "error" in r ? undefined : buffers[r.patch.universe - 1];
      if ("error" in r || !buf) continue;
      const at = this.venue.sentPosition(r, buf);
      const status = this.lastMotion.get(id);
      sent.set(id, { pan: at.pan ?? status?.pan.position ?? 0.5, tilt: at.tilt ?? status?.tilt.position ?? 0.5 });
    }
    return sent;
  }

  /**
   * Points fixtures at a point of the stage (metres); returns per-fixture results. The solution closest to the centre of
   * the travel, or with `near` the one closest to that position (a head re-aimed where it already points stays on its
   * side instead of turning half a turn, T8). `opts`: re-aiming a head held by hand (calibration.correct) — `ignoreStops`
   * aims as if it had no useful stops (the output bounds it anyway), `slack` lets a solution just past the travel count.
   */
  aim(
    fixtures: string[],
    target: { x: number; y: number; z: number },
    near?: Position,
    opts?: AimOptions & { ignoreStops?: boolean },
  ): { fixture: string; pan?: number; tilt?: number; error?: string; unplaced?: true }[] {
    return fixtures.map((id) => {
      const f = this.venue.fixtures.get(id);
      const r = this.venue.resolve(id);
      if (!f || "error" in r) return { fixture: id, error: f ? (r as { error: string }).error : say(`fixture inconnue : ${id}`, `unknown fixture: ${id}`) };
      if (!r.pan && !r.tilt) return { fixture: id, error: say("pas de pan/tilt", "no pan/tilt") };
      // said apart by the pad's zone chips (T27): not « out of reach », placed nowhere
      if (!f.position) return { fixture: id, error: say("position sur la scène inconnue", "stage position unknown"), unplaced: true };
      const setup = aimSetupOf(r)!;
      const res = near ? aimNear(opts?.ignoreStops ? { ...setup, limits: undefined } : setup, target, near, opts) : aimAt(setup, target);
      if ("error" in res) return { fixture: id, error: res.error };
      this.setPosition([id], res);
      return { fixture: id, pan: res.pan, tilt: res.tilt };
    });
  }

  // ---- targets (T24; docs/specs/venue-fixtures-stage.md, « Cible »): a source of the motion layer, nothing more —
  // their claims go through resolveMotion like the others (priority, transitions, hold, lock)

  /** The box a target's point moves in: its own bounds, else the stage volume (zones, placed fixtures). */
  targetBounds(t: Pick<Target, "bounds">): Bounds {
    if (t.bounds) return t.bounds;
    const frame = this.frameTargets;
    if (frame) return (frame.stage ??= stageBounds(this.zones.list(), this.venue.installed()));
    return stageBounds(this.zones.list(), this.venue.installed());
  }

  /** Where a new target's point starts: the middle of its bounds (the stage volume without its own), at a standing person's face. */
  newTargetPoint(bounds?: Bounds): Point3 {
    const b = bounds ?? this.targetBounds({});
    return clampPoint({ x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: 1.5 }, b);
  }

  /** The installed moving heads a target moves, each once: its fixtures in their order, then its group's by X. */
  targetHeads(t: Pick<Target, "fixtures" | "group">): string[] {
    const cached = this.frameTargets?.heads.get(t);
    if (cached) return cached;
    const heads = new Set(this.movingHeads());
    const mine = [...new Set([...t.fixtures.filter((f) => heads.has(f)), ...(t.group ? this.groupHeads(t.group) : [])])];
    this.frameTargets?.heads.set(t, mine);
    return mine;
  }

  /** Where a target's point is now: its point within its bounds, gliding per axis when it has a smoothing. */
  targetPoint(t: Target): Point3 {
    const b = this.targetBounds(t);
    const p = clampPoint(t.point, b);
    if (!t.smoothing) return p;
    this.glidingTargets.add(t.id);
    this.targetsRead?.add(t.id);
    const now = this.host.now();
    const axis = (a: StageAxis) => fromNormal(a, this.targetGlide.value(`${t.id}:${a}`, toNormal(a, p[a], b), t.smoothing, now), b);
    return { x: axis("x"), y: axis("y"), z: axis("z") };
  }

  /** Moves a target's point (the axes given), bounded: live state, written without a backup. */
  moveTarget(id: string, p: Partial<Point3>): Target {
    const t = this.targets.get(id);
    if (!t) throw new Error(say(`cible inconnue : ${id}`, `unknown target: ${id}`));
    return this.targets.putLive({ ...t, point: clampPoint({ ...t.point, ...p }, this.targetBounds(t)) });
  }

  /**
   * Engages or disengages a target. Engaged, it claims its heads at the target layer, ordered by `engagedAt` (strictly
   * increasing: the last engaged wins a head two targets share, restart included); its point starts where it is (no
   * glide of the point on engaging: the heads' transition is the motion layer's). Engaging a target already engaged
   * puts it back on top (decision T-a): a new order, hence a new claim key, which also lifts a « Rendre la main » on it;
   * its point keeps gliding where it is. Disengaging a target that is not engaged changes nothing.
   */
  engageTarget(id: string, on: boolean, at = Date.now()): Target {
    const t = this.targets.get(id);
    if (!t) throw new Error(say(`cible inconnue : ${id}`, `unknown target: ${id}`));
    if (!on) return t.engaged ? this.targets.putLive({ ...t, engaged: false }) : t;
    if (!t.engaged) for (const a of STAGE_AXES) this.targetGlide.forget(`${id}:${a}`);
    const last = Math.max(0, ...this.targets.list().map((x) => x.engagedAt ?? 0));
    return this.targets.putLive({ ...t, engaged: true, engagedAt: Math.max(Math.round(at), last + 1) });
  }

  /** Panic (T24, decision Q2): every target disengaged; the heads hold where they are. Returns the ids disengaged. */
  disengageTargets(): string[] {
    return this.targets.list().flatMap((t) => (t.engaged ? [this.engageTarget(t.id, false).id] : []));
  }

  /**
   * Where `head` points to follow `point`: the solution closest to `from` (never the long way round), or why it holds
   * there (out of reach, the point in a no-aim zone closed now, no stage position).
   */
  private aimFor(head: string, point: Point3, from: Position | undefined, noAim: readonly Zone[]): Position | { error: string; hold: TargetHold } {
    const r = this.venue.resolve(head);
    const res = aimHead("error" in r ? undefined : aimSetupOf(r), point, from, noAim);
    if (!("held" in res)) return res;
    const { held: _held, message, ...hold } = res;
    return { error: message, hold };
  }

  /** Why a head holds for a target, as data, from the error the motion report gives (the last frame rendered). */
  holdOf(error: string): TargetHold | undefined {
    return this.aimHolds.get(error);
  }

  /**
   * `ctx.presetOf` of the motion layer (T32): a named position for one head of a claim, read at render. A point aims as
   * a target does (`aim`: from the claim's last base for a shape, else from the position sent); undefined for an id
   * that names no position (the layer holds the head and says so).
   */
  private presetOfClaim(id: string, head: string, claim: MotionClaim, aim: (head: string, point: Point3, claim: MotionClaim) => Position | { error: string }): Position | { error: string } | undefined {
    const p = this.positionPresets.get(id);
    if (!p) return undefined;
    return p.point ? aim(head, p.point, claim) : this.presetPosition(id, head);
  }

  /** The no-aim zones closed now: those no playing look of their `allowLooks` opens (the guard's reading). */
  closedNoAim(): Zone[] {
    const playing = new Set(this.host.activeLooks());
    return this.zones.list().filter((z) => z.noAim && !z.allowLooks.some((l) => playing.has(l)));
  }

  /** Who places the axis a pan or tilt channel drives, on the last frame rendered (ChannelExplanation.motion); undefined for any other channel. */
  explain(fixtureId: string, r: ResolvedFixture, offset: number): MotionExplanation | undefined {
    const channel: Axis | undefined = r.pan && (r.pan.coarse === offset || r.pan.fine === offset) ? "pan" : r.tilt && (r.tilt.coarse === offset || r.tilt.fine === offset) ? "tilt" : undefined;
    const status = this.lastMotion.get(fixtureId);
    if (!channel || !status) return undefined;
    const axis: Axis = r.patch.orientation?.swapPanTilt ? (channel === "pan" ? "tilt" : "pan") : channel;
    const a = status[axis];
    const nameOf = ownerNamer({ looks: this.looks, targets: this.targets });
    const named = (owner: string) => {
      const name = nameOf(owner);
      return name === undefined ? {} : { name };
    };
    const masked: MotionExplanation["masked"] = [];
    for (const c of this.motionClaims(this.movingHeads(), this.host.now(), this.host.tempo.state().beats)) {
      if (!c.heads.includes(fixtureId) || !claimsAxis(c, axis) || c.owner === a.owner || masked.some((m) => m.owner === c.owner)) continue;
      masked.push({ owner: c.owner, ...named(c.owner), ...(status.released.includes(claimKey(c)) ? { released: true as const } : {}) });
    }
    return {
      axis,
      layer: a.layer,
      owner: a.owner,
      ...(a.owner ? named(a.owner) : {}),
      lock: status.lock,
      position: a.position,
      moving: a.moving,
      ...(a.moving && a.from !== undefined ? { from: a.from } : {}),
      ...(a.moving && a.target !== undefined ? { to: a.target } : {}),
      ...(a.moving && a.remainingMs !== undefined ? { remainingMs: Math.round(a.remainingMs) } : {}),
      ...(a.error === undefined ? {} : { error: a.error }),
      masked,
    };
  }

  /**
   * T26, hard lock: the pan/tilt bytes (coarse and fine) of each hard-locked head are written back to where it is held,
   * over whatever wrote them after the motion layer — a channel fader on pan/tilt, a raw channel of a fixture patched
   * over it — except the slots the DMX console forces, its last resort (decision Q4). Before the locked rules and the
   * speed limits, which still bound it, and the forbidden zones, which still darken it.
   */
  freezeHard(buffers: Uint8Array[]): void {
    if (!this.lockHeld.size) return;
    let forced: ReadonlyMap<number, ReadonlySet<number>> | undefined;
    const now = this.host.now();
    for (const head of this.movingHeads()) {
      const held = this.heldAt(head, now);
      if (!held || this.host.motionLock(head) !== "hard") continue;
      const r = this.venue.resolve(head);
      const buf = "error" in r ? undefined : buffers[r.patch.universe - 1];
      if ("error" in r || !buf) continue;
      forced ??= this.host.consoleSlots();
      const parked = forced.get(r.patch.universe);
      const at = r.patch.address - 1;
      // as held, not bounded again: a stop changed while the head is frozen must not move it
      this.venue.writePosition(
        r,
        held,
        (offset, value) => {
          const index = at + offset;
          if (index < 512 && !parked?.has(index)) buf[index] = value;
        },
        { unbounded: true },
      );
    }
  }

  /**
   * T8, useful stops: the pan/tilt bytes of each head with stops (`orientation.limits`) are read back from the output,
   * bounded and written again — the motion layer bounds what it writes (Venue.writePosition), but a channel fader on
   * pan/tilt or a raw channel of a fixture patched over it writes after it. The slots the DMX console forces stay its
   * own (its last resort, as for the hard lock); a head frozen hard stays where it is held (freezeHard, unbounded).
   */
  boundToStops(buffers: Uint8Array[]): void {
    let forced: ReadonlyMap<number, ReadonlySet<number>> | undefined;
    const time = this.host.now();
    for (const head of this.movingHeads()) {
      const r = this.venue.resolve(head);
      if ("error" in r || !r.patch.orientation?.limits) continue;
      if (this.host.motionLock(head) === "hard" && this.heldAt(head, time)) continue;
      const buf = buffers[r.patch.universe - 1];
      if (!buf) continue;
      const read = this.venue.sentPosition(r, buf);
      const now = { pan: read.pan ?? 0.5, tilt: read.tilt ?? 0.5 };
      const bounded = boundPosition({ panMax: r.panMax, tiltMax: r.tiltMax, limits: r.patch.orientation.limits }, now);
      // within one 16-bit step: what writePosition itself sent for a position at the stop (its rounding)
      if (Math.abs(bounded.pan - now.pan) <= 1 / 65535 && Math.abs(bounded.tilt - now.tilt) <= 1 / 65535) continue;
      forced ??= this.host.consoleSlots();
      const parked = forced.get(r.patch.universe);
      const at = r.patch.address - 1;
      this.venue.writePosition(r, bounded, (offset, value) => {
        const index = at + offset;
        if (index < 512 && !parked?.has(index)) buf[index] = value;
      });
    }
  }
}
