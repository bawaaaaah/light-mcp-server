import type { ReactElement } from "react";
import type { WidgetProps } from "./env";

/** A song's section (target « song:section »): goes there, lit while it plays. */
export function SectionWidget({ w, env }: WidgetProps): ReactElement {
  const [songId, sectionId] = (w.target ?? "").split(":");
  const on = env.song.song === songId && env.song.section === sectionId;
  return (
    <button className={`fill look ${on ? "on" : ""}`} {...env.locked("commands:trigger")} onClick={() => void env.run("song.section.go", { song: songId, section: sectionId })}>
      {w.label ?? sectionId}
    </button>
  );
}
