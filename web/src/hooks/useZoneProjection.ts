import { useCallback, useEffect, useRef, useState } from "react";
import { cmd } from "../api";
import { useCommandEvents } from "./useTopic";

/** A pad point: logical pan and tilt, 0..1 (stage.zone.project, as position.set). */
export type PadPoint = [number, number];

/** An aiming zone as one moving head sees it (T27, lot 5; `stage.zone.project`, venue/zone-project.ts). */
export interface ProjectedZone {
  id: string;
  name: string;
  color?: string;
  paths: PadPoint[][];
  closed: boolean;
  aim?: PadPoint;
  reach: "full" | "partial" | "none";
}

/**
 * What changes a projection: the venue (the head's place, mount, orientation, stops), the zones, a calibration applied,
 * another show or venue, an undo. Read-only commands are never announced, so stage.zone.project does not call itself.
 */
const CHANGES = ["venue.", "stage.zone.", "calibration.solve", "calibration.correct", "show.open", "import.", "history."];

/**
 * The aiming zones as `fixture` sees them, for its pad (T27, lot 5): read once, then again when something that changes
 * them succeeds (the server keeps each projection per head setup and zone, so a read that changes nothing costs little).
 * A reply for a head no longer shown is dropped. Absent fixture: nothing read.
 */
export function useZoneProjection(fixture: string | undefined): ProjectedZone[] {
  const [zones, setZones] = useState<ProjectedZone[]>([]);
  const current = useRef(fixture);
  current.current = fixture;
  // useCommandEvents keeps the function it was first given: it reads the head shown through the ref
  const read = useCallback(() => {
    const id = current.current;
    if (!id) return;
    cmd<{ fixture: string; zones: ProjectedZone[] }>("stage.zone.project", { fixture: id }).then(
      (reply) => {
        if (current.current === id) setZones(reply?.zones ?? []);
      },
      () => {
        if (current.current === id) setZones([]);
      },
    );
  }, []);
  useEffect(() => {
    setZones([]);
    read();
  }, [fixture, read]);
  useCommandEvents(CHANGES, read);
  return zones;
}
