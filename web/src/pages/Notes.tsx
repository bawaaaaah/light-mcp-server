import { useCallback, useEffect, useState } from "react";
import { cmd } from "../api";
import { useT } from "../App";

interface Note {
  collection: string;
  id: string;
  name: string;
  notes: string;
}

/** Notes everywhere (docs/specs/presets-songs-notes.md): global search and edit. */
export function NotesPage() {
  const t = useT();
  const [query, setQuery] = useState("");
  const [notes, setNotes] = useState<Note[]>([]);
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const load = useCallback(() => void cmd<Note[]>("notes.search", { query }).then(setNotes).catch((e: Error) => setError(e.message)), [query]);
  useEffect(load, [load]);
  const key = (n: Note) => `${n.collection}/${n.id}`;
  return (
    <div className="notes">
      <section className="bar">
        <input className="search" placeholder={t.search} value={query} onChange={(e) => setQuery(e.target.value)} />
        {error && <span className="error">{error}</span>}
      </section>
      {notes.length === 0 && <p className="hint">{t.noNotes}</p>}
      {notes.map((n) => (
        <div className="report" key={key(n)}>
          <strong>🗒 {n.name}</strong> <small className="hint">({n.collection})</small>
          {editing[key(n)] !== undefined ? (
            <div className="editor">
              <textarea rows={3} value={editing[key(n)]} onChange={(e) => setEditing({ ...editing, [key(n)]: e.target.value })} />
              <button
                className="primary"
                onClick={() =>
                  void cmd("notes.set", { collection: n.collection, id: n.id, notes: editing[key(n)] })
                    .then(() => {
                      const { [key(n)]: _, ...rest } = editing;
                      setEditing(rest);
                      load();
                    })
                    .catch((e: Error) => setError(e.message))
                }
              >
                ✔
              </button>
            </div>
          ) : (
            <p onClick={() => setEditing({ ...editing, [key(n)]: n.notes })}>{n.notes}</p>
          )}
        </div>
      ))}
    </div>
  );
}
