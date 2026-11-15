/**
 * The Live's « Position nommée » widget (T32, lot 4; docs/specs/ui-dashboards.md): one button that recalls a named
 * position (`position.preset.go`, right `commands:position`), in its colour unless the widget has its own, lit while
 * the heads it covers hold it (« rappelée », « rappelée 1/3 » when only some do), « à revoir » when it is stale. Mapped
 * to MIDI from its menu like the other buttons. What a recall leaves out (heads frozen hard, out of reach) is said in
 * the app's toast. While arranging, a press only selects the widget.
 */
import type { ReactElement } from "react";
import { useT } from "../App";
import { useMotionHeads } from "../hooks/useMotionHeads";
import { headNames, holding, positionsStore, usePositions } from "../hooks/usePositions";
import { recallPosition } from "../positionRecall";
import { quoted } from "../typography";

export function PositionButton({ id, label, disabled, inert }: { id: string | undefined; label?: string; disabled: boolean; inert: boolean }): ReactElement {
  const t = useT();
  const w = t.positions;
  const { positions, loaded } = usePositions();
  const { heads } = useMotionHeads();
  if (!id) return <div className="fill missing">{w.unbound}</div>;
  const p = positions.find((x) => x.id === id);
  if (!p) return <div className="fill missing">{loaded ? w.gone.replace("{name}", () => quoted(t, positionsStore.lastName(id))) : "…"}</div>;
  const installed = new Set(heads.map((h) => h.id));
  const covered = p.kind === "point" ? heads.length : p.covers.filter((c) => installed.has(c.id)).length;
  const holds = holding(p.id, heads).length;
  const name = label ?? p.name;
  const state = holds === 0 ? "" : holds >= covered ? w.recalledBadge : w.recalledPart.replace("{n}", String(holds)).replace("{m}", String(covered));
  return (
    <button
      className={`fill position-button ${holds ? "on" : ""}`}
      data-testid="position-button"
      data-position={p.id}
      title={disabled ? t.noRight : w.widgetHelp.replace("{name}", () => quoted(t, p.name))}
      disabled={disabled}
      onClick={() => !inert && void recallPosition(t, p.id, p.name, (h) => headNames(p, [h]))}
    >
      <span className="position-name">{name}</span>
      {(state || p.stale.length > 0) && (
        <small className="position-state">
          {state && <span>● {state}</span>}
          {p.stale.length > 0 && <span title={w.staleHelp}> ⚠ {w.stale}</span>}
        </small>
      )}
    </button>
  );
}
