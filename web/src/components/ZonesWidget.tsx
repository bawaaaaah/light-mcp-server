/**
 * The Live's « Zones » widget (T28, decision 1 of 2026-11-16; docs/specs/ui-dashboards.md): one button per aiming zone;
 * a press aims the widget's heads (its group, or every head) at the zone — `position.aim {zone}`, a manual gesture of
 * the motion layer, above the looks — until « Rendre la main » (`position.release` on the same heads). The zone the
 * heads hold is marked (pressed, ✓; « mixed » with « n sur m » under its name when only some of them hold it), from
 * `position.list` (`aimed`): a pad gesture over them unmarks it. What a press leaves out (heads frozen hard, out of
 * reach) is said in the app's toast, as the pads' zone chips do; a group deleted, or one without an installed head, is
 * said instead of buttons that do nothing. « Rendre la main » gives the focus back to the zone last pressed (it disables
 * itself). While arranging, a press only selects the widget.
 */
import { useRef, type CSSProperties, type ReactElement } from "react";
import { ApiError, cmd } from "../api";
import { useT } from "../App";
import { useMotionHeads } from "../hooks/useMotionHeads";
import { leftOut } from "../leftOut";
import { showLockToast } from "./MotionLockButton";
import type { ZoneChip } from "./XyPad";

type AimReply = { results?: { fixture: string; error?: string; unplaced?: true }[]; refused?: string[] };

export function ZonesWidget({ group, label, zones, disabled, inert, groupDeleted = false }: { group: string | undefined; label?: string; zones: readonly ZoneChip[]; disabled: boolean; inert: boolean; groupDeleted?: boolean }): ReactElement {
  const t = useT();
  const w = t.zonesWidget;
  const scope = group ? { group } : {};
  const { heads, loaded, refresh } = useMotionHeads(scope);
  const box = useRef<HTMLDivElement | null>(null);
  const lastPressed = useRef<string | null>(null);
  const title = label ?? w.all;
  const nameOf = (id: string) => heads.find((h) => h.id === id)?.name ?? id;
  const holding = (zone: string) => heads.filter((h) => h.aimed === zone).length;
  const held = heads.some((h) => h.manual !== null);
  // why the buttons do nothing: said, never only greyed out
  const why = groupDeleted ? w.groupGone.replace("{id}", () => group ?? "") : loaded && !heads.length ? w.noHeads : "";
  const aim = async (zone: ZoneChip): Promise<void> => {
    if (inert || disabled) return;
    lastPressed.current = zone.id;
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
    // the button disables itself once nothing is held: the focus goes back to the zone last pressed, else the first
    const back = box.current?.querySelector<HTMLButtonElement>(`.zones-widget-buttons button[data-zone="${CSS.escape(lastPressed.current ?? "")}"]`) ?? box.current?.querySelector<HTMLButtonElement>(".zones-widget-buttons button");
    back?.focus();
    try {
      await cmd("position.release", scope);
    } catch (error) {
      showLockToast((error as Error).message);
    }
    refresh();
  };
  return (
    <div ref={box} className="fill zones-widget" data-testid="zones-widget" role="group" aria-label={`${t.widgetKinds.zones} · ${title}`} title={w.help}>
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
            const count = w.count.replace("{n}", String(n)).replace("{m}", String(heads.length));
            return (
              <button
                key={z.id}
                type="button"
                data-zone={z.id}
                aria-pressed={all ? true : n > 0 ? "mixed" : false}
                aria-label={`${w.aim.replace("{name}", () => z.name)}${n ? ` · ${w.held}${all ? "" : ` ${count}`}` : ""}`}
                disabled={disabled || !heads.length}
                style={{ "--zone-color": z.color ?? "var(--aim-color)" } as CSSProperties}
                onClick={() => void aim(z)}
              >
                <i className="zone-chip-mark" aria-hidden="true" />
                <span className="zones-widget-name">
                  <span>{z.name}</span>
                  {/* under the name, never beside it: a narrow button keeps the name on its own lines */}
                  {n > 0 && (
                    <small className="zones-widget-count" aria-hidden="true">
                      {all ? `✓ ${w.held}` : count}
                    </small>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {why && <small className="hint" data-testid="zones-why">{why}</small>}
      {disabled && <small className="hint">{t.noRight}</small>}
    </div>
  );
}
