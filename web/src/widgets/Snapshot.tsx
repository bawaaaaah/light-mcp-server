import type { ReactElement } from "react";
import { useT } from "../i18n-context";
import { noKeyRepeat } from "../hooks/useArm";
import { ArmedMark } from "./press";
import type { WidgetProps } from "./env";

/** A snapshot's recall, optionally « À confirmer ». */
export function SnapshotWidget({ w, env }: WidgetProps): ReactElement {
  const t = useT();
  const shot = env.snapshots.find((x) => x.id === w.target);
  if (!shot) return <div className="fill missing">{w.target}</div>;
  return (
    <button className={`fill snapshot ${env.armed === w.id ? "armed" : ""}`} title={t.snapshotButtonHelp} {...env.locked("commands:snapshot")} {...noKeyRepeat} onClick={() => env.confirmed(w.confirm ? w.id : undefined, () => void env.run("snapshot.recall", { id: shot.id }))}>
      ◉ {w.label ?? shot.name}
      <ArmedMark id={w.id} armed={env.armed} />
    </button>
  );
}
