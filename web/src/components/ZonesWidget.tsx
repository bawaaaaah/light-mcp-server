/**
 * The Live's « Zones » widget (T28, decision 1 of 2026-11-16; docs/specs/ui-dashboards.md): one button per aiming zone;
 * a press aims the widget's heads (its group, or every head) at the zone — `position.aim {zone}`, a manual gesture of
 * the motion layer, above the looks — until « Rendre la main » (`position.release` on the same heads). The zone the
 * heads hold is marked (pressed, ✓; « mixed » when only some of them hold it), from `position.list` (`aimed`): a pad
 * gesture over them unmarks it. What a press leaves out (heads frozen hard, out of reach) is said in the app's toast,
 * as the pads' zone chips do. While arranging, a press only
 * selects the widget.
 */
import type { CSSProperties, ReactElement } from "react";
import { ApiError, cmd } from "../api";
import { useT } from "../App";
import { useMotionHeads } from "../hooks/useMotionHeads";
import { leftOut } from "../leftOut";
import { showLockToast } from "./MotionLockButton";
import type { ZoneChip } from "./XyPad";

type AimReply = { results?: { fixture: string; error?: string; unplaced?: true }[]; refused?: string[] };

export function ZonesWidget({ group, label, zones, disabled, inert }: { group: string | undefined; label?: string; zones: readonly ZoneChip[]; disabled: boolean; inert: boolean }): ReactElement {
  const t = useT();
  const w = t.zonesWidget;
  const scope = group ? { group } : {};
  const { heads, refresh } = useMotionHeads(scope);
  const title = label ?? w.all;
  const nameOf = (id: string) => heads.find((h) => h.id === id)?.name ?? id;
  const holding = (zone: string) => heads.filter((h) => h.aimed === zone).length;
  const held = heads.some((h) => h.manual !== null);
  const aim = async (zone: ZoneChip): Promise<void> => {
    if (inert || disabled) return;
    try {
      const reply = await cmd<AimReply>("position.aim", { ...scope, zone: zone.id });
      const unreachable = (reply?.results ?? []).flatMap((r) => (r.error ? [{ fixture: r.fixture, error: r.error, ...(r.unplaced ? { unplaced: true as const } : {}) }] : []));
      const said = leftOut(t, zone.name, { refused: reply?.refused ?? [], unreachable }, nameOf);
      if (said.length) showLockToast(said.join(" · "));
    } catch (error) {
      const refused = error instanceof ApiError ? error.detail?.refused : undefined;
      const said = Array.isArray(refused) ? leftOut(t, zone.name, { refused: refused.filter((id): id is string => typeof id === "string") }, nameOf) : [];
      showLockToast(said.length ? said.join(" · ") : (error as Error).message);
    }
    refresh();
  };
  const release = async (): Promise<void> => {
    if (inert || disabled) return;
    try {
      await cmd("position.release", scope);
    } catch (error) {
      showLockToast((error as Error).message);
    }
    refresh();
  };
  return (
    <div className="fill zones-widget" data-testid="zones-widget" role="group" aria-label={`${t.widgetKinds.zones} · ${title}`} title={w.help}>
      <div className="zones-widget-head">
        <small className="zones-widget-title">{title}</small>
        <button type="button" className="zones-release" title={w.releaseHelp} aria-label={`${w.release} · ${title}`} disabled={disabled || !held} data-testid="zones-release" onClick={() => void release()}>
          {w.release}
        </button>
      </div>
      {zones.length === 0 ? (
        <small className="hint">{w.none}</small>
      ) : (
        <div className="zones-widget-buttons">
          {zones.map((z) => {
            const n = holding(z.id);
            const all = n > 0 && n >= heads.length;
            return (
              <button
                key={z.id}
                type="button"
                data-zone={z.id}
                aria-pressed={all ? true : n > 0 ? "mixed" : false}
                aria-label={`${w.aim.replace("{name}", () => z.name)}${n ? ` · ${w.held}${all ? "" : ` ${n}/${heads.length}`}` : ""}`}
                disabled={disabled || !heads.length}
                style={{ "--zone-color": z.color ?? "var(--aim-color)" } as CSSProperties}
                onClick={() => void aim(z)}
              >
                <i className="zone-chip-mark" aria-hidden="true" />
                <span>{z.name}</span>
                {n > 0 && <span aria-hidden="true">{all ? " ✓" : ` ${n}/${heads.length}`}</span>}
              </button>
            );
          })}
        </div>
      )}
      {disabled && <small className="hint">{t.noRight}</small>}
    </div>
  );
}
