import { useEffect, useState } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { slug, uniqueId } from "../util";
import { actionOf, build, newMapping, type Action, type MappingDraft } from "./MappingEditor";
import { isHex, SWATCHES } from "../color";
import { useFloatingMenu } from "./menu";
import { LookPeek } from "./LookPeek";
import { SmoothingField, type Smoothing } from "./SmoothingField";

export type WidgetKind = "look" | "group-fader" | "panic" | "blackout" | "tap" | "section" | "song-nav" | "label" | "stop-all" | "xy" | "preview" | "channel-fader" | "snapshot" | "grand-master";
export type ButtonMode = "trigger" | "latch" | "momentary" | "toggle";
export interface MenuWidget {
  id: string;
  kind: WidgetKind;
  target?: string;
  label?: string;
  mode?: ButtonMode;
  color?: string;
  confirm?: boolean;
}
interface Named {
  id: string;
  name: string;
}

/** The MIDI action that plays a widget, as the mapping editor builds it; none for the others. */
function midiAction(w: MenuWidget): { action: Action; target: string } | undefined {
  switch (w.kind) {
    case "look":
      return w.target ? { action: "look", target: w.target } : undefined;
    case "group-fader":
      return w.target ? { action: "dca", target: w.target } : undefined;
    case "channel-fader":
      return w.target ? { action: "fader", target: w.target } : undefined;
    case "grand-master":
      return { action: "grandmaster", target: "" };
    case "section":
      return w.target ? { action: "section", target: w.target.replace(":", "/") } : undefined;
    case "snapshot":
      return w.target ? { action: "snapshot", target: w.target } : undefined;
    case "blackout":
      return { action: "blackout", target: "" };
    case "panic":
      return { action: "panic", target: "" };
    case "tap":
      return { action: "tempo.tap", target: "" };
    case "stop-all":
      return { action: "look.stopall", target: "" };
    default:
      return undefined;
  }
}

/** An exclusive group, a set of buttons that behave as radio buttons. */
export interface ExclusiveSet {
  id: string;
  name: string;
  looks: string[];
}
const NEW_SET = "+new";
const MIXED = "+mixed";
/** Puts looks in the set chosen in a SetSelect: none, one of the sets, or a new one (« Exclusif n »). */
export const putInSet = (looks: string[], value: string) => cmd("look.exclusive", { looks, ...(value === NEW_SET ? { create: {} } : value ? { group: value } : {}) });

/**
 * Which exclusive set a look button belongs to (docs/specs/groups-masters.md, « Exclusif »): as
 * radio buttons, starting a look releases the others of its set only. `mixed`: several buttons
 * chosen, in different sets.
 */
export function SetSelect({ value, sets, mixed = false, onPick }: { value: string; sets: ExclusiveSet[]; mixed?: boolean; onPick: (value: string) => void }) {
  const t = useT();
  return (
    <select aria-label={t.exclusiveSet} title={t.exclusiveSetHelp} value={mixed ? MIXED : value} onChange={(e) => e.target.value !== MIXED && onPick(e.target.value)}>
      {mixed && <option value={MIXED}>{t.exclusiveMixed}</option>}
      <option value="">{t.exclusiveNone}</option>
      {sets.map((g) => (
        <option key={g.id} value={g.id}>
          {g.name} ({g.looks.length})
        </option>
      ))}
      <option value={NEW_SET}>{t.exclusiveNew}</option>
    </select>
  );
}

const inputText = (i: MappingDraft["input"]) => (i.port === "OS2L" ? `DJ (OS2L) n° ${i.number}` : `${i.type === "cc" ? "CC" : i.type === "programchange" ? "PC" : "note"} ${i.number} · ${i.channel}`);
/** The input as the menu shows it, its channel beside it. */
const inputName = (i: MappingDraft["input"]) => (i.port === "OS2L" ? `DJ (OS2L) n° ${i.number}` : `${i.type === "cc" ? "CC" : i.type === "programchange" ? "PC" : "Note"} ${i.number}`);

/**
 * Right-click on a dashboard widget (live, no edit mode): what it drives (look, DCA, fader), its
 * label and button mode, a look's exclusive set, the MIDI notes or CCs that play it (« Apprendre »
 * adds one), and removal.
 * Every change is saved at once.
 */
export function WidgetMenu({
  widget,
  at,
  looks,
  groups,
  faders,
  snapshots = [],
  exclusives,
  onGroupsChange,
  onChange,
  onRemove,
  onClose,
  onEditLook,
}: {
  widget: MenuWidget;
  at: { x: number; y: number };
  looks: Named[];
  groups: Named[];
  faders: Named[];
  snapshots?: Named[];
  /** The show's exclusive sets, when this user may change them: a look button's set is chosen here. */
  exclusives?: ExclusiveSet[];
  /** A set changed: the groups to read again. */
  onGroupsChange?: () => void;
  onChange: (patch: Partial<MenuWidget>) => void;
  onRemove: () => void;
  onClose: () => void;
  /** Opens the editor of the look this button starts (the Live page, over the dashboard). */
  onEditLook?: (id: string) => void;
}) {
  const t = useT();
  const { box, style } = useFloatingMenu(at, onClose);
  const [label, setLabel] = useState(widget.label ?? "");
  const [mappings, setMappings] = useState<MappingDraft[]>([]);
  const [learning, setLearning] = useState(false);
  /** The look's preview played on the stage: the menu widens for it. */
  const [wide, setWide] = useState(false);
  const [error, setError] = useState("");
  const action = midiAction(widget);
  const loadMappings = () => void cmd<MappingDraft[]>("midi.mapping.list").then(setMappings, () => undefined);
  useEffect(loadMappings, []);

  const mine = action ? mappings.filter((m) => {
    const a = actionOf(m);
    return a.action === action.action && a.target === action.target;
  }) : [];
  const targets: Named[] = widget.kind === "look" ? looks : widget.kind === "channel-fader" ? faders : widget.kind === "group-fader" || widget.kind === "xy" ? groups : widget.kind === "snapshot" ? snapshots : [];
  const learn = () => {
    if (!action) return;
    setLearning(true);
    setError("");
    void cmd<{ input: MappingDraft["input"] }>("midi.learn", { timeoutMs: 15000 })
      .then((r) => {
        const name = widget.label || targets.find((x) => x.id === widget.target)?.name || t.widgetKinds[widget.kind];
        const dj = r.input.port === "OS2L"; // a DJ's command keeps its port: only it plays the mapping
        const draft = { ...newMapping(), label: name, mode: widget.mode ?? (widget.kind === "look" ? "latch" : "trigger"), input: { ...r.input, port: dj ? "OS2L" : undefined }, feedback: dj ? "none" : r.input.type === "cc" ? "cc" : "note", threshold: 0 } as MappingDraft;
        const id = uniqueId(slug(`${r.input.type}-${r.input.number}-${name}`, "mapping"), mappings.map((m) => m.id));
        return cmd("midi.mapping.put", { mapping: { ...build(draft, action.action, action.target), id } });
      })
      .then(loadMappings, (e: Error) => setError(e.message))
      .finally(() => setLearning(false));
  };

  return (
    <div ref={box} className={wide ? "widget-menu wide" : "widget-menu"} role="dialog" aria-label={t.widgetSettings} style={style} onContextMenu={(e) => e.preventDefault()}>
      <h3>
        {t.widgetKinds[widget.kind]}
        {widget.label ? ` · ${widget.label}` : ""}
      </h3>
      {widget.kind === "look" && widget.target && onEditLook && (
        <button className="primary" onClick={() => onEditLook(widget.target!)}>
          ✎ {t.editThisLook}
        </button>
      )}
      {widget.kind === "look" && widget.target && (
        <LookPeek key={widget.target} id={widget.target} onStage={setWide} />
      )}
      {targets.length > 0 && (
        <label className="field">
          <span>{widget.kind === "look" ? t.assignLook : t.assignTarget}</span>
          <select value={widget.target ?? ""} onChange={(e) => onChange({ target: e.target.value || undefined })}>
            <option value="">—</option>
            {targets.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="field">
        <span>{t.widgetLabel}</span>
        <input value={label} placeholder={targets.find((x) => x.id === widget.target)?.name ?? ""} onChange={(e) => setLabel(e.target.value)} onBlur={() => label !== (widget.label ?? "") && onChange({ label: label || undefined })} />
      </label>
      {widget.kind === "grand-master" && <GrandMasterSmoothing onError={setError} />}
      {widget.kind !== "preview" && (
        <div className="field">
          <span>{t.widgetColor}</span>
          <div className="swatches" role="radiogroup" aria-label={t.widgetColor}>
            <button className={`swatch none ${!widget.color ? "chosen" : ""}`} role="radio" aria-checked={!widget.color} title={t.noColor} aria-label={t.noColor} onClick={() => onChange({ color: undefined })} />
            {widget.kind === "look" && (
              <button className={`swatch auto ${widget.color === "auto" ? "chosen" : ""}`} role="radio" aria-checked={widget.color === "auto"} title={t.autoColorHelp} aria-label={t.autoColorHelp} onClick={() => onChange({ color: "auto" })}>
                A
              </button>
            )}
            {SWATCHES.map(([name, hex]) => (
              <button key={hex} className={`swatch ${widget.color === hex ? "chosen" : ""}`} role="radio" aria-checked={widget.color === hex} title={t.swatchNames[name as keyof typeof t.swatchNames]} aria-label={t.swatchNames[name as keyof typeof t.swatchNames]} style={{ background: hex }} onClick={() => onChange({ color: hex })} />
            ))}
            <input type="color" aria-label={t.customColor} title={t.customColor} value={isHex(widget.color) ? widget.color : "#ffffff"} onChange={(e) => onChange({ color: e.target.value })} />
          </div>
        </div>
      )}
      {(widget.kind === "look" || widget.kind === "blackout") && (
        <label className="field">
          <span>{t.mode}</span>
          <select value={widget.mode ?? "latch"} onChange={(e) => onChange({ mode: e.target.value as ButtonMode })}>
            {(["latch", "momentary", "trigger", "toggle"] as const).map((m) => (
              <option key={m} value={m}>
                {t.modes[m]}
              </option>
            ))}
          </select>
        </label>
      )}
      {widget.kind === "look" && widget.target && exclusives && (
        <label className="field">
          <span>{t.exclusiveSet}</span>
          <SetSelect
            value={exclusives.find((g) => g.looks.includes(widget.target!))?.id ?? ""}
            sets={exclusives}
            onPick={(v) => void putInSet([widget.target!], v).then(onGroupsChange, (e: Error) => setError(e.message))}
          />
        </label>
      )}
      {/* a held button is already deliberate: no second press for momentary ones */}
      {(widget.kind === "look" || widget.kind === "blackout" || widget.kind === "snapshot") && widget.mode !== "momentary" && (
        <label className="row" title={t.confirmPressHelp}>
          <input type="checkbox" checked={Boolean(widget.confirm)} onChange={(e) => onChange({ confirm: e.target.checked || undefined })} /> {t.confirmPress}
        </label>
      )}
      {action && (
        <div className="field midi">
          <span>MIDI</span>
          {mine.length === 0 && <p className="hint">{t.noMidi}</p>}
          <ul>
            {mine.map((m) => {
              const put = (patch: Partial<MappingDraft>) => void cmd("midi.mapping.put", { mapping: build({ ...m, ...patch }, action.action, action.target) }).then(loadMappings, (err: Error) => setError(err.message));
              const playable = m.input.type === "note" || m.input.type === "cc";
              return (
                <li key={m.id} className="midi-input">
                  <div className="midi-head">
                    <strong>{inputName(m.input)}</strong>
                    {m.input.port !== "OS2L" && (
                      <small>
                        {t.midiChannel} {m.input.channel}
                      </small>
                    )}
                    <span className="grow" />
                    <button className="ghost" title={t.delete} aria-label={`${t.delete} · ${inputText(m.input)}`} onClick={() => void cmd("midi.mapping.delete", { id: m.id }).then(loadMappings)}>
                      ✕
                    </button>
                  </div>
                  {playable && (
                    <div className="midi-settings">
                      {/* the mode is chosen per input — an Ableton clip's note, or a CC: momentary holds it only while it lasts */}
                      {(action.action === "look" || action.action === "blackout") && (
                        <select aria-label={`${t.mode} · ${inputText(m.input)}`} title={t.midiModeHelp} value={m.mode} onChange={(e) => put({ mode: e.target.value as ButtonMode })}>
                          {(["latch", "momentary", "trigger", "toggle"] as const).map((mode) => (
                            <option key={mode} value={mode}>
                              {t.modes[mode]}
                            </option>
                          ))}
                        </select>
                      )}
                      {/* saved when left (or Enter), not on every keystroke */}
                      <label title={t.thresholdHelp}>
                        <span>{t.threshold}</span>
                        <input
                          key={m.threshold ?? 0}
                          type="number"
                          min={0}
                          max={126}
                          step={1}
                          aria-label={`${t.threshold} · ${inputText(m.input)}`}
                          defaultValue={m.threshold ?? 0}
                          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                          onBlur={(e) => {
                            const v = Math.min(126, Math.max(0, Math.round(Number(e.target.value)) || 0));
                            if (v !== (m.threshold ?? 0)) put({ threshold: v });
                            else e.target.value = String(v);
                          }}
                        />
                      </label>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          <button onClick={learn} disabled={learning}>
            {learning ? t.learning : t.learnMidi}
          </button>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button className="danger" onClick={onRemove}>
          {t.removeWidget}
        </button>
        <span className="grow" />
        <button onClick={onClose}>{t.close}</button>
      </div>
    </div>
  );
}

/** The grand master's smoothing, kept in the show settings (docs/specs/groups-masters.md, « Lissage »). */
function GrandMasterSmoothing({ onError }: { onError: (e: string) => void }) {
  const [value, setValue] = useState<Smoothing | undefined | null>(null);
  useEffect(() => void cmd<{ grandMasterSmoothing?: Smoothing }>("show.settings").then((s) => setValue(s.grandMasterSmoothing), (e: Error) => onError(e.message)), [onError]);
  if (value === null) return null;
  return (
    <SmoothingField
      value={value}
      onChange={(next) => {
        setValue(next);
        // null clears it: a partial settings patch cannot carry « absent »
        void cmd("show.settings.set", { grandMasterSmoothing: next ?? null }).catch((e: Error) => onError(e.message));
      }}
    />
  );
}
