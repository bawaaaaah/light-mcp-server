import { useCallback, useEffect, useRef, useState } from "react";
import { cmd } from "../api";
import { useCommandEvents } from "./useTopic";

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

/** Commands after which a target, its heads or its bounds may have changed. */
const PREFIXES = ["target.", "show.", "history.", "panic", "snapshot.", "venue.", "group.", "stage.", "import.", "backup."];

/**
 * The show's targets, read again after a command that may change them. A burst of target.set (a pad, a MIDI fader)
 * reads at most one list at a time and one more after it, never one per command.
 */
export function useTargets(): { targets: TargetRow[]; loaded: boolean; refresh: () => void } {
  const [targets, setTargets] = useState<TargetRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const reading = useRef(false);
  const again = useRef(false);
  const alive = useRef(true);
  const refresh = useCallback(() => {
    if (reading.current) {
      again.current = true;
      return;
    }
    reading.current = true;
    void cmd<TargetRow[]>("target.list")
      .then((list) => {
        if (!alive.current) return;
        setTargets(list);
        setLoaded(true);
      })
      .catch(() => undefined)
      .finally(() => {
        reading.current = false;
        if (again.current && alive.current) {
          again.current = false;
          refresh();
        }
      });
  }, []);
  useEffect(() => {
    alive.current = true;
    refresh();
    return () => {
      alive.current = false;
    };
  }, [refresh]);
  useCommandEvents(PREFIXES, refresh);
  return { targets, loaded, refresh };
}
