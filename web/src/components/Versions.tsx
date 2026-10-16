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

interface Gone {
  id: string;
  name?: string;
  stamp: string;
  at: string;
}

/**
 * What was deleted and can come back (history.deleted), by kind, read when opened. Restoring puts
 * the last copy back through the usual checks.
 */
export function RecentlyDeleted({ collections, onRestored }: { collections: Versioned[]; onRestored: () => void }) {
  const t = useT();
  const [lists, setLists] = useState<Partial<Record<Versioned, Gone[]>> | null>(null);
  const [error, setError] = useState("");
  const load = () =>
    void Promise.all(collections.map((c) => cmd<Gone[]>("history.deleted", { collection: c }).then((l) => [c, l] as const)))
      .then((pairs) => setLists(Object.fromEntries(pairs)))
      .catch((e: Error) => setError(e.message));
  const restore = (collection: Versioned, g: Gone) => {
    if (!confirm(`${t.restoreDeletedConfirm} « ${g.name ?? g.id} » ?`)) return;
    void cmd("history.restore", { collection, id: g.id, stamp: g.stamp })
      .then(() => {
        load();
        onRestored();
      })
      .catch((e: Error) => setError(e.message));
  };
  const empty = lists !== null && collections.every((c) => !lists[c]?.length);
  return (
    <details className="versions recently-deleted" onToggle={(e) => e.currentTarget.open && lists === null && load()}>
      <summary>{t.recentlyDeleted}</summary>
      {empty && <p className="hint">{t.nothingDeleted}</p>}
      {collections.map((c) =>
        lists?.[c]?.length ? (
          <div key={c}>
            <h3>{t.collectionNames[c]}</h3>
            <ul>
              {lists[c]!.map((g) => (
                <li key={g.id}>
                  <span>
                    {g.name ?? g.id} <small className="hint">{t.deletedOn} {when(g.at)}</small>
                  </span>{" "}
                  <button onClick={() => restore(c, g)}>{t.restore}</button>
                </li>
              ))}
            </ul>
          </div>
        ) : null,
      )}
      {error && (
        <p className="error" onClick={() => setError("")}>
          {error}
        </p>
      )}
    </details>
  );
}
