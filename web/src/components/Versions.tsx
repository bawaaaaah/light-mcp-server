import { useState, type ReactElement } from "react";
import { ApiError, cmd } from "../api";
import { useT } from "../App";
import type { Texts } from "../i18n";
import { quoted, beforeMark } from "../typography";

type Versioned = "looks" | "groups" | "faders" | "dashboards" | "canvases";
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "short", timeStyle: "medium" });

/**
 * The question a refused canvas write asks, in the interface's words (the server's sentence names API
 * arguments): the looks whose steps would no longer line up, the shows sharing the venue. Undefined when
 * the error is not such a refusal.
 */
export function canvasQuestion(t: Texts, e: unknown): string | undefined {
  if (!(e instanceof ApiError) || !e.detail?.impact) return undefined;
  const d = e.detail as { impact: { looksAffected: { id: string; name: string }[] }; broken?: string[]; shared?: string[] };
  const looks = d.impact.looksAffected.filter((l) => d.broken?.includes(l.id)).map((l) => quoted(t, l.name));
  const tc = t.canvasEditor;
  return [...(looks.length ? [`${tc.impactSteps} ${looks.join(", ")}`] : []), ...(d.shared?.length ? [`${tc.impactShared} ${d.shared.join(", ")}`] : []), "", `${tc.force}${beforeMark(t)}?`].join("\n");
}

/**
 * Puts a version back (history.restore). A canvas put back is checked as any canvas put (looks of exact
 * steps that would no longer line up, a shared venue): the refusal is said and forced on a yes.
 */
export async function restoreVersion(args: { collection: Versioned; id: string; stamp: string }, t: Texts): Promise<boolean> {
  try {
    await cmd("history.restore", args);
  } catch (e) {
    const question = canvasQuestion(t, e);
    if (question === undefined) throw e;
    if (!confirm(question)) return false;
    await cmd("history.restore", { ...args, force: true });
  }
  return true;
}

/**
 * Earlier versions of an object (the copy the server keeps at each change: history.list), read when
 * opened. Restoring puts one back; the current version is kept in turn, so a restore is undone the
 * same way. A DCA or fader keeps its live level.
 */
export function Versions({
  collection,
  id,
  onRestored,
  help,
  restore: restoreWith,
}: {
  collection: Versioned;
  id: string;
  onRestored: () => void;
  /** What these versions keep, when the usual sentence (a DCA's level) is off the subject. */
  help?: string;
  /** Puts a version back in the caller's own way (an editor that asks in its window); the usual restore otherwise. */
  restore?: (v: { stamp: string; at: string }) => void;
}): ReactElement {
  const t = useT();
  const [list, setList] = useState<{ stamp: string; at: string }[] | null>(null);
  const [error, setError] = useState("");
  const load = () =>
    void cmd<{ stamp: string; at: string }[]>("history.list", { collection, id }).then(setList, (e: Error) => setError(e.message));
  const restore = (v: { stamp: string; at: string }) => {
    if (restoreWith) return restoreWith(v); // the caller asks in its own window, and its undo covers a slip
    if (!confirm(`${t.restoreVersionConfirm}\n\n${t.replacedOn} ${when(v.at)}`)) return;
    void restoreVersion({ collection, id, stamp: v.stamp }, t).then((done) => done && onRestored(), (e: Error) => setError(e.message));
  };
  return (
    <details className="versions" onToggle={(e) => e.currentTarget.open && list === null && load()}>
      <summary>{t.versions}</summary>
      <p className="hint">{help ?? t.versionsHelp}</p>
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
export function RecentlyDeleted({ collections, onRestored }: { collections: Versioned[]; onRestored: () => void }): ReactElement {
  const t = useT();
  const [lists, setLists] = useState<Partial<Record<Versioned, Gone[]>> | null>(null);
  const [error, setError] = useState("");
  const load = () =>
    void Promise.all(collections.map((c) => cmd<Gone[]>("history.deleted", { collection: c }).then((l) => [c, l] as const)))
      .then((pairs) => setLists(Object.fromEntries(pairs)))
      .catch((e: Error) => setError(e.message));
  const restore = (collection: Versioned, g: Gone) => {
    if (!confirm(`${t.restoreDeletedConfirm} ${quoted(t, g.name ?? g.id)}${beforeMark(t)}?`)) return;
    void restoreVersion({ collection, id: g.id, stamp: g.stamp }, t)
      .then((done) => {
        if (!done) return;
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
