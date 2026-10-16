import { useState } from "react";
import { cmd } from "../api";
import { useT } from "../App";

type Versioned = "looks" | "groups" | "faders" | "dashboards";
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "short", timeStyle: "medium" });

/**
 * Earlier versions of an object (the copy the server keeps at each change: history.list), read when
 * opened. Restoring puts one back; the current version is kept in turn, so a restore is undone the
 * same way. A DCA or fader keeps its live level.
 */
export function Versions({ collection, id, onRestored }: { collection: Versioned; id: string; onRestored: () => void }) {
  const t = useT();
  const [list, setList] = useState<{ stamp: string; at: string }[] | null>(null);
  const [error, setError] = useState("");
  const load = () =>
    void cmd<{ stamp: string; at: string }[]>("history.list", { collection, id }).then(setList, (e: Error) => setError(e.message));
  const restore = (v: { stamp: string; at: string }) => {
    if (!confirm(`${t.restoreVersionConfirm}\n\n${t.replacedOn} ${when(v.at)}`)) return;
    void cmd("history.restore", { collection, id, stamp: v.stamp }).then(onRestored, (e: Error) => setError(e.message));
  };
  return (
    <details className="versions" onToggle={(e) => e.currentTarget.open && list === null && load()}>
      <summary>{t.versions}</summary>
      <p className="hint">{t.versionsHelp}</p>
      {list?.length === 0 && <p className="hint">{t.noVersions}</p>}
      <ul>
        {list?.map((v) => (
          <li key={v.stamp}>
            <span>
              {t.replacedOn} {when(v.at)}
            </span>{" "}
            <button onClick={() => restore(v)}>{t.restore}</button>
          </li>
        ))}
      </ul>
      {error && (
        <p className="error" onClick={() => setError("")}>
          {error}
        </p>
      )}
    </details>
  );
}
