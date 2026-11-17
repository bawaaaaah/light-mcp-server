import type { ReactElement } from "react";
import { useT } from "../i18n-context";
import { KINDS, type WidgetKind } from "../dashboard-layout";

/** What a palette chip drops: a kind of widget, possibly already bound (a look, a snapshot). */
export const DRAG_TYPE = "application/x-light-widget";

interface Named {
  id: string;
  name: string;
  color?: string;
}

/**
 * The widgets to add while arranging: a chip per kind, then the looks, snapshots and positions already bound, found by
 * name. A chip is dragged onto the grid, or clicked to go under the others.
 */
export function Palette({ looks, snapshots, positions, search, onSearch, onAdd }: {
  looks: (Named & { swatch?: string })[];
  snapshots: Named[];
  positions: Named[];
  search: string;
  onSearch: (search: string) => void;
  onAdd: (kind: WidgetKind, target?: string) => void;
}): ReactElement {
  const t = useT();
  return (
    <section className="palette" aria-label={t.palette}>
      <span className="hint">{t.paletteHelp}</span>
      <div className="chips">
        {KINDS.map((k) => (
          <button key={k} className="chip" draggable onDragStart={(e) => e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ kind: k }))} onClick={() => onAdd(k)}>
            {t.widgetKinds[k]}
          </button>
        ))}
      </div>
      <input className="search" placeholder={t.paletteSearch} aria-label={t.paletteSearch} value={search} onChange={(e) => onSearch(e.target.value)} />
      <div className="chips bound">
        {[
          ...looks.map((l) => ({ kind: "look" as WidgetKind, id: l.id, name: l.name, color: l.swatch })),
          ...snapshots.map((x) => ({ kind: "snapshot" as WidgetKind, id: x.id, name: `◉ ${x.name}`, color: undefined })),
          ...positions.map((x) => ({ kind: "position" as WidgetKind, id: x.id, name: `⌖ ${x.name}`, color: x.color })),
        ]
          .filter((c) => !search || c.name.toLowerCase().includes(search.toLowerCase()))
          .slice(0, 60)
          .map((c) => (
            <button
              key={`${c.kind}:${c.id}`}
              className="chip"
              draggable
              style={c.color ? ({ "--wc": c.color } as React.CSSProperties) : undefined}
              onDragStart={(e) => e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ kind: c.kind, target: c.id }))}
              onClick={() => onAdd(c.kind, c.id)}
            >
              {c.name}
            </button>
          ))}
      </div>
    </section>
  );
}
