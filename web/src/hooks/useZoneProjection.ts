import type { Domain } from "../../../src/plugins/light/commands/domains.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { cmd } from "../api";
import { useDomainEvents } from "./useTopic";
import type { PadHead, ProjectedZone } from "../pad-zones";

/** What `stage.zone.project` answers for one head (T27, lot 5): its aiming data and its aiming zones, or why none. */
export interface ZoneProjection {
  head?: PadHead;
  zones: ProjectedZone[];
  /** The head has no stage position: nothing can be projected. */
  reason?: "no-position";
}

const EMPTY: ZoneProjection = { zones: [] };

/**
 * What changes a projection: the venue (the head's place, mount, orientation, stops), the zones, a calibration, another
 * show or venue, an import, an undo, a backup put back, a fixture definition (its travel). Read-only commands are never
 * announced, so stage.zone.project does not call itself.
 */
export const PROJECTION_CHANGES: readonly Domain[] = ["patch", "zones", "calibration", "show"];

/**
 * The aiming zones as `fixture` sees them, for its pad (T27, lot 5): read once, then again when something that changes
 * them succeeds. Only the latest read is kept (a slow answer to an earlier one never overwrites it), and a reply for a
 * head no longer shown is dropped. Absent fixture: nothing read.
 */
export function useZoneProjection(fixture: string | undefined): ZoneProjection {
  const [projection, setProjection] = useState<ZoneProjection>(EMPTY);
  const current = useRef(fixture);
  current.current = fixture;
  const sequence = useRef(0);
  // useDomainEvents keeps the function it was first given: it reads the head shown through the ref
  const read = useCallback(() => {
    const id = current.current;
    const asked = ++sequence.current;
    if (!id) return;
    const latest = () => asked === sequence.current && current.current === id;
    cmd<ZoneProjection & { fixture: string }>("stage.zone.project", { fixture: id }).then(
      (reply) => {
        if (latest()) setProjection({ zones: reply?.zones ?? [], ...(reply?.head ? { head: reply.head } : {}), ...(reply?.reason ? { reason: reply.reason } : {}) });
      },
      () => {
        if (latest()) setProjection(EMPTY);
      },
    );
  }, []);
  useEffect(() => {
    setProjection(EMPTY);
    read();
  }, [fixture, read]);
  useDomainEvents(PROJECTION_CHANGES, read);
  return projection;
}
