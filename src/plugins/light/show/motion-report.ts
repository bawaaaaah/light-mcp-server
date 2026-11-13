/**
 * Why each moving head is where it is, said to the commands and the UI (T25 lot 4; docs/specs/engine-effects-timing.md,
 * « Couche Mouvement »): `position.list` and the `light:motion` topic read the same report. Pure: the motion layer's
 * status, the position sent and the names of the looks are given.
 */
import type { Position } from "../engine/move.js";
import { ownerOfClaimKey, type AxisLayer, type AxisStatus, type HeadStatus, type LockLevel } from "../engine/motion.js";

/** An owner of the motion layer ("manual", "look:<id>", "target:<id>") and, for a look, its name. */
export interface OwnerRef {
  owner: string;
  name?: string;
}

export interface AxisReport {
  layer: AxisLayer;
  /** One entry per claim still present on this axis (stacked looks repeat "look"), strongest first, rest last; released claims are omitted. */
  layers: AxisLayer[];
  /** The claim key of each `layers` entry, same order (`owner#order`; "" for the structural lock, hold and rest). */
  claims: string[];
  owner: string | null;
  /** The name of the look that holds the axis. */
  name?: string;
  position: number;
  /** A glide is under way: from where, to where, for how many more milliseconds (rounded). */
  moving: boolean;
  /** The look holding the axis draws a moving shape: the position keeps changing without a glide. */
  animated?: true;
  from?: number;
  to?: number;
  remainingMs?: number;
  error?: string;
}

export interface HeadMotion {
  lock: LockLevel;
  pan: AxisReport;
  tilt: AxisReport;
  /** Claims beaten on both axes (« the look X would move it »). */
  masked: OwnerRef[];
  /** Claims « rendre la main » (or `position.home`) released on this head: ignored until they stop claiming it. */
  released: OwnerRef[];
}

function refs(owners: Iterable<string>, nameOf: (owner: string) => string | undefined): OwnerRef[] {
  const out: OwnerRef[] = [];
  for (const owner of new Set(owners)) {
    const name = nameOf(owner);
    out.push(name === undefined ? { owner } : { owner, name });
  }
  return out;
}

function axisReport(a: AxisStatus, nameOf: (owner: string) => string | undefined): AxisReport {
  const name = a.owner ? nameOf(a.owner) : undefined;
  return {
    layer: a.layer,
    layers: [...a.layers],
    claims: [...a.claims],
    owner: a.owner,
    ...(name === undefined ? {} : { name }),
    position: a.position,
    moving: a.moving,
    ...(a.animated ? { animated: true as const } : {}),
    ...(a.moving && a.from !== undefined ? { from: a.from } : {}),
    ...(a.moving && a.target !== undefined ? { to: a.target } : {}),
    ...(a.moving && a.remainingMs !== undefined ? { remainingMs: Math.round(a.remainingMs) } : {}),
    ...(a.error === undefined ? {} : { error: a.error }),
  };
}

/** The report of one head, from its status on the last frame. */
export function headMotion(status: HeadStatus, nameOf: (owner: string) => string | undefined): HeadMotion {
  return {
    lock: status.lock,
    pan: axisReport(status.pan, nameOf),
    tilt: axisReport(status.tilt, nameOf),
    masked: refs(status.masked, nameOf),
    released: refs(status.released.map(ownerOfClaimKey), nameOf),
  };
}

/** A look's name for an owner "look:<id>" (undefined for any other owner, or a look gone). */
export const lookNamer =
  (nameOfLook: (id: string) => string | undefined) =>
  (owner: string): string | undefined =>
    owner.startsWith("look:") ? nameOfLook(owner.slice(5)) : undefined;

/** One head of `position.list` and `light:motion`. */
export interface HeadMotionEntry {
  id: string;
  /** The logical position really sent on the last frame (after the rules and the guard); null before any frame. */
  sent: Position | null;
  /** Where the head goes when nobody claims it, and whether the show sets it (else the centre). */
  rest: Position & { set: boolean };
  /** Null before the first frame rendered. */
  motion: HeadMotion | null;
}

/** What the report needs of the runtime (show/runtime.ts). */
export interface MotionSource {
  movingHeads(): string[];
  motionStatus(): ReadonlyMap<string, HeadStatus>;
  sentPosition(fixture: string): Position | undefined;
  readonly settings: { restPositions: Readonly<Record<string, Position>> };
  readonly looks: { get(id: string): { name: string } | undefined };
}

/** Every installed moving head, why it is where it is. */
export function motionEntries(show: MotionSource): HeadMotionEntry[] {
  const status = show.motionStatus();
  const nameOf = lookNamer((id) => show.looks.get(id)?.name);
  const rests = show.settings.restPositions;
  return show.movingHeads().map((id) => {
    const s = status.get(id);
    const rest = Object.hasOwn(rests, id) ? rests[id] : undefined;
    return {
      id,
      sent: show.sentPosition(id) ?? null,
      rest: rest ? { pan: rest.pan, tilt: rest.tilt, set: true } : { pan: 0.5, tilt: 0.5, set: false },
      motion: s ? headMotion(s, nameOf) : null,
    };
  });
}

/**
 * What a change of the report is made of, for `light:motion`: per head and axis, the layer stack, the owner and its
 * name, a glide started or ended and an error; the lock, the claims masked and released (with their names), the rest.
 * Not the position sent nor the time left: a shape turning or a glide on its way change nothing here, so the topic is
 * not sent every frame.
 */
export function motionKey(show: MotionSource): string {
  const status = show.motionStatus();
  const nameOf = lookNamer((id) => show.looks.get(id)?.name);
  const named = (owner: string | null) => (owner === null ? "" : `${owner}=${nameOf(owner) ?? ""}`);
  const rests = show.settings.restPositions;
  const parts: string[] = [];
  for (const id of show.movingHeads()) {
    const s = status.get(id);
    const rest = Object.hasOwn(rests, id) ? rests[id] : undefined;
    const restKey = rest ? `${rest.pan},${rest.tilt}` : "-";
    if (!s) {
      parts.push(`${id}|${restKey}`);
      continue;
    }
    const axis = (a: AxisStatus) => `${a.layer}:${a.layers.join(">")}:${a.claims.join(">")}:${named(a.owner)}:${a.moving ? 1 : 0}:${a.animated ? 1 : 0}:${a.error ?? ""}`;
    parts.push(`${id}|${restKey}|${s.lock}|${axis(s.pan)}|${axis(s.tilt)}|${s.masked.map(named).join(",")}|${s.released.map((k) => named(ownerOfClaimKey(k)) + k.slice(k.lastIndexOf("#"))).join(",")}`);
  }
  return parts.join("\n");
}
