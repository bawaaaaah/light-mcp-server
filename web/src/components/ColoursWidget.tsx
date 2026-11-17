/**
 * The Live's « Couleurs favorites » widget (T41; docs/specs/ui-dashboards.md): the favourite colours as buttons, applied
 * by hand (`colour.apply`, right `commands:trigger`, the right to launch looks) to the widget's group, or every fixture
 * without one; the colour held there is marked (pressed, ✓), « Rendre la couleur » is active only while one is held,
 * and « … » opens every saved colour. The buttons wrap and narrow (44 px at least) to show every favourite, never
 * hidden in a scroll. A press is mapped to MIDI from the MIDI page (action « Appliquer une couleur »). While
 * arranging, a press only selects the widget.
 */
import type { ReactElement } from "react";
import { useT } from "../i18n-context";
import { useColoursApplied } from "../hooks/useColourPresets";
import { applyColour, ColourFavoriteButtons, ColourPresetPicker, releaseColour } from "./ColourFavorites";

export function ColoursWidget({ group, label, disabled, inert }: { group: string | undefined; label?: string; disabled: boolean; inert: boolean }): ReactElement {
  const t = useT();
  const w = t.colours;
  const applied = useColoursApplied();
  const held = group ? applied.groups[group] : applied.all;
  const scope = group ? { group } : {};
  const title = label ?? w.widgetAll;
  return (
    <div className="fill colours-widget" data-testid="colours-widget" role="group" aria-label={`${t.widgetKinds.colours} · ${title}`}>
      <div className="colours-widget-head">
        <small className="colours-widget-title">{title}</small>
        <ColourPresetPicker title={`${w.allPresets} · ${title}`} className="colours-more" disabled={disabled || inert} held={held} onPick={(p) => void applyColour(t, p, scope)}>
          …
        </ColourPresetPicker>
        <button type="button" className="colours-release" title={w.releaseHelp} aria-label={`${w.release} · ${title}`} disabled={disabled || !held} onClick={() => !inert && void releaseColour(t, scope)}>
          {w.release}
        </button>
      </div>
      <ColourFavoriteButtons disabled={disabled} held={held} label={(p) => w.apply.replace("{name}", () => p.name)} onPick={(p) => !inert && void applyColour(t, p, scope)} />
      {disabled && <small className="hint">{t.noRight}</small>}
    </div>
  );
}
