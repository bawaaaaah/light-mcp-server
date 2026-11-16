import { useSyncExternalStore } from "react";
import { keepRows } from "../command-store";
import { createPageStore } from "../page-store";
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
 * recall, which changes none), the show, the patch and the stage (a head moved or recalibrated makes one stale), a head's own settings (`fixture.`: its
 * travel, its stops, its mode).
 */
const PREFIXES = ["position.preset.", "show.", "history.", "venue.", "stage.", "calibration.", "fixture.", "import.", "backup."];
const READS_NOTHING = ["position.preset.go", "position.preset.list"];

interface PositionsState {
  rows: PositionRow[];
  loaded: boolean;
}

/** Every name a position had while this page was open: a deleted one is still called by it, not by its id. */
const lastNames = new Map<string, string>();

/**
 * The show's named positions, read once for every screen that shows them (the fixture panel, the Show page, the Live's
 * buttons, the look editor): one subscription to the commands, one position.preset.list in flight and one more after it.
 * A row keeps its identity while it does not change.
 */
const store = createPageStore<PositionsState, PositionRow[]>({
  command: "position.preset.list",
  initial: { rows: [], loaded: false },
  prefixes: PREFIXES,
  ignore: READS_NOTHING,
  loaded: (s) => s.loaded,
  map: (list, previous) => {
    for (const r of list) lastNames.set(r.id, r.name);
    const rows = keepRows(previous.rows, list);
    return previous.loaded && rows === previous.rows ? previous : { rows, loaded: true };
  },
});

export const positionsStore = {
  subscribe: store.subscribe,
  getRows: (): PositionRow[] => store.get().rows,
  isLoaded: (): boolean => store.get().loaded,
  lastName: (id: string): string => lastNames.get(id) ?? id,
  /** Reads the list again now (after a command this screen sent: its answer is awaited, the event may come later). */
  refresh: store.refresh,
};

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
