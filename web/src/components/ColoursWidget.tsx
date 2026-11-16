/**
 * The Live's « Couleurs favorites » widget (T41; docs/specs/ui-dashboards.md): the show's favourite colours as buttons,
 * applied by hand (`colour.apply`, right `commands:level`) to the widget's group, or every fixture without one, and
 * « Rendre la couleur ». A press is mapped to MIDI from the MIDI page (action « Appliquer une couleur »). While
 * arranging, a press only selects the widget.
 */
import type { ReactElement } from "react";
import { useT } from "../App";
import { applyColour, ColourFavoriteButtons, releaseColour } from "./ColourFavorites";

export function ColoursWidget({ group, label, disabled, inert }: { group: string | undefined; label?: string; disabled: boolean; inert: boolean }): ReactElement {
  const t = useT();
  const w = t.colours;
  const scope = group ? { group } : {};
  const title = label ?? w.widgetAll;
  return (
    <div className="fill colours-widget" data-testid="colours-widget" role="group" aria-label={`${t.widgetKinds.colours} · ${title}`}>
      <div className="colours-widget-head">
        <small className="colours-widget-title">{title}</small>
        <button type="button" className="ghost colours-release" title={w.releaseHelp} aria-label={`${w.release} · ${title}`} disabled={disabled} onClick={() => !inert && void releaseColour(t, scope)}>
          {w.release}
        </button>
      </div>
      <ColourFavoriteButtons disabled={disabled} label={(p) => w.apply.replace("{name}", () => p.name)} onPick={(p) => !inert && void applyColour(t, p, scope)} />
      {disabled && <small className="hint">{t.noRight}</small>}
    </div>
  );
}
