/**
 * Channel fader editor (docs/specs/groups-masters.md, « Fader de canaux »): tick fixtures, then the
 * channels to drive by name (Dimmer, Strobe, UV…) — one fader drives them on every ticked fixture
 * at once. Fixtures without a definition take a channel number by hand. Saved with `fader.put`.
 */
import { useEffect, useMemo, useState } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { slug, uniqueId } from "../util";
import { Checklist } from "./GroupEditor";
import { confirmDelete } from "./confirmDelete";
import { Versions } from "./Versions";

export interface FaderDraft {
  id: string;
  name: string;
  channels: { fixture: string; offset: number }[];
  level: number;
  dca?: string;
  notes?: string;
}
export interface FixtureChannels {
  id: string;
  name: string;
  channels: { offset: number; name: string; attribute: string }[];
}

export const newFader = (): FaderDraft => ({ id: "", name: "", channels: [], level: 0 });

export function FaderEditor({ initial, existing, onClose }: { initial: FaderDraft; existing: string[]; onClose: () => void }) {
  const t = useT();
  const [name, setName] = useState(initial.name);
  const [notes, setNotes] = useState(initial.notes);
  const [all, setAll] = useState<FixtureChannels[]>([]);
  const [fixtures, setFixtures] = useState<string[]>([...new Set(initial.channels.map((c) => c.fixture))]);
  const [names, setNames] = useState<string[]>([]);
  const [manual, setManual] = useState<number | "">("");
  const [dca, setDca] = useState(initial.dca ?? "");
  const [dcas, setDcas] = useState<{ id: string; name: string; master?: unknown }[]>([]);
  const [error, setError] = useState("");
  const isNew = !initial.id;
  const id = isNew ? uniqueId(slug(name, "fader"), existing) : initial.id;

  useEffect(() => void cmd<{ id: string; name: string; master?: unknown }[]>("group.list").then((g) => setDcas(g.filter((x) => x.master))), []);
  useEffect(() => {
    void cmd<FixtureChannels[]>("venue.fixture.channels").then((list) => {
      setAll(list);
      // editing: channel names found on the definitions, the rest is a hand-given channel number
      const known = initial.channels.flatMap((c) => list.find((f) => f.id === c.fixture)?.channels.filter((x) => x.offset === c.offset).map((x) => x.name) ?? []);
      setNames([...new Set(known)]);
      const undecoded = initial.channels.find((c) => !list.find((f) => f.id === c.fixture)?.channels.length);
      if (undecoded) setManual(undecoded.offset + 1);
    });
  }, [initial.channels]);

  const ticked = all.filter((f) => fixtures.includes(f.id));
  const channelNames = useMemo(() => {
    const seen = new Map<string, string>();
    for (const f of ticked) for (const c of f.channels) if (!seen.has(c.name)) seen.set(c.name, c.attribute);
    return [...seen].map(([n, attribute]) => ({ id: n, name: `${n} (${t.attributes[attribute as keyof typeof t.attributes] ?? attribute})` }));
  }, [ticked, t]);
  const undecoded = ticked.filter((f) => !f.channels.length);
  const channels = [
    ...ticked.flatMap((f) => f.channels.filter((c) => names.includes(c.name)).map((c) => ({ fixture: f.id, offset: c.offset }))),
    ...(manual === "" ? [] : undecoded.map((f) => ({ fixture: f.id, offset: manual - 1 }))),
  ];

  const save = () => {
    if (!name.trim()) return setError(t.nameRequired);
    if (!channels.length) return setError(t.faderNoChannel);
    void cmd("fader.put", { fader: { id, name, channels, level: initial.level, dca: dca || undefined, notes } })
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
        {undecoded.length > 0 && (
          <label className="field">
            <span>{t.faderManualOffset}</span>
            <input type="number" min={1} max={512} value={manual} onChange={(e) => setManual(e.target.value === "" ? "" : Number(e.target.value))} />
          </label>
        )}
      </div>
      <p className="hint">{t.faderHelp}</p>
      <div className="checklists">
        <Checklist title={t.fixturesMembers} items={all} selected={fixtures} onChange={setFixtures} />
        <Checklist title={t.faderChannels} items={channelNames} selected={names} onChange={setNames} />
      </div>
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
