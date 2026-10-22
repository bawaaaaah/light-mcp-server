import { useEffect, useState } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { slug, uniqueId } from "../util";
import { actionOf, build, newMapping, type Action, type MappingDraft } from "./MappingEditor";
import { isHex, SWATCHES } from "../color";
import { useFloatingMenu } from "./menu";

export type WidgetKind = "look" | "group-fader" | "panic" | "blackout" | "tap" | "section" | "song-nav" | "label" | "stop-all" | "xy" | "preview" | "channel-fader" | "snapshot" | "grand-master";
export type ButtonMode = "trigger" | "latch" | "momentary";
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

const inputText = (i: MappingDraft["input"]) => (i.port === "OS2L" ? `DJ (OS2L) n° ${i.number}` : `${i.type === "cc" ? "CC" : i.type === "programchange" ? "PC" : "note"} ${i.number} · ${i.channel}`);

/**
 * Right-click on a dashboard widget (live, no edit mode): what it drives (look, DCA, fader), its
 * label and button mode, the MIDI notes or CCs that play it (« Apprendre » adds one), and removal.
 * Every change is saved at once.
 */
export function WidgetMenu({
  widget,
  at,
  looks,
  groups,
  faders,
  snapshots = [],
  onChange,
  onRemove,
  onClose,
}: {
  widget: MenuWidget;
  at: { x: number; y: number };
  looks: Named[];
  groups: Named[];
  faders: Named[];
  snapshots?: Named[];
  onChange: (patch: Partial<MenuWidget>) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const { box, style } = useFloatingMenu(at, onClose);
  const [label, setLabel] = useState(widget.label ?? "");
  const [mappings, setMappings] = useState<MappingDraft[]>([]);
  const [learning, setLearning] = useState(false);
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
        const draft = { ...newMapping(), label: name, mode: widget.mode ?? (widget.kind === "look" ? "latch" : "trigger"), input: { ...r.input, port: dj ? "OS2L" : undefined }, feedback: dj ? "none" : r.input.type === "cc" ? "cc" : "note" } as MappingDraft;
        const id = uniqueId(slug(`${r.input.type}-${r.input.number}-${name}`, "mapping"), mappings.map((m) => m.id));
        return cmd("midi.mapping.put", { mapping: { ...build(draft, action.action, action.target), id } });
      })
      .then(loadMappings, (e: Error) => setError(e.message))
      .finally(() => setLearning(false));
  };

  return (
    <div ref={box} className="widget-menu" role="dialog" aria-label={t.widgetSettings} style={style} onContextMenu={(e) => e.preventDefault()}>
      <h3>
        {t.widgetKinds[widget.kind]}
        {widget.label ? ` · ${widget.label}` : ""}
      </h3>
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
            {(["latch", "momentary", "trigger"] as const).map((m) => (
              <option key={m} value={m}>
                {t.modes[m]}
              </option>
            ))}
          </select>
        </label>
      )}
      {/* a held button is already deliberate: no second press for momentary ones */}
      {(widget.kind === "look" || widget.kind === "blackout" || widget.kind === "snapshot") && widget.mode !== "momentary" && (
        <label className="row" title={t.confirmPressHelp}>
          <input type="checkbox" checked={Boolean(widget.confirm)} onChange={(e) => onChange({ confirm: e.target.checked || undefined })} /> {t.confirmPress}
        </label>
      )}
      {action && (
        <div className="midi">
          <span className="hint">MIDI</span>
          <ul>
            {mine.map((m) => (
              <li key={m.id}>
                {inputText(m.input)}{" "}
                <button className="ghost" title={t.delete} onClick={() => void cmd("midi.mapping.delete", { id: m.id }).then(loadMappings)}>
                  ✕
                </button>
              </li>
            ))}
            {mine.length === 0 && <li className="hint">{t.noMidi}</li>}
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
