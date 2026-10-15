/**
 * Group editor (docs/specs/groups-masters.md): name, members (fixtures, looks, sub-groups), DCA
 * (master) on or off, exclusive, looks dosed or excluded by the DCA. Saved with `group.put`.
 */
import { useEffect, useState } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { slug, uniqueId } from "../util";

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
}

export const newGroup = (): GroupDraft => ({ id: "", name: "", members: { fixtures: [], looks: [], groups: [] }, master: { level: 1, mute: false }, exclusive: false, presets: { included: [], excluded: [] } });

export function Checklist({ title, items, selected, onChange }: { title: string; items: Named[]; selected: string[]; onChange: (ids: string[]) => void }) {
  return (
    <fieldset className="checklist">
      <legend>
        {title} ({selected.length})
      </legend>
      {items.length === 0 && <small className="hint">—</small>}
      {items.map((x) => (
        <label key={x.id} className="row">
          <input type="checkbox" checked={selected.includes(x.id)} onChange={(e) => onChange(e.target.checked ? [...selected, x.id] : selected.filter((s) => s !== x.id))} />
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
  const [error, setError] = useState("");
  const isNew = !initial.id;
  const id = isNew ? uniqueId(slug(g.name, "groupe"), existing) : g.id;

  useEffect(() => {
    void cmd<Named[]>("venue.fixture.list").then(setFixtures);
    void cmd<Named[]>("look.list").then(setLooks);
    void cmd<Named[]>("group.list").then((list) => setGroups(list.filter((x) => x.id !== initial.id)));
  }, [initial.id]);

  const members = (k: keyof GroupDraft["members"], ids: string[]) => setG({ ...g, members: { ...g.members, [k]: ids } });
  const save = () => {
    if (!g.name.trim()) return setError(t.nameRequired);
    void cmd("group.put", { group: { ...g, id } })
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
              if (confirm(`${t.delete} « ${initial.name} » ?`)) void cmd("group.delete", { id: initial.id }).then(onClose);
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
