/**
 * What the forms of the named positions share (T32): the fixture panel's « Enregistrer cette position… » and the Show
 * page's « Modifier » — the three axes of a point, a number typed in metres, a point written back in the interface's
 * language, and the reply of `position.preset.save`. Pure, for the tests.
 */
import type { Point3 } from "./hooks/useTargets";
import type { PositionRow } from "./hooks/usePositions";

export type Axis = "x" | "y" | "z";
export const AXES: readonly Axis[] = ["x", "y", "z"];

/** A number typed in metres (a decimal comma accepted); NaN when it is not one. */
export const metres = (v: string): number => (v.trim() === "" ? NaN : Number(v.replace(",", ".")));

/** A point as the fields show it, with the interface's decimal mark (« 1,5 » in French); empty fields without one. */
export const pointFields = (p: Point3 | undefined, decimalMark: string): Record<Axis, string> =>
  p ? { x: String(p.x).replace(".", decimalMark), y: String(p.y).replace(".", decimalMark), z: String(p.z).replace(".", decimalMark) } : { x: "", y: "", z: "" };

/** The first axis that is not a number, or undefined when the point reads whole. */
export const wrongAxis = (point: Record<Axis, string>): Axis | undefined => AXES.find((a) => !Number.isFinite(metres(point[a])));

/** The point the fields say (check wrongAxis first). */
export const pointOf = (point: Record<Axis, string>): Point3 => ({ x: metres(point.x), y: metres(point.y), z: metres(point.z) });

/** What `position.preset.save` answers. */
export interface SaveReply {
  position: PositionRow;
  captured?: string[];
  unreachable?: { fixture: string; error: string }[];
}
