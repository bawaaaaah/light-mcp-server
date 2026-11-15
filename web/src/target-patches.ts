/**
 * The points target.set answered (T24, the target pad) against the lists of targets read around them. Reads are
 * numbered as they start; a point patched while read n was the latest started is newer than that read's answer and
 * than every older one: such a list keeps the patched point and asks for one more read. Pure: useTargets keeps the
 * numbers and the patches.
 */

/** A point target.set answered, and the number of the latest read started when it did. */
export interface PointPatch<P> {
  read: number;
  point: P;
}

/**
 * The list read `read` answered, with each point patched since that read started put back; `patches` without the
 * ones this list already carries (it started after them) nor those of a target gone. `stale`: a point was put back,
 * the list must be read again.
 */
export function keepPatched<P, R extends { id: string; point: P }>(list: readonly R[], read: number, patches: ReadonlyMap<string, PointPatch<P>>): { list: R[]; patches: Map<string, PointPatch<P>>; stale: boolean } {
  const kept = new Map<string, PointPatch<P>>();
  let stale = false;
  const rows = list.map((r) => {
    const p = patches.get(r.id);
    if (!p || p.read < read) return r;
    kept.set(r.id, p);
    stale = true;
    return { ...r, point: p.point };
  });
  return { list: rows, patches: kept, stale };
}
