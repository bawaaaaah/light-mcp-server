/**
 * The colour presets where they are used (T41; docs/specs/presets-songs-notes.md, « Presets de couleur »): the show's
 * favourites as a row of colour buttons, a button opening every saved colour (favourites first, then a list with a
 * search), and the colour applied by hand to fixtures or a group (`colour.apply`, said in the app's one toast). The
 * colour held now is marked (pressed, with a check mark: not by its colour alone). Shared by the look editor, a
 * fixture's panel, the Live's « Couleurs favorites » widget and the group faders.
 */
import { useEffect, useState, type ReactElement } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import type { Texts } from "../i18n";
import { appliedStore, useColourPresets, type ColourPresetRow } from "../hooks/useColourPresets";
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

/** The `#rrggbb` a screen shows for a preset's colour (its white LED part left out). */
export const screenHex = (color: string): string => color.slice(0, 7);

/** One or several: the sentence that fits the count. */
const counted = (n: number, one: string, many: string) => (n === 1 ? one : many).replace("{n}", String(n));

/** Applies a saved colour to the scope, and says what was done, left out, and still dark (decision C1) in the toast. */
export async function applyColour(t: Texts, preset: ColourPresetRow, scope: ColourScope): Promise<void> {
  const w = t.colours;
  try {
    const r = await cmd<{ applied: string[]; skipped: { fixture: string }[]; dark?: string[] }>("colour.apply", { id: preset.id, ...scope });
    appliedStore.refresh();
    const said = [counted(r.applied.length, w.appliedOne, w.appliedMany).replace("{name}", () => quoted(t, preset.name))];
    if (r.dark?.length) said.push(counted(r.dark.length, w.darkOne, w.darkMany).replace("{names}", () => r.dark!.join(", ")));
    if (r.skipped.length) said.push(w.skipped.replace("{names}", () => r.skipped.map((s) => s.fixture).join(", ")));
    showLockToast(said.join(" · "), r.skipped.length || r.dark?.length ? "alert" : "neutral");
  } catch (e) {
    showLockToast((e as Error).message);
  }
}

/** Gives back the colour applied by hand to the scope. */
export async function releaseColour(t: Texts, scope: ColourScope): Promise<void> {
  try {
    const r = await cmd<{ released: string[] }>("colour.release", scope);
    appliedStore.refresh();
    showLockToast(r.released.length ? counted(r.released.length, t.colours.releasedOne, t.colours.releasedMany) : t.colours.releasedNone, "neutral");
  } catch (e) {
    showLockToast((e as Error).message);
  }
}

/** Whether a preset is the colour held (`held`: the `#rrggbb…` applied there). */
const isHeld = (p: ColourPresetRow, held: string | undefined) => held !== undefined && p.color === held;

/**
 * One saved colour as a button: its colour, its name readable on it, the name and its place (show or library) said to
 * screen readers. `held`: the colour applied there now (pressed, ✓).
 */
export function ColourButton({ preset, onPick, label, disabled, held }: { preset: ColourPresetRow; onPick: (p: ColourPresetRow) => void; label?: string; disabled?: boolean; held?: boolean }): ReactElement {
  const t = useT();
  const hex = screenHex(preset.color);
  const origin = preset.origin === "personal" ? t.colours.originPersonal : t.colours.originShow;
  const said = `${label ?? preset.name} (${origin})${held ? ` · ${t.colours.held}` : ""}`;
  return (
    <button
      type="button"
      className={`colour-button ${held ? "held" : ""} ${preset.origin === "personal" ? "library" : ""}`}
      data-colour={preset.id}
      disabled={disabled}
      title={said}
      aria-label={said}
      aria-pressed={held ?? false}
      style={{ background: hex, color: textOn(hex) }}
      onClick={() => onPick(preset)}
    >
      {held && <span aria-hidden="true">✓ </span>}
      <span className="colour-button-name">{preset.name}</span>
    </button>
  );
}

/** The show's favourites as a row of colour buttons; `label` names each button (« Appliquer {name} »), `held` the colour applied there. */
export function ColourFavoriteButtons({ onPick, label, disabled, emptyHint = true, held }: { onPick: (p: ColourPresetRow) => void; label?: (p: ColourPresetRow) => string; disabled?: boolean; emptyHint?: boolean; held?: string }): ReactElement | null {
  const t = useT();
  const { favorites, loaded } = useColourPresets();
  if (!loaded) return null;
  if (!favorites.length) return emptyHint ? <small className="hint">{t.colours.favoritesNone}</small> : null;
  return (
    <div className="colour-favorites" role="group" aria-label={t.colours.favorites}>
      {favorites.map((p) => (
        <ColourButton key={p.id} preset={p} disabled={disabled} label={label?.(p)} held={isHeld(p, held)} onPick={onPick} />
      ))}
    </div>
  );
}

/**
 * Every saved colour, favourites first: the favourites as buttons, then all of them in a list with a search, and
 * « Rendre la couleur » when given. The focus goes to the first favourite (else the list); leaving the menu with Tab
 * closes it, as a click elsewhere or Escape does.
 */
function ColourMenu({ anchor, title, onPick, onClose, held, onRelease }: { anchor: DOMRect; title: string; onPick: (p: ColourPresetRow) => void; onClose: () => void; held?: string; onRelease?: () => void }): ReactElement {
  const t = useT();
  const { presets } = useColourPresets();
  const { box, style } = useFloatingMenu({ x: anchor.left, y: anchor.bottom + 4 }, onClose, anchor.top - 4);
  useEffect(() => {
    box.current?.querySelector<HTMLElement>(".colour-favorites button, .search-list button, input")?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when it opens
  }, []);
  const pick = (p: ColourPresetRow) => {
    onPick(p);
    onClose();
  };
  return (
    <div
      ref={box}
      className="widget-menu colour-menu"
      role="dialog"
      aria-label={title}
      style={style}
      // the focus leaving the menu (Tab past its last control) closes it: nothing stays open behind the page
      onBlur={(e) => {
        if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) onClose();
      }}
    >
      <strong>{title}</strong>
      <ColourFavoriteButtons onPick={pick} held={held} />
      {onRelease && (
        <button
          type="button"
          className="colour-release"
          title={t.colours.releaseHelp}
          disabled={!held}
          onClick={() => {
            onRelease();
            onClose();
          }}
        >
          {t.colours.release}
        </button>
      )}
      {presets.length > 0 ? (
        <SearchPicker
          title={t.colours.allPresets}
          items={presets.map((p) => ({ key: p.id, label: p.name, color: screenHex(p.color), current: isHeld(p, held), detail: p.origin === "personal" ? t.colours.originPersonal : t.colours.originShow }))}
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
 * content (a ★ by default). `held` and `onRelease`: the colour applied there now, and « Rendre la couleur » in the menu.
 * Escape, a press elsewhere or Tab out closes the list, and the focus goes back to the button.
 */
export function ColourPresetPicker({ title, onPick, className = "ghost colour-pick", children, disabled, held, onRelease }: { title: string; onPick: (p: ColourPresetRow) => void; className?: string; children?: ReactElement | string; disabled?: boolean; held?: string; onRelease?: () => void }): ReactElement {
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
      {open && <ColourMenu anchor={open} title={title} onPick={onPick} onClose={close} held={held} onRelease={onRelease} />}
    </>
  );
}
