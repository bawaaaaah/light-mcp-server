import { useSyncExternalStore } from "react";
import { cmd } from "../api";
import { control } from "../ws";
import { keepPatched, type PointPatch } from "../target-patches";

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

/**
 * The show's targets, read once for every screen that shows them (as useMotionHeads does for the heads): a single
 * subscription to the commands, one target.list in flight and one more after it, never one per command. A row keeps
 * its identity while it does not change, so a widget subscribed to one target re-renders only when that one does.
 */
class TargetsStore {
  private rows: TargetRow[] = [];
  private names: TargetName[] = [];
  private loaded = false;
  private readonly listeners = new Set<() => void>();
  private reading = false;
  private again = false;
  private timer: number | undefined;
  private stop: (() => void) | undefined;
  /** Every name a target had while this page was open: a deleted one is still called by it, not by its id. */
  private readonly lastNames = new Map<string, string>();
  /** The number of the latest target.list started. */
  private started = 0;
  /** The points target.set answered, kept against a list started before them (target-patches.ts). */
  private patches = new Map<string, PointPatch<Point3>>();

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size) return;
      this.stop?.();
      this.stop = undefined;
      if (this.timer !== undefined) window.clearTimeout(this.timer);
      this.timer = undefined;
    };
  };

  getRows = (): TargetRow[] => this.rows;
  getNames = (): TargetName[] => this.names;
  isLoaded = (): boolean => this.loaded;
  lastName = (id: string): string => this.lastNames.get(id) ?? id;
  row = (id: string | undefined): TargetRow | undefined => (id === undefined ? undefined : this.rows.find((r) => r.id === id));

  /** Reads the list again now (after a command this screen sent: its answer is awaited, the topic may come later). */
  refresh = (): void => {
    if (this.reading) {
      this.again = true;
      return;
    }
    this.reading = true;
    const read = ++this.started;
    void cmd<TargetRow[]>("target.list")
      .then((list) => {
        // a list started before the last target.set and answered after it would move the pad back: keep its point
        const fresh = keepPatched(list, read, this.patches);
        this.patches = fresh.patches;
        if (fresh.stale) this.again = true;
        this.set(fresh.list, true);
      })
      .catch(() => undefined)
      .finally(() => {
        this.reading = false;
        if (this.again && this.listeners.size) {
          this.again = false;
          this.refresh();
        }
      });
  };

  /** The point target.set answered (the pad that moved it): shown at once, without waiting for a list. */
  patchPoint(id: string, point: Point3): void {
    this.patches.set(id, { read: this.started, point });
    const row = this.row(id);
    if (!row || (row.point.x === point.x && row.point.y === point.y && row.point.z === point.z)) return;
    this.set(
      this.rows.map((r) => (r.id === id ? { ...r, point } : r)),
      this.loaded,
    );
  }

  private start(): void {
    const offEvents = control.subscribe("light:command", (d) => {
      const e = d as { name: string; ok: boolean };
      if (!e.ok) return;
      if (e.name === "target.set") this.soon();
      else if (PREFIXES.some((p) => e.name.startsWith(p))) this.refresh();
    });
    const offStatus = control.onStatus((up) => up && this.refresh());
    this.stop = () => {
      offEvents();
      offStatus();
    };
    this.refresh();
  }

  private soon(): void {
    if (this.timer !== undefined) return;
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      this.refresh();
    }, SET_READ_MS);
  }

  /** The new rows, each kept as it was when it did not change; the listeners told only when something did. */
  private set(list: TargetRow[], loaded: boolean): void {
    const before = new Map(this.rows.map((r) => [r.id, r]));
    let changed = list.length !== this.rows.length || loaded !== this.loaded;
    const rows = list.map((r, i) => {
      const old = before.get(r.id);
      if (old && JSON.stringify(old) === JSON.stringify(r)) {
        if (this.rows[i] !== old) changed = true;
        return old;
      }
      changed = true;
      return r;
    });
    for (const r of list) this.lastNames.set(r.id, r.name);
    if (!changed) return;
    this.rows = rows;
    this.loaded = loaded;
    const names = rows.map((r) => ({ id: r.id, name: r.name }));
    if (JSON.stringify(names) !== JSON.stringify(this.names)) this.names = names;
    for (const fn of [...this.listeners]) fn();
  }
}

export const targetsStore = new TargetsStore();

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
