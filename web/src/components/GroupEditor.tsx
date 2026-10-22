/**
 * Group editor (docs/specs/groups-masters.md): name, members (fixtures, looks, sub-groups), DCA
 * (master) on or off, exclusive, looks dosed or excluded by the DCA. Saved with `group.put`.
 */
import { useEffect, useMemo, useState } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { slug, uniqueId } from "../util";
import { confirmDelete } from "./confirmDelete";
import { Versions } from "./Versions";

export interface GroupDraft {
  id: string;
  name: string;
  members: { fixtures: string[]; looks: string[]; groups: string[] };
  master?: { level: number; mute: boolean };
  exclusive: boolean;
  limits?: { min?: number; max?: number; mode?: "clamp" | "scale" };
  presets: { included: string[]; excluded: string[] };
  playback?: boolean;
  notes?: string;
}
interface Named {
  id: string;
  name: string;
  /** Shown beside the name, and searched: a fixture's universe and start address. */
  detail?: string;
}
interface Patched {
  id: string;
  name: string;
  universe: number;
  address: number;
}

/** Fixtures in address order, each with its universe and start address (« U1 · 001 »): found by where it is patched. */
export const byAddress = (list: Patched[]): Named[] =>
  [...list].sort((a, b) => a.universe - b.universe || a.address - b.address).map((f) => ({ id: f.id, name: f.name, detail: `U${f.universe} · ${String(f.address).padStart(3, "0")}` }));

export const newGroup = (): GroupDraft => ({ id: "", name: "", members: { fixtures: [], looks: [], groups: [] }, master: { level: 1, mute: false }, exclusive: false, presets: { included: [], excluded: [] } });

export function Checklist({ title, items, selected, onChange }: { title: string; items: Named[]; selected: string[]; onChange: (ids: string[]) => void }) {
  const t = useT();
  // a long list (a whole patch) is searched by name or address: « barre », « U1 · 04 », « 118 »
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? items.filter((x) => `${x.name} ${x.detail ?? ""}`.toLowerCase().includes(q) || (x.detail && /^\d+$/.test(q) && x.detail.endsWith(q.padStart(3, "0")))) : items;
  }, [items, query]);
  return (
    <fieldset className="checklist">
      <legend>
        {title} ({selected.length})
      </legend>
      {items.length > 8 && <input className="checklist-search" type="search" placeholder={t.searchNameAddress} aria-label={`${title} · ${t.searchNameAddress}`} value={query} onChange={(e) => setQuery(e.target.value)} />}
      {items.length === 0 && <small className="hint">—</small>}
      {shown.map((x) => (
        <label key={x.id} className="row">
          <input type="checkbox" checked={selected.includes(x.id)} onChange={(e) => onChange(e.target.checked ? [...selected, x.id] : selected.filter((s) => s !== x.id))} />
          {x.detail && <small className="detail">{x.detail}</small>}
          {x.name}
        </label>
      ))}
    </fieldset>
  );
}

export function GroupEditor({ initial, existing, onClose }: { initial: GroupDraft; existing: string[]; onClose: () => void }) {
  const t = useT();
  const [g, setG] = useState<GroupDraft>(initial);
  const [fixtures, setFixtures] = useState<Named[]>([]);
  const [looks, setLooks] = useState<Named[]>([]);
  const [groups, setGroups] = useState<Named[]>([]);
  // the channel faders this DCA doses (each fader says it: its « dca »)
  const [faders, setFaders] = useState<(Named & { dca?: string })[]>([]);
  const [dosed, setDosed] = useState<string[]>([]);
  const [error, setError] = useState("");
  const isNew = !initial.id;
  const id = isNew ? uniqueId(slug(g.name, "groupe"), existing) : g.id;

  useEffect(() => {
    void cmd<Patched[]>("venue.fixture.list").then((list) => setFixtures(byAddress(list)));
    void cmd<(Named & { dca?: string })[]>("fader.list").then((list) => {
      setFaders(list);
      setDosed(initial.id ? list.filter((f) => f.dca === initial.id).map((f) => f.id) : []);
    });
    void cmd<Named[]>("look.list", { brief: true }).then(setLooks);
    void cmd<Named[]>("group.list").then((list) => setGroups(list.filter((x) => x.id !== initial.id)));
  }, [initial.id]);

  const members = (k: keyof GroupDraft["members"], ids: string[]) => setG({ ...g, members: { ...g.members, [k]: ids } });
  const save = () => {
    if (!g.name.trim()) return setError(t.nameRequired);
    // the faders ticked now dosed by this DCA, the ones unticked no longer (without a DCA, by none)
    const wanted = (f: { id: string }) => Boolean(g.master) && dosed.includes(f.id);
    const changed = faders.filter((f) => wanted(f) !== (f.dca === id));
    void cmd("group.put", { group: { ...g, id } })
      .then(() => Promise.all(changed.map((f) => cmd("fader.put", { fader: { ...f, dca: wanted(f) ? id : undefined } }))))
      .then(onClose)
      .catch((e: Error) => setError(e.message));
  };

  return (
    <section className="group-editor look-editor">
      <h2>{isNew ? t.newGroup : `${t.editLook} · ${initial.name}`}</h2>
      <div className="fields">
        <label className="field">
          <span>{t.name}</span>
          <input value={g.name} onChange={(e) => setG({ ...g, name: e.target.value })} />
          {isNew && g.name && <small>id : {id}</small>}
        </label>
        <label className="field">
          <span>DCA</span>
          <input type="checkbox" checked={Boolean(g.master)} onChange={(e) => setG({ ...g, master: e.target.checked ? { level: 1, mute: false } : undefined })} />
        </label>
        {g.master && (
          <label className="field" title={t.playbackHelp}>
            <span>{t.playback}</span>
            <input type="checkbox" checked={Boolean(g.playback)} onChange={(e) => setG({ ...g, playback: e.target.checked || undefined })} />
          </label>
        )}
        <label className="field">
          <span>{t.exclusive}</span>
          <input type="checkbox" checked={g.exclusive} onChange={(e) => setG({ ...g, exclusive: e.target.checked })} />
        </label>
      </div>
      <p className="hint">{t.groupHelp}</p>
      <div className="checklists">
        <Checklist title={t.fixturesMembers} items={fixtures} selected={g.members.fixtures} onChange={(ids) => members("fixtures", ids)} />
        <Checklist title={t.subGroups} items={groups} selected={g.members.groups} onChange={(ids) => members("groups", ids)} />
        <Checklist title={t.looksMembers} items={looks} selected={g.members.looks} onChange={(ids) => members("looks", ids)} />
        {g.master && (
          <>
            <Checklist title={t.fadersDosed} items={faders} selected={dosed} onChange={setDosed} />
            <Checklist title={t.presetsIncluded} items={looks} selected={g.presets.included} onChange={(ids) => setG({ ...g, presets: { ...g.presets, included: ids } })} />
            <Checklist title={t.presetsExcluded} items={looks} selected={g.presets.excluded} onChange={(ids) => setG({ ...g, presets: { ...g.presets, excluded: ids } })} />
          </>
        )}
      </div>
      <textarea placeholder={t.notes} value={g.notes ?? ""} onChange={(e) => setG({ ...g, notes: e.target.value || undefined })} />
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
              void confirmDelete("group", initial.id, initial.name, t).then((done) => done && onClose(), (e: Error) => setError(e.message));
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
      {!isNew && <Versions collection="groups" id={initial.id} onRestored={onClose} />}
    </section>
  );
}
