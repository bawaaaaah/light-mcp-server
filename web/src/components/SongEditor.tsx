/**
 * Song and setlist editors (docs/specs/presets-songs-notes.md, « Chant »): song header (key, tempo,
 * metre, mood = guard rail, palette, start in the DAW), sections (look, cue, idea, length, optional
 * fixed position) with a proportional timeline, and « remplir la grille » (song.grid_fill).
 */
import { useEffect, useState } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { slug, splitList, uniqueId } from "../util";

export interface SectionDraft {
  id: string;
  name: string;
  look?: string;
  cue?: string;
  idea?: string;
  bars: number;
  atBar?: number;
  notes?: string;
}
export interface SongDraft {
  id: string;
  title: string;
  key?: string;
  bpm: number;
  beatsPerBar: number;
  mood: string[];
  palette?: string;
  sections: SectionDraft[];
  startBeat?: number;
  tags: string[];
  notes?: string;
}
export interface SetlistDraft {
  id: string;
  name: string;
  songs: string[];
  notes?: string;
}
interface Named {
  id: string;
  name: string;
  cells?: number;
}

export const newSong = (): SongDraft => ({ id: "", title: "", bpm: 120, beatsPerBar: 4, mood: [], sections: [{ id: "intro", name: "Intro", bars: 8 }], tags: [] });

/** Start bar of each section (same rule as the server's placeSections). */
function placed(sections: SectionDraft[]): { start: number; end: number }[] {
  let cursor = 0;
  return sections.map((s) => {
    const start = s.atBar ?? cursor;
    cursor = start + s.bars;
    return { start, end: cursor };
  });
}

const optNumber = (v: string) => (v === "" ? undefined : Number(v));

export function SongEditor({ initial, existing, onClose }: { initial: SongDraft; existing: string[]; onClose: () => void }) {
  const t = useT();
  const [song, setSong] = useState<SongDraft>(initial);
  const [looks, setLooks] = useState<Named[]>([]);
  const [palettes, setPalettes] = useState<Named[]>([]);
  const [canvases, setCanvases] = useState<Named[]>([]);
  const [canvas, setCanvas] = useState("");
  const [error, setError] = useState("");
  const isNew = !song.id;

  useEffect(() => {
    void cmd<Named[]>("look.list").then(setLooks);
    void cmd<Named[]>("palette.list").then(setPalettes);
    void cmd<Named[]>("venue.canvas.list").then((c) => (setCanvases(c), setCanvas(c[0]?.id ?? "")));
  }, []);

  const id = isNew ? uniqueId(slug(song.title, "chant"), existing) : song.id;
  const set = (patch: Partial<SongDraft>) => setSong((s) => ({ ...s, ...patch }));
  const setSection = (i: number, patch: Partial<SectionDraft>) => set({ sections: song.sections.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const move = (i: number, d: -1 | 1) => {
    const list = [...song.sections];
    const [x] = list.splice(i, 1);
    list.splice(i + d, 0, x!);
    set({ sections: list });
  };
  const addSection = () => {
    const name = `${t.section} ${song.sections.length + 1}`;
    set({ sections: [...song.sections, { id: uniqueId(slug(name, "section"), song.sections.map((s) => s.id)), name, bars: 8 }] });
  };

  const save = async (): Promise<string | undefined> => {
    if (!song.title.trim()) return void setError(t.nameRequired);
    try {
      await cmd("song.put", { song: { ...song, id } });
      return id;
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const fillGrid = async () => {
    const saved = await save();
    if (!saved) return;
    try {
      await cmd("song.grid_fill", { song: saved, canvas, save: true });
      const fresh = (await cmd<SongDraft[]>("song.list")).find((s) => s.id === saved);
      if (fresh) setSong(fresh);
      void cmd<Named[]>("look.list").then(setLooks);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const spans = placed(song.sections);
  const total = Math.max(1, ...spans.map((p) => p.end));

  return (
    <section className="song-editor look-editor">
      <h2>{isNew ? t.newSong : `${t.editLook} · ${initial.title}`}</h2>
      <div className="fields">
        <label className="field">
          <span>{t.title}</span>
          <input value={song.title} onChange={(e) => set({ title: e.target.value })} />
          {isNew && song.title && <small>id : {id}</small>}
        </label>
        <label className="field">
          <span>{t.songKey}</span>
          <input size={4} value={song.key ?? ""} onChange={(e) => set({ key: e.target.value || undefined })} />
        </label>
        <label className="field">
          <span>BPM</span>
          <input type="number" min={20} max={400} value={song.bpm} onChange={(e) => set({ bpm: Number(e.target.value) })} />
        </label>
        <label className="field">
          <span>{t.beatsPerBar}</span>
          <input type="number" min={1} max={16} value={song.beatsPerBar} onChange={(e) => set({ beatsPerBar: Number(e.target.value) })} />
        </label>
        <label className="field">
          <span>{t.moods}</span>
          <input defaultValue={song.mood.join(", ")} onBlur={(e) => set({ mood: splitList(e.target.value) })} />
        </label>
        <label className="field">
          <span>{t.palette}</span>
          <select value={song.palette ?? ""} onChange={(e) => set({ palette: e.target.value || undefined })}>
            <option value="">—</option>
            {palettes.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t.startBeat}</span>
          <input type="number" min={0} value={song.startBeat ?? ""} onChange={(e) => set({ startBeat: optNumber(e.target.value) })} />
        </label>
      </div>

      <div className="timeline" aria-label="timeline">
        {song.sections.map((s, i) => (
          <span key={s.id} className={s.look ? "block" : "block empty"} style={{ left: `${(spans[i]!.start / total) * 100}%`, width: `${((spans[i]!.end - spans[i]!.start) / total) * 100}%` }} title={`${s.name} · ${t.bar} ${spans[i]!.start + 1}`}>
            {s.name}
          </span>
        ))}
      </div>

      <table className="sections">
        <thead>
          <tr>
            <th />
            <th>{t.name}</th>
            <th>Look</th>
            <th>{t.cue}</th>
            <th>{t.idea}</th>
            <th>{t.bars}</th>
            <th>{t.atBar}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {song.sections.map((s, i) => (
            <tr key={s.id}>
              <td>
                <small>{spans[i]!.start + 1}</small>
              </td>
              <td>
                <input aria-label={`${t.section} ${i + 1}`} value={s.name} onChange={(e) => setSection(i, { name: e.target.value })} />
              </td>
              <td>
                <select aria-label={`look ${i + 1}`} value={s.look ?? ""} onChange={(e) => setSection(i, { look: e.target.value || undefined })}>
                  <option value="">—</option>
                  {looks.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <input value={s.cue ?? ""} onChange={(e) => setSection(i, { cue: e.target.value || undefined })} />
              </td>
              <td>
                <input value={s.idea ?? ""} onChange={(e) => setSection(i, { idea: e.target.value || undefined })} />
              </td>
              <td>
                <input type="number" min={0.25} step={1} value={s.bars} onChange={(e) => Number(e.target.value) > 0 && setSection(i, { bars: Number(e.target.value) })} />
              </td>
              <td>
                <input type="number" min={0} placeholder="auto" value={s.atBar ?? ""} onChange={(e) => setSection(i, { atBar: optNumber(e.target.value) })} />
              </td>
              <td>
                <span className="row">
                  <button className="ghost" disabled={i === 0} onClick={() => move(i, -1)}>
                    ↑
                  </button>
                  <button className="ghost" disabled={i === song.sections.length - 1} onClick={() => move(i, 1)}>
                    ↓
                  </button>
                  <button className="ghost" title={t.delete} onClick={() => set({ sections: song.sections.filter((_, j) => j !== i) })}>
                    ✕
                  </button>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button onClick={addSection}>+ {t.section}</button>

      <div className="fields">
        <label className="field">
          <span>tags</span>
          <input defaultValue={song.tags.join(", ")} onBlur={(e) => set({ tags: splitList(e.target.value) })} />
        </label>
      </div>
      <textarea placeholder={t.notes} value={song.notes ?? ""} onChange={(e) => set({ notes: e.target.value || undefined })} />

      <div className="row actions">
        <button className="primary" onClick={() => void save().then((ok) => ok && onClose())}>
          {t.save}
        </button>
        <span className="row" title={t.gridFillHelp}>
          <button disabled={!song.mood.length || !canvas} onClick={() => void fillGrid()}>
            {t.gridFill}
          </button>
          <select aria-label={t.canvas} value={canvas} onChange={(e) => setCanvas(e.target.value)}>
            {canvases.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </span>
        <button className="ghost" onClick={onClose}>
          {t.close}
        </button>
        {!isNew && (
          <button
            className="ghost danger"
            onClick={() => {
              if (confirm(`${t.delete} « ${initial.title} » ?`)) void cmd("song.delete", { id: initial.id }).then(onClose);
            }}
          >
            {t.delete}
          </button>
        )}
        {error && (
          <span className="error" onClick={() => setError("")}>
            {error}
          </span>
        )}
      </div>
    </section>
  );
}

export function SetlistEditor({ initial, songs, existing, onClose }: { initial: SetlistDraft; songs: { id: string; title: string }[]; existing: string[]; onClose: () => void }) {
  const t = useT();
  const [list, setList] = useState<SetlistDraft>(initial);
  const [error, setError] = useState("");
  const isNew = !list.id;
  const id = isNew ? uniqueId(slug(list.name, "setlist"), existing) : list.id;
  const title = (sid: string) => songs.find((s) => s.id === sid)?.title ?? sid;
  const move = (i: number, d: -1 | 1) => {
    const s = [...list.songs];
    const [x] = s.splice(i, 1);
    s.splice(i + d, 0, x!);
    setList({ ...list, songs: s });
  };

  return (
    <section className="setlist-editor look-editor">
      <h2>{isNew ? t.newSetlist : `${t.editLook} · ${initial.name}`}</h2>
      <div className="fields">
        <label className="field">
          <span>{t.name}</span>
          <input value={list.name} onChange={(e) => setList({ ...list, name: e.target.value })} />
        </label>
      </div>
      <ol className="setlist-songs">
        {list.songs.map((sid, i) => (
          <li key={`${sid}-${i}`} className="row">
            <span className="grow">{title(sid)}</span>
            <button className="ghost" disabled={i === 0} onClick={() => move(i, -1)}>
              ↑
            </button>
            <button className="ghost" disabled={i === list.songs.length - 1} onClick={() => move(i, 1)}>
              ↓
            </button>
            <button className="ghost" title={t.delete} onClick={() => setList({ ...list, songs: list.songs.filter((_, j) => j !== i) })}>
              ✕
            </button>
          </li>
        ))}
      </ol>
      <select aria-label={t.addSong} value="" onChange={(e) => e.target.value && setList({ ...list, songs: [...list.songs, e.target.value] })}>
        <option value="">+ {t.addSong}</option>
        {songs.map((s) => (
          <option key={s.id} value={s.id}>
            {s.title}
          </option>
        ))}
      </select>
      <div className="row actions">
        <button
          className="primary"
          onClick={() => {
            if (!list.name.trim()) return setError(t.nameRequired);
            void cmd("setlist.put", { setlist: { ...list, id } })
              .then(onClose)
              .catch((e: Error) => setError(e.message));
          }}
        >
          {t.save}
        </button>
        <button className="ghost" onClick={onClose}>
          {t.close}
        </button>
        {error && (
          <span className="error" onClick={() => setError("")}>
            {error}
          </span>
        )}
      </div>
    </section>
  );
}
