import type { ReactElement } from "react";
import { useT } from "../i18n-context";
import type { WidgetProps } from "./env";

/** ◀ the song playing and its section ▶. */
export function SongNavWidget({ env }: WidgetProps): ReactElement {
  const t = useT();
  const { locked, run, song } = env;
  return (
    <div className="fill row">
      <button title={t.prevSong} {...locked("commands:trigger")} aria-label={t.prevSong} onClick={() => void run("song.prev")}>◀</button>
      <span className="grow">{song.song ? `${song.song} · ${song.section ?? ""}` : "—"}</span>
      <button title={t.nextSong} {...locked("commands:trigger")} aria-label={t.nextSong} onClick={() => void run("song.next")}>▶</button>
    </div>
  );
}
