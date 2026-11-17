import type { ReactElement } from "react";
import { useT } from "../i18n-context";
import { FaderTrack } from "../components/FaderTrack";
import { applyColour, ColourPresetPicker, releaseColour } from "../components/ColourFavorites";
import { useColoursApplied } from "../hooks/useColourPresets";
import { SmoothedMark } from "./marks";
import type { WidgetProps } from "./env";

/** A DCA's fader (docs/specs/groups-masters.md): its limits, its effective level, Mute, Flash, and a saved colour (T41). */
export function GroupFaderWidget({ w, env }: WidgetProps): ReactElement {
  const t = useT();
  // the colours applied by hand (T41): a group fader marks its own
  const appliedColours = useColoursApplied();
  const { edit, may, locked, run } = env;
  const g = env.groupById.get(w.target ?? "");
  if (!g) return <div className="fill missing">{w.target}</div>;
  // stop mode: the fader is shown where the DCA really is (on the mark when pushed past it)
  const shown = g.limits?.mode === "scale" ? (g.master?.level ?? 1) : Math.min(g.limits?.max ?? 1, Math.max(g.limits?.min ?? 0, g.master?.level ?? 1));
  const sent = env.glide.groups[g.id];
  return (
    <div className="fader fill">
      <FaderTrack
        label={`DCA ${g.name}`}
        value={shown}
        sent={sent}
        disabled={!may("commands:level")}
        interactive={!edit}
        onChange={(raw) => {
          // clamp mode: the fader stops at the DCA limits (position = level)
          const level = g.limits?.mode === "scale" ? raw : Math.min(g.limits?.max ?? 1, Math.max(g.limits?.min ?? 0, raw));
          env.setGroups((gs) => gs.map((x) => (x.id === g.id ? { ...x, master: { ...x.master, level, mute: x.master?.mute ?? false } } : x)));
          void run("group.level", { id: g.id, level });
        }}
      >
        {g.limits?.mode !== "scale" && g.limits?.max !== undefined && <span className="mark max" style={{ bottom: `${g.limits.max * 100}%` }} title={`max ${Math.round(g.limits.max * 100)} %`} />}
        {g.limits?.mode !== "scale" && g.limits?.min !== undefined && <span className="mark min" style={{ bottom: `${g.limits.min * 100}%` }} title={`min ${Math.round(g.limits.min * 100)} %`} />}
      </FaderTrack>
      <span className="value dca">
        {Math.round(shown * 100)}%
        {/* a line of its own, always there: while the level glides it shows the level sent, otherwise
            the effective one (a snapshot read at the last command), so the read-out never changes
            height and the track never moves under the finger */}
        <small className={sent !== undefined ? "sent" : undefined}>{sent === undefined ? `(${Math.round(g.effectiveLevel * 100)}%)` : `→ ${Math.round(sent * 100)}%`}</small>
      </span>
      {g.limits && (g.limits.min !== undefined || g.limits.max !== undefined) && (
        <small className="limits">
          {Math.round((g.limits.min ?? 0) * 100)}–{Math.round((g.limits.max ?? 1) * 100)} %{g.limits.mode === "scale" ? " ↕" : ""}
        </small>
      )}
      <div className="row">
        <button className={g.master?.mute ? "mute on" : "mute"} title={t.muteHelp} aria-label={`${t.muteHelp} ${w.label ?? g.name}`} {...locked("commands:level")} onClick={() => void run("group.mute", { id: g.id, mute: !g.master?.mute })}>
          M
        </button>
        <button title={t.flashHelp} aria-label={`${t.flashHelp} ${w.label ?? g.name}`} {...locked("commands:trigger")} onPointerDown={() => void run("group.flash", { id: g.id, on: true })} onPointerUp={() => void run("group.flash", { id: g.id, on: false })}>
          F
        </button>
        {/* a saved colour on the group's fixtures (T41) */}
        {!edit && may("commands:trigger") && (
          <ColourPresetPicker title={t.colours.groupButton.replace("{name}", () => w.label ?? g.name)} className={`colour-group ${appliedColours.groups[g.id] ? "held" : ""}`} held={appliedColours.groups[g.id]} onRelease={() => void releaseColour(t, { group: g.id })} onPick={(p) => void applyColour(t, p, { group: g.id })}>
            <span aria-hidden="true">●</span>
          </ColourPresetPicker>
        )}
      </div>
      <label>
        {w.label ?? g.name}
        <SmoothedMark on={Boolean(g.master?.smoothing)} />
      </label>
    </div>
  );
}
