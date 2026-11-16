/**
 * The colour presets where they are used (T41; docs/specs/presets-songs-notes.md, « Presets de couleur »): the show's
 * favourites as a row of colour buttons, a button opening every saved colour (favourites first, then a list with a
 * search), and the colour applied by hand to fixtures or a group (`colour.apply`, said in the app's one toast). Shared
 * by the look editor, a fixture's panel, the Live's « Couleurs favorites » widget and the group faders.
 */
import { useState, type CSSProperties, type ReactElement } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import type { Texts } from "../i18n";
import { useColourPresets, type ColourPresetRow } from "../hooks/useColourPresets";
import { textOn } from "../color";
import { quoted } from "../typography";
import { useFloatingMenu } from "./menu";
import { showLockToast } from "./MotionLockButton";
import { SearchPicker } from "./SearchPicker";

/** What to colour: fixtures, a group, or (neither) every fixture. */
export interface ColourScope {
  fixtures?: string[];
  group?: string;
}

/** Applies a saved colour to the scope, and says what was done (and left out) in the toast. */
export async function applyColour(t: Texts, preset: ColourPresetRow, scope: ColourScope): Promise<void> {
  try {
    const r = await cmd<{ applied: string[]; skipped: { fixture: string }[] }>("colour.apply", { id: preset.id, ...scope });
    const said = [t.colours.applied.replace("{name}", () => quoted(t, preset.name)).replace("{n}", String(r.applied.length))];
    if (r.skipped.length) said.push(t.colours.skipped.replace("{names}", () => r.skipped.map((s) => s.fixture).join(", ")));
    showLockToast(said.join(" · "), r.skipped.length ? "alert" : "neutral");
  } catch (e) {
    showLockToast((e as Error).message);
  }
}

/** Gives back the colour applied by hand to the scope. */
export async function releaseColour(t: Texts, scope: ColourScope): Promise<void> {
  try {
    const r = await cmd<{ released: string[] }>("colour.release", scope);
    showLockToast(t.colours.released.replace("{n}", String(r.released.length)), "neutral");
  } catch (e) {
    showLockToast((e as Error).message);
  }
}

/** One saved colour as a button: its colour, its name readable on it, the name said to screen readers. */
export function ColourButton({ preset, onPick, label, disabled, style }: { preset: ColourPresetRow; onPick: (p: ColourPresetRow) => void; label?: string; disabled?: boolean; style?: CSSProperties }): ReactElement {
  return (
    <button type="button" className="colour-button" data-colour={preset.id} disabled={disabled} title={label ?? preset.name} aria-label={label ?? preset.name} style={{ background: preset.color, color: textOn(preset.color), ...style }} onClick={() => onPick(preset)}>
      <span className="colour-button-name">{preset.name}</span>
    </button>
  );
}

/** The show's favourites as a row of colour buttons; `label` names each button (« Appliquer {name} »). */
export function ColourFavoriteButtons({ onPick, label, disabled, emptyHint = true }: { onPick: (p: ColourPresetRow) => void; label?: (p: ColourPresetRow) => string; disabled?: boolean; emptyHint?: boolean }): ReactElement | null {
  const t = useT();
  const { favorites, loaded } = useColourPresets();
  if (!loaded) return null;
  if (!favorites.length) return emptyHint ? <small className="hint">{t.colours.favoritesNone}</small> : null;
  return (
    <div className="colour-favorites" role="group" aria-label={t.colours.favorites}>
      {favorites.map((p) => (
        <ColourButton key={p.id} preset={p} disabled={disabled} label={label?.(p)} onPick={onPick} />
      ))}
    </div>
  );
}

/** Every saved colour, favourites first: the favourites as buttons, then all of them in a list with a search. */
function ColourMenu({ anchor, title, onPick, onClose }: { anchor: DOMRect; title: string; onPick: (p: ColourPresetRow) => void; onClose: () => void }): ReactElement {
  const t = useT();
  const { presets } = useColourPresets();
  const { box, style } = useFloatingMenu({ x: anchor.left, y: anchor.bottom + 4 }, onClose, anchor.top - 4);
  const pick = (p: ColourPresetRow) => {
    onPick(p);
    onClose();
  };
  return (
    <div ref={box} className="widget-menu colour-menu" role="dialog" aria-label={title} style={style}>
      <strong>{title}</strong>
      <ColourFavoriteButtons onPick={pick} />
      {presets.length > 0 ? (
        <SearchPicker
          title={t.colours.allPresets}
          focusOnOpen
          items={presets.map((p) => ({ key: p.id, label: p.name, color: p.color, detail: p.origin === "personal" ? t.colours.originPersonal : t.colours.originShow }))}
          onPick={(i) => {
            const p = presets.find((x) => x.id === i.key);
            if (p) pick(p);
          }}
        />
      ) : (
        <small className="hint">{t.colours.none}</small>
      )}
    </div>
  );
}

/**
 * A button opening every saved colour (favourites first); `onPick` gets the one chosen. `children`: the button's
 * content (a ★ by default). Escape or a press elsewhere closes the list, and the focus goes back to the button.
 */
export function ColourPresetPicker({ title, onPick, className = "ghost colour-pick", children, disabled }: { title: string; onPick: (p: ColourPresetRow) => void; className?: string; children?: ReactElement | string; disabled?: boolean }): ReactElement {
  const [open, setOpen] = useState<DOMRect | null>(null);
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  const close = () => {
    setOpen(null);
    button?.focus();
  };
  return (
    <>
      <button
        type="button"
        ref={setButton}
        className={className}
        title={title}
        aria-label={title}
        aria-haspopup="dialog"
        aria-expanded={open !== null}
        disabled={disabled}
        // the open list closes on a press elsewhere: this press toggles it instead of reopening it
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => (open ? close() : setOpen(e.currentTarget.getBoundingClientRect()))}
      >
        {children ?? <span aria-hidden="true">★</span>}
      </button>
      {open && <ColourMenu anchor={open} title={title} onPick={onPick} onClose={close} />}
    </>
  );
}
