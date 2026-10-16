import { useCallback, useEffect, useState } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { labelOf } from "../util";

interface Note {
  collection: string;
  id: string;
  name: string;
  notes: string;
}

/** A long section starts folded: an import writes a note on every look. */
const OPEN_UP_TO = 20;

/**
 * Notes everywhere (docs/specs/presets-songs-notes.md): global search and edit, grouped by kind
 * (looks, groups, fixtures…), one compact line each; a click edits it.
 */
export function NotesPage() {
  const t = useT();
  const [query, setQuery] = useState("");
  const [notes, setNotes] = useState<Note[]>([]);
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const load = useCallback(() => void cmd<Note[]>("notes.search", { query }).then(setNotes).catch((e: Error) => setError(e.message)), [query]);
  useEffect(load, [load]);
  const key = (n: Note) => `${n.collection}/${n.id}`;
  const groups = new Map<string, Note[]>();
  for (const n of [...notes].sort((a, b) => a.name.localeCompare(b.name))) groups.set(n.collection, [...(groups.get(n.collection) ?? []), n]);
  const save = (n: Note) =>
    void cmd("notes.set", { collection: n.collection, id: n.id, notes: editing[key(n)] })
      .then(() => {
        const { [key(n)]: _, ...rest } = editing;
        setEditing(rest);
        load();
      })
      .catch((e: Error) => setError(e.message));
  return (
    <div className="notes">
      <section className="bar">
        <input className="search" type="search" aria-label={t.search} placeholder={t.search} value={query} onChange={(e) => setQuery(e.target.value)} />
        {error && <span className="error">{error}</span>}
      </section>
      {notes.length === 0 && <p className="hint">{t.noNotes}</p>}
      {[...groups].map(([collection, list]) => (
        // a search opens every group it found something in
        <details key={`${collection}-${Boolean(query.trim())}`} className="note-group" open={Boolean(query.trim()) || list.length <= OPEN_UP_TO}>
          <summary>
            {labelOf(t.noteCollections, collection)} <small className="hint">({list.length})</small>
          </summary>
          <ul>
            {list.map((n) => (
              <li key={key(n)}>
                <strong>{n.name}</strong>
                {editing[key(n)] !== undefined ? (
                  <div className="editor">
                    <textarea rows={3} aria-label={`${t.notes} ${n.name}`} value={editing[key(n)]} onChange={(e) => setEditing({ ...editing, [key(n)]: e.target.value })} />
                    <button className="primary" onClick={() => save(n)}>
                      ✔
                    </button>
                  </div>
                ) : (
                  <p className="note-text" title={t.clickToEdit} onClick={() => setEditing({ ...editing, [key(n)]: n.notes })}>
                    {n.notes}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </details>
      ))}
    </div>
  );
}
