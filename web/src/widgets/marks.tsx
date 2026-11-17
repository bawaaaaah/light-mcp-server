import type { ReactElement } from "react";
import { useT } from "../i18n-context";

/** « → 42 % »: the level sent, beside the level asked, while it glides. */
export function Sent({ level }: { level: number | undefined }): ReactElement | null {
  if (level === undefined) return null;
  return <small className="sent"> → {Math.round(level * 100)}%</small>;
}

/** « ≈ »: the fader is smoothed (docs/specs/groups-masters.md, « Lissage »). */
export function SmoothedMark({ on }: { on: boolean }): ReactElement | null {
  const t = useT();
  return on ? (
    <small className="smoothed-mark" title={t.smoothedMark}>
      {" "}≈
    </small>
  ) : null;
}
