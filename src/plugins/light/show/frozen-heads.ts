/**
 * « Figer les lyres » (T26; docs/specs/rules-limits.md, « Verrou des lyres »): where each locked head is held
 * (`held`, logical pan/tilt), kept in line with the lock levels frame after frame, written to show.json (at once on a
 * freeze or a release, a second after the pad's last move under a soft lock, never inside a frame), the glide of a show
 * opened over heads sent elsewhere (decision D4), and the hard lock written back over the output. The levels
 * themselves are the show's (`ShowRuntime.motionLock`); the motion layer (show/motion-controller.ts) owns this and
 * hands it what it reads of the heads.
 */
import { FALLBACK_BPM, motionDurationMs, UNLOCK_MIN_MS, type Axis, type HeadStatus, type LockLevel } from "../engine/motion.js";
import type { Position } from "../engine/move.js";
import { hermiteAt } from "../engine/hermite.js";
import type { Venue } from "../venue/venue.js";
import type { ShowSettings } from "./model.js";
import { heldOf, lockState, sameFlips, sameLock, type HeadFlips, type MotionLock, type MotionLockState } from "./motion-lock.js";

/** T26: a soft-locked head moved by the pad is written to show.json this long after the last move (and a failed write retried). */
export const HELD_WRITE_DELAY_MS = 1000;

/** What the lock reads: the clock, the settings and their one writer, the lock and console hooks, and the heads. */
export interface FrozenHeadsHost {
  readonly venue: Pick<Venue, "resolve" | "writePosition">;
  now(): number;
  settings(): Readonly<ShowSettings>;
  /** Sets the show's motion lock (its levels and `held`): in memory, and written to show.json when `persist`. */
  setMotionLock(lock: MotionLock, opts: { persist: boolean }): void;
  /** The effective lock level of a head (`ShowRuntime.motionLock`, a hook). */
  motionLock(head: string): LockLevel;
  /** The slots (0-based, per universe) the DMX console forces. */
  consoleSlots(): ReadonlyMap<number, ReadonlySet<number>>;
  /** The installed moving heads. */
  movingHeads(): string[];
  /** The logical position a head was really sent on the last frame. */
  sent(head: string): Position | undefined;
  /** Why the head is where it is, on the last frame rendered. */
  status(head: string): HeadStatus | undefined;
}

export class FrozenHeads {
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

  constructor(private readonly host: FrozenHeadsHost) {
    this.lockHeld = heldOf(host.settings().motionLock);
  }

  /**
   * The lock of the show just (re)loaded (`ShowRuntime.reloadSettings`): its heads where that show froze them (what was
   * pending for the show before is the caller's to flush first: flushHeld).
   */
  reload(): void {
    this.lockHeld = heldOf(this.host.settings().motionLock);
    this.lockLevels.clear();
    this.heldDirtySince = undefined;
    this.heldUrgent = false;
    // decision D4: heads already sent somewhere glide to where the opened show holds them; after a restart (nothing
    // sent yet) they take it at once on the first frame
    this.lockArrivals.clear();
    for (const [head, to] of this.lockHeld) {
      const from = this.host.sent(head);
      if (from && this.host.motionLock(head) !== "off" && (from.pan !== to.pan || from.tilt !== to.tilt)) this.lockArrivals.set(head, { from });
    }
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

  /**
   * Sets the lock levels (global and per head) as given — the commands (lot 3) decide what may harden or loosen.
   * A head newly locked is frozen where it was really sent; a soft lock hardening is frozen again there; a head
   * unlocked forgets where it was held and glides back to what claims it (at least a second). Saved in show.json.
   */
  setLock(state: MotionLockState): void {
    // the same levels: nothing to do, nothing written (a show without a lock does not get `motionLock: off`)
    if (sameLock(state, lockState(this.host.settings().motionLock))) return;
    // the levels in effect first, `held` brought in line with them, then one write
    this.host.setMotionLock({ level: state.level, heads: { ...state.heads }, held: Object.fromEntries(this.lockHeld) }, { persist: false });
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
    this.host.setMotionLock({ level: lock?.level ?? "off", heads, held: Object.fromEntries(this.lockHeld) }, { persist: false });
    this.heldUrgent = true;
    this.flushHeld();
  }

  /**
   * Whether new pan/tilt inversions or swap would move a hard-frozen moving head (T26): its frozen position is logical,
   * its bytes follow them, so the change is refused until it is unfrozen. False for any other head or the same flips.
   */
  flipsMoveFrozen(fixture: string, before: HeadFlips, after: HeadFlips): boolean {
    return this.host.motionLock(fixture) === "hard" && this.host.movingHeads().includes(fixture) && !sameFlips(before, after);
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
    for (const head of this.host.movingHeads()) {
      const level = this.host.motionLock(head);
      const was = this.lockLevels.get(head);
      this.lockLevels.set(head, level);
      if (level === "off") continue; // dropped below, with the heads no longer listed
      const sent = this.host.sent(head);
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
      const status = this.host.status(head);
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
    if (lock || this.lockHeld.size) this.host.setMotionLock({ ...lockState(lock), held: Object.fromEntries(this.lockHeld) }, { persist: true });
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
  heldAt(head: string, now: number): Position | undefined {
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
   * T26, hard lock: the pan/tilt bytes (coarse and fine) of each hard-locked head are written back to where it is held,
   * over whatever wrote them after the motion layer — a channel fader on pan/tilt, a raw channel of a fixture patched
   * over it — except the slots the DMX console forces, its last resort (decision Q4). Before the locked rules and the
   * speed limits, which still bound it, and the forbidden zones, which still darken it.
   */
  freezeHard(buffers: Uint8Array[]): void {
    if (!this.lockHeld.size) return;
    let forced: ReadonlyMap<number, ReadonlySet<number>> | undefined;
    const now = this.host.now();
    for (const head of this.host.movingHeads()) {
      const held = this.heldAt(head, now);
      if (!held || this.host.motionLock(head) !== "hard") continue;
      const r = this.host.venue.resolve(head);
      const buf = "error" in r ? undefined : buffers[r.patch.universe - 1];
      if ("error" in r || !buf) continue;
      forced ??= this.host.consoleSlots();
      const parked = forced.get(r.patch.universe);
      const at = r.patch.address - 1;
      // as held, not bounded again: a stop changed while the head is frozen must not move it
      this.host.venue.writePosition(
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
}
