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
  program?: string;
  notes?: string;
}
export interface CueDraft {
  id: string;
  atBar: number;
  beat: number;
  command: string;
  args: Record<string, unknown>;
  label?: string;
}
/** Timeline actions offered in the editor; any other command stays editable as JSON. */
const CUE_COMMANDS: Record<string, { target?: "look" | "group"; value?: "level" | "on" | "mute" }> = {
  "look.go": { target: "look" },
  "look.stop": { target: "look" },
  "group.level": { target: "group", value: "level" },
  "group.flash": { target: "group", value: "on" },
  "group.mute": { target: "group", value: "mute" },
  blackout: { value: "on" },
};
export interface SongDraft {
  id: string;
  title: string;
  key?: string;
  bpm: number;
  beatsPerBar: number;
  mood: string[];
  palette?: string;
  sections: SectionDraft[];
  cues?: CueDraft[];
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
  const [groups, setGroups] = useState<Named[]>([]);
  const [programs, setPrograms] = useState<Named[]>([]);
  const [error, setError] = useState("");
  const isNew = !song.id;

  useEffect(() => {
    void cmd<Named[]>("look.list").then(setLooks);
    void cmd<Named[]>("palette.list").then(setPalettes);
    void cmd<Named[]>("group.list").then(setGroups);
    void cmd<{ programs: Named[] }>("program.list").then((r) => setPrograms(r.programs));
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

  const cues = song.cues ?? [];
  const setCue = (i: number, patch: Partial<CueDraft>) => set({ cues: cues.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const addCue = () => {
    const last = cues.at(-1);
    set({ cues: [...cues, { id: uniqueId("action", cues.map((c) => c.id)), atBar: last ? last.atBar + 1 : 0, beat: 0, command: "group.flash", args: { id: groups[0]?.id ?? "", on: true } }] });
  };
  const spans = placed(song.sections);
  const total = Math.max(1, ...spans.map((p) => p.end), ...cues.map((c) => c.atBar + 1));

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
        {cues.map((c) => (
          <span key={c.id} className="cue-mark" style={{ left: `${((c.atBar + c.beat / song.beatsPerBar) / total) * 100}%` }} title={`${c.label ?? c.command} · ${t.bar} ${c.atBar + 1}.${c.beat + 1}`} />
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
            {programs.length > 0 && <th>{t.programLabel}</th>}
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
              {programs.length > 0 && (
                <td>
                  <select aria-label={`${t.programLabel} ${i + 1}`} value={s.program ?? ""} onChange={(e) => setSection(i, { program: e.target.value || undefined })}>
                    <option value="">—</option>
                    {programs.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </td>
              )}
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

      <h3>{t.cues}</h3>
      {cues.length > 0 && (
        <table className="sections cues">
          <thead>
            <tr>
              <th>{t.barTitle}</th>
              <th>{t.beat}</th>
              <th>{t.action}</th>
              <th>{t.target}</th>
              <th>{t.value}</th>
              <th>{t.labelText}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {cues.map((c, i) => {
              const kind = CUE_COMMANDS[c.command];
              return (
                <tr key={c.id}>
                  <td>
                    <input type="number" min={1} aria-label={`${t.bar} ${i + 1}`} value={c.atBar + 1} onChange={(e) => Number(e.target.value) >= 1 && setCue(i, { atBar: Number(e.target.value) - 1 })} />
                  </td>
                  <td>
                    <input type="number" min={1} max={song.beatsPerBar} step={0.5} value={c.beat + 1} onChange={(e) => Number(e.target.value) >= 1 && setCue(i, { beat: Number(e.target.value) - 1 })} />
                  </td>
                  <td>
                    <select aria-label={`${t.action} ${i + 1}`} value={c.command} onChange={(e) => setCue(i, { command: e.target.value, args: CUE_COMMANDS[e.target.value]?.target === "look" ? { id: looks[0]?.id ?? "" } : CUE_COMMANDS[e.target.value]?.target === "group" ? { id: groups[0]?.id ?? "", ...(e.target.value === "group.level" ? { level: 1 } : e.target.value === "group.mute" ? { mute: true } : { on: true }) } : { on: true } })}>
                      {Object.keys(CUE_COMMANDS).map((k) => (
                        <option key={k} value={k}>
                          {t.cueCommands[k as keyof typeof t.cueCommands]}
                        </option>
                      ))}
                      {!kind && <option value={c.command}>{c.command}</option>}
                    </select>
                  </td>
                  <td>
                    {kind?.target && (
                      <select aria-label={`${t.target} ${i + 1}`} value={String(c.args.id ?? "")} onChange={(e) => setCue(i, { args: { ...c.args, id: e.target.value } })}>
                        {(kind.target === "look" ? looks : groups).map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.name}
                          </option>
                        ))}
                      </select>
                    )}
                    {!kind && <input aria-label="args" defaultValue={JSON.stringify(c.args)} onBlur={(e) => { try { setCue(i, { args: JSON.parse(e.target.value) as Record<string, unknown> }); } catch { setError("JSON"); } }} />}
                  </td>
                  <td>
                    {kind?.value === "level" && <input type="number" min={0} max={100} step={5} aria-label={`${t.value} ${i + 1}`} value={Math.round(Number(c.args.level ?? 1) * 100)} onChange={(e) => setCue(i, { args: { ...c.args, level: Number(e.target.value) / 100 } })} />}
                    {(kind?.value === "on" || kind?.value === "mute") && (
                      <select value={String(c.args[kind.value] ?? true)} onChange={(e) => setCue(i, { args: { ...c.args, [kind.value!]: e.target.value === "true" } })}>
                        <option value="true">{kind.value === "mute" ? t.muteOn : t.on}</option>
                        <option value="false">{kind.value === "mute" ? t.muteOff : t.offAction}</option>
                      </select>
                    )}
                  </td>
                  <td>
                    <input value={c.label ?? ""} onChange={(e) => setCue(i, { label: e.target.value || undefined })} />
                  </td>
                  <td>
                    <button className="ghost" title={t.delete} onClick={() => set({ cues: cues.filter((_, j) => j !== i) })}>
                      ✕
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <button onClick={addCue}>+ {t.action}</button>

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
