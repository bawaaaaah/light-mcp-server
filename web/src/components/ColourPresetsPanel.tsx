/**
 * The Show page's « Couleurs » section (T41; docs/specs/presets-songs-notes.md, « Presets de couleur »): the show's
 * favourite colours in their order (moved up and down, taken out), every saved colour with its origin (the show, or the
 * personal library of this machine), and the forms to create one (in the show or the library), rename and recolour it,
 * mark it a favourite, and delete it (asking when a mapping or a song names it). Earlier versions of the show's.
 */
import { useId, useState, type CSSProperties, type ReactElement } from "react";
import { can, cmd, type Role } from "../api";
import { useMe, useT } from "../App";
import { colourPresetsStore, useColourPresets, type ColourPresetRow } from "../hooks/useColourPresets";
import { quoted } from "../typography";
import { confirmDelete } from "./confirmDelete";
import { Versions } from "./Versions";

const fill = (text: string, name: string) => text.replace("{name}", () => name);

export function ColourPresetsPanel({ onError }: { onError: (message: string) => void }): ReactElement {
  const t = useT();
  const w = t.colours;
  const me = useMe() as Role | null;
  const write = me ? can(me, "show:write") : false;
  const { presets, favorites, loaded } = useColourPresets();
  const [editing, setEditing] = useState<string | null>(null);
  const fail = (e: unknown) => onError((e as Error).message);
  // read again at once: the command's event may come later
  const favorite = (p: ColourPresetRow, on: boolean, index?: number) => void cmd("colour.preset.favorite", { id: p.id, favorite: on, ...(index === undefined ? {} : { index }) }).then(colourPresetsStore.refresh, fail);
  const move = (p: ColourPresetRow, by: number) => favorite(p, true, Math.max(0, (p.favorite ?? 0) + by));
  const originBadge = (p: ColourPresetRow) => (
    <span className={`badge origin-${p.origin}`} title={p.over ? `${w.originShowHelp} ${w.overHelp}` : p.origin === "show" ? w.originShowHelp : w.originPersonalHelp}>
      {p.origin === "show" ? w.originShow : w.originPersonal}
      {p.over ? " ⤵" : ""}
    </span>
  );

  return (
    <div className="colour-presets-panel">
      <p className="hint">{w.help}</p>
      <h3>{w.favorites}</h3>
      {loaded && favorites.length === 0 && <p className="hint">{w.favoritesNone}</p>}
      <ol className="colour-list colour-favorites-order">
        {favorites.map((p, i) => (
          <li key={p.id} className="colour-row" data-colour={p.id} style={{ "--colour": p.color } as CSSProperties}>
            <span className="colour-swatch" aria-hidden="true" />
            <strong>{p.name}</strong>
            {originBadge(p)}
            <span className="grow" />
            {write && (
              <>
                <button className="ghost" aria-label={fill(w.moveUp, p.name)} title={fill(w.moveUp, p.name)} disabled={i === 0} onClick={() => move(p, -1)}>
                  ↑
                </button>
                <button className="ghost" aria-label={fill(w.moveDown, p.name)} title={fill(w.moveDown, p.name)} disabled={i === favorites.length - 1} onClick={() => move(p, 1)}>
                  ↓
                </button>
                <button className="ghost colour-unfavorite" aria-label={fill(w.removeFavorite, p.name)} title={fill(w.removeFavorite, p.name)} onClick={() => favorite(p, false)}>
                  <span aria-hidden="true">★</span>
                </button>
              </>
            )}
          </li>
        ))}
      </ol>
      <h3>{w.allPresets}</h3>
      {loaded && presets.length === 0 && <p className="hint">{w.none}</p>}
      <ul className="colour-list">
        {presets.map((p) => (
          <li key={p.id} className="colour-row" data-colour={p.id} style={{ "--colour": p.color } as CSSProperties}>
            <div className="colour-line">
              <span className="colour-swatch" aria-hidden="true" />
              <strong>{p.name}</strong>
              <small className="colour-hex">{p.color}</small>
              {originBadge(p)}
              <span className="grow" />
              {write && (
                <>
                  <button
                    className={`ghost colour-favorite ${p.favorite !== undefined ? "on" : ""}`}
                    aria-pressed={p.favorite !== undefined}
                    aria-label={fill(p.favorite !== undefined ? w.removeFavorite : w.addFavorite, p.name)}
                    title={fill(p.favorite !== undefined ? w.removeFavorite : w.addFavorite, p.name)}
                    onClick={() => favorite(p, p.favorite === undefined)}
                  >
                    <span aria-hidden="true">{p.favorite !== undefined ? "★" : "☆"}</span>
                  </button>
                  <button className="colour-edit" aria-expanded={editing === p.id} aria-label={fill(w.editing, p.name)} onClick={() => setEditing(editing === p.id ? null : p.id)}>
                    {w.edit}
                  </button>
                  <button className="ghost colour-delete" aria-label={fill(w.deleteName, p.name)} title={fill(w.deleteName, p.name)} onClick={() => void confirmDelete("colour", p.id, p.name, t).catch(fail)}>
                    ✕
                  </button>
                </>
              )}
            </div>
            {p.usedBy.length > 0 && <small className="hint">{w.usedBy.replace("{list}", () => p.usedBy.join(", "))}</small>}
            {editing === p.id && <ColourForm key={p.id} preset={p} onClose={() => setEditing(null)} />}
          </li>
        ))}
      </ul>
      {write && <ColourForm onClose={() => undefined} />}
    </div>
  );
}

/** A new colour (its name, its colour, where it is stored, favourite or not), or one renamed and recoloured where it is. */
function ColourForm({ preset, onClose }: { preset?: ColourPresetRow; onClose: () => void }): ReactElement {
  const t = useT();
  const w = t.colours;
  const id = useId();
  const [name, setName] = useState(preset?.name ?? "");
  const [color, setColor] = useState(preset?.color ?? "#ff8000");
  const [scope, setScope] = useState<"show" | "personal">(preset?.origin ?? "show");
  const [fav, setFav] = useState(true);
  const [problem, setProblem] = useState("");
  const save = async () => {
    if (!name.trim()) return setProblem(w.nameRequired);
    try {
      await cmd("colour.preset.put", { preset: { ...(preset ? { id: preset.id, notes: preset.notes } : {}), name: name.trim(), color }, scope, ...(preset ? {} : { favorite: fav }) });
      colourPresetsStore.refresh();
      if (preset) onClose();
      else {
        setName("");
        setProblem("");
      }
    } catch (e) {
      setProblem((e as Error).message);
    }
  };
  return (
    <form
      className="colour-form"
      aria-label={preset ? fill(w.editing, quoted(t, preset.name)) : w.newTitle}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onKeyDown={(e) => {
        if (preset && e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      {!preset && <h3>{w.newTitle}</h3>}
      <div className="colour-form-fields">
        <label className="field">
          <span>{w.name}</span>
          <input value={name} aria-required="true" autoFocus={Boolean(preset)} maxLength={60} onChange={(e) => (setName(e.target.value), setProblem(""))} />
        </label>
        <label className="field">
          <span>{w.color}</span>
          <input type="color" className="colour-input" value={color} onChange={(e) => setColor(e.target.value)} />
        </label>
        {!preset && (
          <fieldset className="colour-scope">
            <legend>{w.scope}</legend>
            {(["show", "personal"] as const).map((s) => (
              <label key={s}>
                <input type="radio" name={`${id}-scope`} checked={scope === s} onChange={() => setScope(s)} /> {s === "show" ? w.scopeShow : w.scopePersonal}
              </label>
            ))}
          </fieldset>
        )}
        {!preset && (
          <label className="colour-fav-check">
            <input type="checkbox" checked={fav} onChange={(e) => setFav(e.target.checked)} /> {w.favorites}
          </label>
        )}
      </div>
      {preset?.origin === "show" && <Versions collection="colours" id={preset.id} help={w.versionsHelp} onRestored={onClose} />}
      <div className="row">
        <button type="submit" className="primary">
          {preset ? t.save : w.create}
        </button>
        {preset && (
          <button type="button" className="ghost" onClick={onClose}>
            {t.close}
          </button>
        )}
        {problem && (
          <span className="error" role="alert">
            {problem}
          </span>
        )}
      </div>
    </form>
  );
}
