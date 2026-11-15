import { useSyncExternalStore } from "react";
import { cmd } from "../api";
import { control } from "../ws";
import type { Point3 } from "./useTargets";

/** A named position as position.preset.list gives it (T32; docs/specs/venue-fixtures-stage.md, « Positions nommées »). */
export interface PositionRow {
  id: string;
  name: string;
  /** Pan/tilt per covered head, or a 3D point every placed head aims at. */
  kind: "pantilt" | "point";
  values: Record<string, { pan: number; tilt: number }>;
  point?: Point3;
  /** The point a pan/tilt position was aimed at when saved: a stale head can be recomputed from it. */
  aim?: Point3;
  aimed?: string[];
  /** Per covered head, the fingerprint of its geometry when saved: put back as it is by a rename (never refreshed). */
  basis: Record<string, string>;
  color?: string;
  tags: string[];
  notes?: string;
  /** The heads it covers, with their names (a point: none). */
  covers: { id: string; name: string }[];
  /** Covered heads moved, rehung or recalibrated since: « à revoir ». */
  stale: string[];
  /** Covered heads no longer installed (ignored by a recall). */
  missing: string[];
}

/**
 * Commands after which a position, its coverage or its freshness may have changed: the positions themselves (but a
 * recall, which changes none), the show, the patch and the stage (a head moved or recalibrated makes one stale).
 */
const PREFIXES = ["position.preset.", "show.", "history.", "venue.", "stage.", "calibration.", "import.", "backup."];
const READS_NOTHING = new Set(["position.preset.go", "position.preset.list"]);

/**
 * The show's named positions, read once for every screen that shows them (the fixture panel, the Show page, the Live's
 * buttons, the look editor): one subscription to the commands, one position.preset.list in flight and one more after it.
 * A row keeps its identity while it does not change.
 */
class PositionsStore {
  private rows: PositionRow[] = [];
  private loaded = false;
  private readonly listeners = new Set<() => void>();
  private reading = false;
  private again = false;
  private stop: (() => void) | undefined;
  /** Every name a position had while this page was open: a deleted one is still called by it, not by its id. */
  private readonly lastNames = new Map<string, string>();

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size) return;
      this.stop?.();
      this.stop = undefined;
    };
  };

  getRows = (): PositionRow[] => this.rows;
  isLoaded = (): boolean => this.loaded;
  lastName = (id: string): string => this.lastNames.get(id) ?? id;

  /** Reads the list again now (after a command this screen sent: its answer is awaited, the event may come later). */
  refresh = (): void => {
    if (this.reading) {
      this.again = true;
      return;
    }
    this.reading = true;
    void cmd<PositionRow[]>("position.preset.list")
      .then((list) => this.set(list))
      .catch(() => undefined)
      .finally(() => {
        this.reading = false;
        if (this.again && this.listeners.size) {
          this.again = false;
          this.refresh();
        }
      });
  };

  private start(): void {
    const offEvents = control.subscribe("light:command", (d) => {
      const e = d as { name: string; ok: boolean };
      if (e.ok && !READS_NOTHING.has(e.name) && PREFIXES.some((p) => e.name.startsWith(p))) this.refresh();
    });
    const offStatus = control.onStatus((up) => up && this.refresh());
    this.stop = () => {
      offEvents();
      offStatus();
    };
    this.refresh();
  }

  private set(list: PositionRow[]): void {
    const before = new Map(this.rows.map((r) => [r.id, r]));
    let changed = !this.loaded || list.length !== this.rows.length;
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
    this.loaded = true;
    for (const fn of [...this.listeners]) fn();
  }
}

export const positionsStore = new PositionsStore();

/** Every named position of the show; `loaded` stays false until the first answer. */
export function usePositions(): { positions: PositionRow[]; loaded: boolean; refresh: () => void } {
  const positions = useSyncExternalStore(positionsStore.subscribe, positionsStore.getRows);
  const loaded = useSyncExternalStore(positionsStore.subscribe, positionsStore.isLoaded);
  return { positions, loaded, refresh: positionsStore.refresh };
}

/** The stored object of a listed position (position.preset.put takes it whole), with its name, colour or point changed. */
export type StoredPosition = Pick<PositionRow, "id" | "name" | "values" | "basis" | "tags" | "point" | "aim" | "aimed" | "color" | "notes">;
export function storedOf(p: PositionRow, patch: { name?: string; color?: string | null; point?: Point3 } = {}): StoredPosition {
  const color = patch.color === null ? undefined : (patch.color ?? p.color);
  return {
    id: p.id,
    name: patch.name ?? p.name,
    values: p.values,
    basis: p.basis,
    tags: p.tags,
    ...(p.point || patch.point ? { point: patch.point ?? p.point } : {}),
    ...(p.aim ? { aim: p.aim } : {}),
    ...(p.aimed ? { aimed: p.aimed } : {}),
    ...(color ? { color } : {}),
    ...(p.notes ? { notes: p.notes } : {}),
  };
}

/** The heads that hold a named position now (recalled and still held by hand), among the heads given. */
export const holding = (id: string, heads: readonly { id: string; recalled?: string }[]): string[] => heads.filter((h) => h.recalled === id).map((h) => h.id);

/** The names of heads a position covers, in order (an id when it no longer names an installed head). */
export const headNames = (p: PositionRow, ids: readonly string[]): string => ids.map((id) => p.covers.find((c) => c.id === id)?.name ?? id).join(", ");
