import { useSyncExternalStore } from "react";
import { keepPatched, type PointPatch } from "../target-patches";
import { keepRows } from "../command-store";
import { createPageStore } from "../page-store";

/** A point of the stage, metres (stage.ts: X stage left → right seen from the audience, Y front → upstage, Z up). */
export interface Point3 {
  x: number;
  y: number;
  z: number;
}
export interface Box3 {
  min: Point3;
  max: Point3;
}
export interface Smoothing {
  curve: "linear" | "ease";
  msPerStep: number;
}
import type { MoveFade } from "../../../src/plugins/light/engine/move";
export type { MoveFade };

/** A target as target.list gives it (T24; docs/specs/venue-fixtures-stage.md, « Cible »). */
export interface TargetRow {
  id: string;
  name: string;
  fixtures: string[];
  group?: string;
  point: Point3;
  engaged: boolean;
  engagedAt?: number;
  bounds?: Box3;
  smoothing?: Smoothing;
  fade?: MoveFade;
  color?: string;
  notes?: string;
  /** Its own bounds, else the stage volume. */
  effectiveBounds: Box3;
  /** Its installed moving heads, in order. */
  heads: { id: string; name: string }[];
  /** Among the engaged targets: 1 = engaged last, wins a head it shares. */
  priority?: number;
  sharesWith: string[];
}

/** What a list of targets needs to name them (a widget's menu, the dashboard's editor): re-rendered only when one is renamed, added or removed. */
export interface TargetName {
  id: string;
  name: string;
}

/** Commands after which a target, its heads or its bounds may have changed (target.set aside: below). */
const PREFIXES = ["target.", "show.", "history.", "panic", "snapshot.", "venue.", "group.", "stage.", "import.", "backup."];
/**
 * A burst of target.set (a pad dragged, a MIDI fader: 25 a second) reads the list again at most once every 150 ms, the
 * latest state only: the pad that sent it already has its point from target.set's answer (`patchPoint`).
 */
const SET_READ_MS = 150;

interface TargetsState {
  rows: TargetRow[];
  names: TargetName[];
  loaded: boolean;
}

/** Every name a target had while this page was open: a deleted one is still called by it, not by its id. */
const lastNames = new Map<string, string>();
/** The points target.set answered, kept against a list started before them (target-patches.ts). */
let patches = new Map<string, PointPatch<Point3>>();
let soonTimer: number | undefined;

/** The new rows, each kept as it was when it did not change; `previous` itself when nothing did. */
function next(previous: TargetsState, list: TargetRow[], loaded: boolean): TargetsState {
  for (const r of list) lastNames.set(r.id, r.name);
  const rows = keepRows(previous.rows, list);
  if (rows === previous.rows && loaded === previous.loaded) return previous;
  const names = rows.map((r) => ({ id: r.id, name: r.name }));
  return { rows, names: JSON.stringify(names) === JSON.stringify(previous.names) ? previous.names : names, loaded };
}

/**
 * The show's targets, read once for every screen that shows them (as useMotionHeads does for the heads): a single
 * subscription to the commands, one target.list in flight and one more after it, never one per command. A row keeps
 * its identity while it does not change, so a widget subscribed to one target re-renders only when that one does.
 */
const store = createPageStore<TargetsState, TargetRow[]>({
  command: "target.list",
  initial: { rows: [], names: [], loaded: false },
  prefixes: PREFIXES,
  onCommand: (name) => {
    if (name !== "target.set") return false;
    soonTimer ??= window.setTimeout(() => {
      soonTimer = undefined;
      store.refresh();
    }, SET_READ_MS);
    return true;
  },
  onStop: () => {
    if (soonTimer !== undefined) window.clearTimeout(soonTimer);
    soonTimer = undefined;
  },
  map: (answer, previous, { read, readAgain }) => {
    // a list started before the last target.set and answered after it would move the pad back: keep its point
    const fresh = keepPatched(answer, read, patches);
    patches = fresh.patches;
    if (fresh.stale) readAgain();
    return next(previous, fresh.list, true);
  },
});

const rowOf = (id: string | undefined): TargetRow | undefined => (id === undefined ? undefined : store.get().rows.find((r) => r.id === id));

export const targetsStore = {
  subscribe: store.subscribe,
  getRows: (): TargetRow[] => store.get().rows,
  getNames: (): TargetName[] => store.get().names,
  isLoaded: (): boolean => store.get().loaded,
  lastName: (id: string): string => lastNames.get(id) ?? id,
  row: rowOf,
  /** Reads the list again now (after a command this screen sent: its answer is awaited, the topic may come later). */
  refresh: store.refresh,
  /** The point target.set answered (the pad that moved it): shown at once, without waiting for a list. */
  patchPoint(id: string, point: Point3): void {
    patches.set(id, { read: store.lastRead(), point });
    const current = rowOf(id);
    if (!current || (current.point.x === point.x && current.point.y === point.y && current.point.z === point.z)) return;
    const state = store.get();
    store.set(
      next(
        state,
        state.rows.map((r) => (r.id === id ? { ...r, point } : r)),
        state.loaded,
      ),
    );
  },
};

/** Every target of the show (the venue's « Cibles », the look editor): re-renders whenever one changes. */
export function useTargets(): { targets: TargetRow[]; loaded: boolean; refresh: () => void } {
  const targets = useSyncExternalStore(targetsStore.subscribe, targetsStore.getRows);
  const loaded = useSyncExternalStore(targetsStore.subscribe, targetsStore.isLoaded);
  return { targets, loaded, refresh: targetsStore.refresh };
}

/** The targets' ids and names only (a dashboard, its menus): not re-rendered when a point moves. */
export function useTargetNames(): { names: TargetName[]; loaded: boolean } {
  const names = useSyncExternalStore(targetsStore.subscribe, targetsStore.getNames);
  const loaded = useSyncExternalStore(targetsStore.subscribe, targetsStore.isLoaded);
  return { names, loaded };
}

/** One target (its pad): re-rendered only when that target changes. */
export function useTarget(id: string | undefined): { row: TargetRow | undefined; loaded: boolean } {
  const row = useSyncExternalStore(targetsStore.subscribe, () => targetsStore.row(id));
  const loaded = useSyncExternalStore(targetsStore.subscribe, targetsStore.isLoaded);
  return { row, loaded };
}
