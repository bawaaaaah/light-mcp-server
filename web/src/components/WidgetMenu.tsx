import { useEffect, useState, type ReactElement } from "react";
import { cmd } from "../api";
import { useT } from "../i18n-context";
import { slug, uniqueId } from "../util";
import { actionOf, build, newMapping, type Action, type MappingDraft } from "./MappingEditor";
import { isHex, SWATCHES } from "../color";
import { useFloatingMenu } from "./menu";
import { LookPeek } from "./LookPeek";
import { SmoothingField, type Smoothing } from "./SmoothingField";
import { targetListOf, type ButtonMode, type TargetList, type Widget, type WidgetKind } from "../dashboard-layout";
import type { Texts } from "../i18n";

/** What the menu reads and changes of a widget: not its place on the grid. */
type MenuWidget = Omit<Widget, "x" | "y" | "w" | "h">;
/** Something of the show a widget can drive: its id and name. */
export interface Named {
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
    case "motion-lock":
      return { action: "freeze", target: w.target ?? "" };
    case "position":
      return w.target ? { action: "position", target: w.target } : undefined;
    default:
      return undefined;
  }
}

/** What a widget's full editor edits: the look it starts, the DCA (or the moving heads' group) it drives, its channel fader. */
export type AdvancedKind = "look" | "group" | "fader";
const advancedOf = (kind: WidgetKind): AdvancedKind | undefined =>
  kind === "look" ? "look" : kind === "group-fader" || kind === "xy" ? "group" : kind === "channel-fader" ? "fader" : undefined;

/** An exclusive group, a set of buttons that behave as radio buttons. */
export interface ExclusiveSet {
  id: string;
  name: string;
  looks: string[];
}
const NEW_SET = "+new";
const MIXED = "+mixed";
/** Puts looks in the set chosen in a SetSelect: none, one of the sets, or a new one (« Exclusif n »). */
export const putInSet = (looks: string[], value: string): Promise<unknown> => cmd("look.exclusive", { looks, ...(value === NEW_SET ? { create: {} } : value ? { group: value } : {}) });

/**
 * Which exclusive set a look button belongs to (docs/specs/groups-masters.md, « Exclusif »): as
 * radio buttons, starting a look releases the others of its set only. `mixed`: several buttons
 * chosen, in different sets.
 */
export function SetSelect({ value, sets, mixed = false, onPick }: { value: string; sets: ExclusiveSet[]; mixed?: boolean; onPick: (value: string) => void }): ReactElement {
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

/** An input's type and number; a pitch bend has no number (the whole wheel of its channel). */
const inputKey = (t: Texts, i: MappingDraft["input"], note: string) => (i.type === "pitchbend" ? t.pitchBend : `${i.type === "cc" ? "CC" : i.type === "programchange" ? "PC" : note} ${i.number}`);
const inputText = (t: Texts, i: MappingDraft["input"]) => (i.port === "OS2L" ? `DJ (OS2L) n° ${i.number}` : `${inputKey(t, i, "note")} · ${i.channel}`);
/** The input as the menu shows it, its channel beside it. */
const inputName = (t: Texts, i: MappingDraft["input"]) => (i.port === "OS2L" ? `DJ (OS2L) n° ${i.number}` : inputKey(t, i, "Note"));

/** The show's lists a widget picks its target from, by `targetListOf`; null until the list is first read. */
export type TargetLists = Record<TargetList, Named[] | null>;
/** What a widget of `kind` picks its target from: none for a kind without a list, null while that list is not read yet. */
export const targetsOf = (kind: WidgetKind, lists: TargetLists): Named[] | null => {
  const list = targetListOf(kind);
  return list ? lists[list] : [];
};

/**
 * What a widget drives, chosen in its menu and in the edit panel alike: the list of its kind (none: no choice), named
 * for its kind; « — » (or « Toutes les lyres » to freeze them all) clears it, and a target no longer in the show is
 * kept, said « introuvable » once its list is read (before that, shown as it is). Hidden when there is nothing to
 * choose and nothing to say.
 */
export function TargetSelect({ kind, value, lists, field = false, onChange }: { kind: WidgetKind; value: string | undefined; lists: TargetLists; field?: boolean; onChange: (target: string | undefined) => void }): ReactElement | null {
  const t = useT();
  const read = targetsOf(kind, lists);
  const options = read ?? [];
  const missing = Boolean(targetListOf(kind) && value && !options.some((x) => x.id === value));
  if (!options.length && !missing) return null;
  const name = kind === "look" ? t.assignLook : kind === "target" ? t.targets.aimTarget : t.assignTarget;
  const select = (
    // a list not read yet: nothing to choose, and « — » not chosen by mistake while it comes
    <select aria-label={field ? undefined : name} disabled={!read} aria-busy={!read} value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)}>
      <option value="">{kind === "motion-lock" ? t.motionLock.allHeads : "—"}</option>
      {missing && <option value={value}>{read ? t.targetMissing.replace("{id}", () => value!) : value}</option>}
      {options.map((x) => (
        <option key={x.id} value={x.id}>
          {x.name}
        </option>
      ))}
    </select>
  );
  return field ? (
    <label className="field">
      <span>{name}</span>
      {select}
    </label>
  ) : (
    select
  );
}

/**
 * Right-click on a dashboard widget (live, no edit mode): what it drives (look, DCA, fader), its
 * label and button mode, a look's exclusive set, the MIDI notes or CCs that play it (« Apprendre »
 * adds one), and removal.
 * Every change is saved at once.
 */
export function WidgetMenu({
  widget,
  at,
  lists,
  exclusives,
  onGroupsChange,
  onChange,
  onRemove,
  onClose,
  onAdvanced,
}: {
  widget: MenuWidget;
  at: { x: number; y: number };
  /** The show's looks, groups, faders, snapshots, 3D targets (T24) and named positions (T32): a widget picks its own here. */
  lists: TargetLists;
  /** The show's exclusive sets, when this user may change them: a look button's set is chosen here. */
  exclusives?: ExclusiveSet[];
  /** A set changed: the groups to read again. */
  onGroupsChange?: () => void;
  onChange: (patch: Partial<MenuWidget>) => void;
  onRemove: () => void;
  onClose: () => void;
  /** Opens the full editor of what the widget drives — a look, a DCA, a channel fader — over the dashboard. */
  onAdvanced?: (kind: AdvancedKind, id: string) => void;
}): ReactElement {
  const t = useT();
  const { box, style } = useFloatingMenu(at, onClose);
  const [label, setLabel] = useState(widget.label ?? "");
  const [mappings, setMappings] = useState<MappingDraft[]>([]);
  const [learning, setLearning] = useState(false);
  /** The look's preview played on the stage: the menu widens for it. */
  const [wide, setWide] = useState(false);
  const [error, setError] = useState("");
  const action = midiAction(widget);
  const advanced = widget.target ? advancedOf(widget.kind) : undefined;
  const loadMappings = () => void cmd<MappingDraft[]>("midi.mapping.list").then(setMappings, () => undefined);
  useEffect(loadMappings, []);

  const mine = action ? mappings.filter((m) => {
    const a = actionOf(m);
    return a.action === action.action && a.target === action.target;
  }) : [];
  const targets: Named[] = targetsOf(widget.kind, lists) ?? [];
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
      {widget.kind === "look" && widget.target && (
        <LookPeek key={widget.target} id={widget.target} onStage={setWide} />
      )}
      <TargetSelect field kind={widget.kind} value={widget.target} lists={lists} onChange={(target) => onChange({ target })} />
      <label className="field">
        <span>{t.widgetLabel}</span>
        <input value={label} placeholder={targets.find((x) => x.id === widget.target)?.name ?? ""} onChange={(e) => setLabel(e.target.value)} onBlur={() => label !== (widget.label ?? "") && onChange({ label: label || undefined })} />
      </label>
      {widget.kind === "grand-master" && <GrandMasterSmoothing onError={setError} />}
      {(widget.kind === "group-fader" || widget.kind === "channel-fader") && widget.target && <TargetSmoothing key={widget.target} kind={widget.kind === "group-fader" ? "group" : "fader"} id={widget.target} onError={setError} />}
      {widget.kind !== "preview" && (
        <div className="field">
          <span>{t.widgetColor}</span>
          <div className="swatches" role="radiogroup" aria-label={t.widgetColor}>
            {widget.kind === "position" ? (
              // a named position's button (T32): « auto » (its position's colour) by default, « none » to keep it neutral
              <>
                <button className={`swatch none ${widget.color === "none" ? "chosen" : ""}`} role="radio" aria-checked={widget.color === "none"} title={t.noColor} aria-label={t.noColor} onClick={() => onChange({ color: "none" })} />
                <button className={`swatch auto ${!widget.color || widget.color === "auto" ? "chosen" : ""}`} role="radio" aria-checked={!widget.color || widget.color === "auto"} title={t.positions.autoColorHelp} aria-label={t.positions.autoColorHelp} onClick={() => onChange({ color: undefined })}>
                  A
                </button>
              </>
            ) : (
              <>
                <button className={`swatch none ${!widget.color ? "chosen" : ""}`} role="radio" aria-checked={!widget.color} title={t.noColor} aria-label={t.noColor} onClick={() => onChange({ color: undefined })} />
                {widget.kind === "look" && (
                  <button className={`swatch auto ${widget.color === "auto" ? "chosen" : ""}`} role="radio" aria-checked={widget.color === "auto"} title={t.autoColorHelp} aria-label={t.autoColorHelp} onClick={() => onChange({ color: "auto" })}>
                    A
                  </button>
                )}
              </>
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
              const playable = m.input.type === "note" || m.input.type === "cc" || m.input.type === "programchange";
              // a CC on a level (fader, DCA, grand master) is the level itself: a mode would only make it flicker
              const levelCc = m.input.type === "cc" && (action.action === "dca" || action.action === "fader" || action.action === "grandmaster");
              return (
                <li key={m.id} className="midi-input">
                  <div className="midi-head">
                    <strong>{inputName(t, m.input)}</strong>
                    {m.input.port !== "OS2L" && (
                      <small>
                        {t.midiChannel} {m.input.channel}
                      </small>
                    )}
                    <span className="grow" />
                    <button className="ghost" title={t.delete} aria-label={`${t.delete} · ${inputText(t, m.input)}`} onClick={() => void cmd("midi.mapping.delete", { id: m.id }).then(loadMappings)}>
                      ✕
                    </button>
                  </div>
                  {playable && (
                    <div className="midi-settings">
                      {/* a note on « Figer les lyres » too: « Déclencher » switches, « Marche / arrêt » or « Momentané » are other ways to play it */}
                      {/* a named position is recalled at each press (Déclencher): no mode to choose, said instead */}
                      {action.action === "position" ? (
                        <small className="hint">{t.positions.modeLockedHint}</small>
                      ) : (action.action === "look" || action.action === "blackout" || action.action === "freeze" || ((m.input.type === "cc" || m.input.type === "programchange") && !levelCc)) && (
                        <select aria-label={`${t.mode} · ${inputText(t, m.input)}`} title={t.midiModeHelp} value={m.mode} onChange={(e) => put({ mode: e.target.value as ButtonMode })}>
                          {(["latch", "momentary", "trigger", "toggle"] as const).map((mode) => (
                            <option key={mode} value={mode}>
                              {t.modes[mode]}
                            </option>
                          ))}
                        </select>
                      )}
                      {m.input.type !== "programchange" && (
                        <label title={t.thresholdHelp}>
                          <span>{t.threshold}</span>
                          <input
                            key={m.threshold ?? 0}
                            type="number"
                            min={0}
                            max={126}
                            step={1}
                            aria-label={`${t.threshold} · ${inputText(t, m.input)}`}
                            defaultValue={m.threshold ?? 0}
                            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                            onBlur={(e) => {
                              const v = Math.min(126, Math.max(0, Math.round(Number(e.target.value)) || 0));
                              if (v !== (m.threshold ?? 0)) put({ threshold: v });
                              else e.target.value = String(v);
                            }}
                          />
                        </label>
                      )}
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
      {/* the whole editor of what it drives, where the menu stops: members, channels, timing… */}
      {advanced && onAdvanced && (
        <button className="advanced" title={t.advancedHelp} onClick={() => onAdvanced(advanced, widget.target!)}>
          ✎ {t.advanced}
        </button>
      )}
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

/** A DCA's or a channel fader's smoothing, saved at once on the object it drives. */
function TargetSmoothing({ kind, id, onError }: { kind: "group" | "fader"; id: string; onError: (e: string) => void }) {
  type Target = { id: string; smoothing?: Smoothing; master?: { level: number; mute: boolean; smoothing?: Smoothing } };
  const [target, setTarget] = useState<Target | null>(null);
  useEffect(() => void cmd<Target[]>(`${kind}.list`).then((l) => setTarget(l.find((x) => x.id === id) ?? null), (e: Error) => onError(e.message)), [kind, id, onError]);
  // a group without a master has no fader to smooth
  if (!target || (kind === "group" && !target.master)) return null;
  return (
    <SmoothingField
      value={kind === "group" ? target.master!.smoothing : target.smoothing}
      onChange={(smoothing) => {
        const smoothed = (x: Target) => (kind === "group" ? { ...x, master: { ...x.master!, smoothing } } : { ...x, smoothing });
        setTarget(smoothed(target));
        // read again first: the fader may have moved since the menu opened, its level is not ours to put back
        void cmd<Target[]>(`${kind}.list`)
          .then((l) => {
            const fresh = l.find((x) => x.id === id);
            if (!fresh) throw new Error(id);
            return cmd(`${kind}.put`, { [kind]: smoothed(fresh) });
          })
          .catch((e: Error) => onError(e.message));
      }}
    />
  );
}
