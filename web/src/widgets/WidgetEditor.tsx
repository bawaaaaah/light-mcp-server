import { useRef, type ReactElement } from "react";
import { useT } from "../i18n-context";
import { isHex, SWATCHES } from "../color";
import { SetSelect, TargetSelect, type ExclusiveSet, type TargetLists, type TargetReadStates } from "../components/WidgetMenu";
import { autoColored, confirmable, neutral, pressable, shared, type ButtonMode, type Widget } from "../dashboard-layout";

const MODES = ["latch", "momentary", "trigger", "toggle"] as const;

/** The panel of the one widget selected while arranging: what it drives, its label, its mode, its place and size. */
export function WidgetEditor({ w, columns, step, lists, readStates, onRetry, onPatch, onRemove }: {
  w: Widget;
  columns: number;
  /** A cell, or a quarter of one off the magnetic grid. */
  step: number;
  lists: TargetLists;
  readStates?: TargetReadStates;
  onRetry?: () => void;
  onPatch: (patch: Partial<Widget>) => void;
  onRemove: () => void;
}): ReactElement {
  const t = useT();
  const labelRef = useRef<HTMLInputElement>(null);
  return (
    <section className="editor">
      <TargetSelect kind={w.kind} value={w.target} lists={lists} readStates={readStates} next={labelRef} onRetry={onRetry} onChange={(target) => onPatch({ target })} />
      <input ref={labelRef} placeholder={t.labelText} aria-label={t.labelText} value={w.label ?? ""} onChange={(e) => onPatch({ label: e.target.value || undefined })} />
      {pressable(w) && (
        <select aria-label={t.mode} value={w.mode ?? "latch"} onChange={(e) => onPatch({ mode: e.target.value as ButtonMode })}>
          {MODES.map((m) => (
            <option key={m} value={m}>
              {t.modes[m]}
            </option>
          ))}
        </select>
      )}
      <button onClick={() => onPatch({ x: Math.max(0, w.x - step) })}>←</button>
      <button onClick={() => onPatch({ x: Math.min(columns - w.w, w.x + step) })}>→</button>
      <button onClick={() => onPatch({ y: Math.max(0, w.y - step) })}>↑</button>
      <button onClick={() => onPatch({ y: w.y + step })}>↓</button>
      <button onClick={() => onPatch({ w: Math.max(step, w.w - step) })}>⇠</button>
      <button onClick={() => onPatch({ w: Math.min(columns, w.w + step) })}>⇢</button>
      <button onClick={() => onPatch({ h: Math.max(step, w.h - step) })}>⇡</button>
      <button onClick={() => onPatch({ h: w.h + step })}>⇣</button>
      <span className="hint">
        {w.x},{w.y} · {w.w}×{w.h}
      </span>
      <button className="danger" onClick={onRemove}>
        ✕
      </button>
    </section>
  );
}

/** Several widgets selected: what they share is set for all of them at once (one step to undo). */
export function ManyEditor({ many, sets, setOf, onPatch, onSetPick, onDeselect, onRemove }: {
  many: Widget[];
  /** The show's exclusive sets, when this user may change them. */
  sets: ExclusiveSet[] | undefined;
  setOf: (look: string | undefined) => ExclusiveSet | undefined;
  /** Patches each selected widget with what `fn` gives it (nothing: left as it is). */
  onPatch: (fn: (w: Widget) => Partial<Widget> | undefined) => void;
  onSetPick: (looks: string[], value: string) => void;
  onDeselect: () => void;
  onRemove: () => void;
}): ReactElement {
  const t = useT();
  /** « A », said for what is selected: all positions, all looks, or neutral for a mix. */
  const autoHelp = many.every((w) => w.kind === "position") ? t.positions.autoColorHelp : many.every((w) => w.kind === "look") ? t.autoColorHelp : t.autoColorAnyHelp;
  const color = shared("color", many);
  const mode = shared("mode", many.filter(pressable), "latch");
  return (
    <section className="editor many" aria-label={`${many.length} ${t.widgetsSelected}`}>
      <strong>
        {many.length} {t.widgetsSelected}
      </strong>
      <div className="swatches" role="radiogroup" aria-label={t.widgetColor}>
        <button className={`swatch none ${many.every(neutral) ? "chosen" : ""}`} role="radio" aria-checked={many.every(neutral)} title={t.noColor} aria-label={t.noColor} onClick={() => onPatch((w) => ({ color: w.kind === "position" ? "none" : undefined }))} />
        {many.some((w) => w.kind === "look" || w.kind === "position") && (
          <button className={`swatch auto ${many.every(autoColored) ? "chosen" : ""}`} role="radio" aria-checked={many.every(autoColored)} title={autoHelp} aria-label={autoHelp} onClick={() => onPatch((w) => (w.kind === "look" ? { color: "auto" } : w.kind === "position" ? { color: undefined } : undefined))}>
            A
          </button>
        )}
        {SWATCHES.map(([name, hex]) => (
          <button key={hex} className={`swatch ${color === hex ? "chosen" : ""}`} role="radio" aria-checked={color === hex} title={t.swatchNames[name as keyof typeof t.swatchNames]} aria-label={t.swatchNames[name as keyof typeof t.swatchNames]} style={{ background: hex }} onClick={() => onPatch((w) => (w.kind === "preview" ? undefined : { color: hex }))} />
        ))}
        <input type="color" aria-label={t.customColor} title={t.customColor} value={isHex(color) ? color : "#ffffff"} onChange={(e) => onPatch((w) => (w.kind === "preview" ? undefined : { color: e.target.value }))} />
      </div>
      {many.some(pressable) && (
        <select aria-label={t.mode} value={mode ?? ""} onChange={(e) => e.target.value && onPatch((w) => (pressable(w) ? { mode: e.target.value as ButtonMode } : undefined))}>
          {mode === undefined && <option value="">{t.mixedModes}</option>}
          {MODES.map((m) => (
            <option key={m} value={m}>
              {t.modes[m]}
            </option>
          ))}
        </select>
      )}
      {sets && many.some((w) => w.kind === "look" && w.target) && (() => {
        const ids = [...new Set(many.filter((w) => w.kind === "look" && w.target).map((w) => w.target!))];
        const of = ids.map((id) => setOf(id)?.id ?? "");
        const same = of.every((v) => v === of[0]);
        return <SetSelect value={same ? of[0]! : ""} mixed={!same} sets={sets} onPick={(v) => onSetPick(ids, v)} />;
      })()}
      {many.some(confirmable) && (
        <label className="row" title={t.confirmPressHelp}>
          <input type="checkbox" checked={many.filter(confirmable).every((w) => w.confirm)} onChange={(e) => onPatch((w) => (confirmable(w) ? { confirm: e.target.checked || undefined } : undefined))} /> {t.confirmPress}
        </label>
      )}
      <button onClick={onDeselect}>{t.deselect}</button>
      <button className="danger" title={t.removeSelected} aria-label={t.removeSelected} onClick={onRemove}>
        ✕
      </button>
    </section>
  );
}
