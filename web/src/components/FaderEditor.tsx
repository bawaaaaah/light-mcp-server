/**
 * Channel fader editor (docs/specs/groups-masters.md, « Fader de canaux »): tick fixtures, then the
 * channels to drive by name (Dimmer, Strobe, UV…) — one fader drives them on every ticked fixture
 * at once. Fixtures without a definition take a channel number by hand. Saved with `fader.put`.
 */
import { useEffect, useState } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { slug, uniqueId } from "../util";
import { ChannelTree, type PickedChannel } from "./ChannelTree";
import { confirmDelete } from "./confirmDelete";
import { SmoothingField, type Smoothing } from "./SmoothingField";
import { Versions } from "./Versions";

export interface FaderDraft {
  id: string;
  name: string;
  channels: { fixture: string; offset: number }[];
  level: number;
  /** The DMX values its travel covers (QLC+'s low and high limits). */
  range?: { min: number; max: number };
  dca?: string;
  smoothing?: Smoothing;
  notes?: string;
}
export interface FixtureChannels {
  id: string;
  name: string;
  universe: number;
  address: number;
  type?: string;
  /** The fixture's marker colour (venue.fixture.mark). */
  color?: string;
  /** ranges: the named functions of a channel cut into several (a mode, a colour preset, a macro). */
  channels: { offset: number; name: string; attribute: string; color?: string; ranges?: { min: number; max: number; name: string }[] }[];
}

export const newFader = (): FaderDraft => ({ id: "", name: "", channels: [], level: 0 });

export function FaderEditor({ initial, existing, onClose }: { initial: FaderDraft; existing: string[]; onClose: () => void }) {
  const t = useT();
  const [name, setName] = useState(initial.name);
  const [notes, setNotes] = useState(initial.notes);
  const [all, setAll] = useState<FixtureChannels[]>([]);
  const [channels, setChannels] = useState<PickedChannel[]>(initial.channels);
  const [dca, setDca] = useState(initial.dca ?? "");
  const [range, setRange] = useState(initial.range ?? { min: 0, max: 255 });
  const [smoothing, setSmoothing] = useState(initial.smoothing);
  const [groups, setGroups] = useState<{ id: string; name: string; master?: unknown; members: { fixtures: string[]; groups: string[] } }[]>([]);
  const [error, setError] = useState("");
  const isNew = !initial.id;
  const id = isNew ? uniqueId(slug(name, "fader"), existing) : initial.id;

  useEffect(() => void cmd<typeof groups>("group.list").then(setGroups), []);
  useEffect(() => void cmd<FixtureChannels[]>("venue.fixture.channels").then(setAll), []);
  const dcas = groups.filter((g) => g.master);

  const save = () => {
    if (!name.trim()) return setError(t.nameRequired);
    if (!channels.length) return setError(t.faderNoChannel);
    if (range.min > range.max) return setError(t.rangeOrder);
    const ranged = range.min > 0 || range.max < 255;
    void cmd("fader.put", { fader: { id, name, channels, level: initial.level, ...(ranged ? { range } : {}), dca: dca || undefined, smoothing, notes } })
      .then(onClose)
      .catch((e: Error) => setError(e.message));
  };

  return (
    <section className="fader-editor look-editor">
      <h2>{isNew ? t.newFader : `${t.editLook} · ${initial.name}`}</h2>
      <div className="fields">
        <label className="field">
          <span>{t.name}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
          {isNew && name && <small>id : {id}</small>}
        </label>
        {/* as QLC+'s value range: the fader's whole travel covers low..high only */}
        <label className="field" title={t.rangeHelp}>
          <span>{t.rangeLow}</span>
          <input type="number" min={0} max={255} value={range.min} onChange={(e) => setRange({ ...range, min: Math.max(0, Math.min(255, Number(e.target.value) || 0)) })} />
        </label>
        <label className="field" title={t.rangeHelp}>
          <span>{t.rangeHigh}</span>
          <input type="number" min={0} max={255} value={range.max} onChange={(e) => setRange({ ...range, max: Math.max(0, Math.min(255, Number(e.target.value) || 0)) })} />
        </label>
        <label className="field">
          <span>{t.faderDca}</span>
          <select aria-label={t.faderDca} value={dca} onChange={(e) => setDca(e.target.value)}>
            <option value="">—</option>
            {dcas.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
        <SmoothingField value={smoothing} onChange={setSmoothing} />
      </div>
      <p className="hint">{t.faderHelp}</p>
      <ChannelTree fixtures={all} groups={groups} selected={channels} onChange={setChannels} />
      <p className="hint">
        {channels.length} {t.faderChannelCount}
      </p>
      <textarea placeholder={t.notes} value={notes ?? ""} onChange={(e) => setNotes(e.target.value || undefined)} />
      <div className="row actions">
        <button className="primary" onClick={save}>
          {t.save}
        </button>
        <button className="ghost" onClick={onClose}>
          {t.close}
        </button>
        {!isNew && (
          <button
            className="ghost danger"
            onClick={() => {
              void confirmDelete("fader", initial.id, initial.name, t).then((done) => done && onClose(), (e: Error) => setError(e.message));
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
      {!isNew && <Versions collection="faders" id={initial.id} onRestored={onClose} />}
    </section>
  );
}
