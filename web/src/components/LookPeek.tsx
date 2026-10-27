import { useEffect, useMemo, useState } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { useTopic } from "../hooks/useTopic";
import { canvasBlocks, fixtureColors, stageOrder, stripColumns, type Block, type CanvasRender } from "../canvas-blocks";
import { LookPreview, usePreviewFrame, type Preview } from "./LookPreview";
import { LiveStage } from "./StagePlan";

interface Timing {
  every: { beats?: number; seconds?: number };
  attack: number;
  order: string;
}

interface Shown {
  look: { timing: Timing };
  preview: Preview;
  render: CanvasRender[];
  order: number[];
  blocks: Block[];
}

/** Peeks already fetched, by look: hovering a button again asks the server nothing (see clearPeeks). */
const peeks = new Map<string, Promise<Shown>>();

/** Forgets the fetched peeks: a look, a palette or the venue changed. */
export const clearPeeks = () => peeks.clear();

function fetchPeek(id: string): Promise<Shown> {
  const known = peeks.get(id);
  if (known) return known;
  const p = Promise.all([
    cmd<{ canvas: string; timing: Timing }>("look.get", { id }),
    cmd<{ id: string; cells: number; render?: CanvasRender[] }[]>("venue.canvas.list"),
    cmd<{ id: string; name: string; color?: string; position?: { x: number } }[]>("venue.fixture.list"),
  ]).then(async ([look, canvases, fixtures]) => {
    const canvas = canvases.find((c) => c.id === look.canvas);
    const render = canvas?.render ?? [];
    const { order, blocks } = stageOrder(canvasBlocks(canvas?.cells ?? 0, render, fixtures), new Map(fixtures.filter((f) => f.position).map((f) => [f.id, f.position!.x])));
    const preview = await cmd<Preview>("look.preview", { look });
    return { look, preview, render, order, blocks };
  });
  peeks.set(id, p);
  p.catch(() => peeks.delete(id)); // an error is asked again next time
  return p;
}

/** « B1 · barre (gauche) » → « B1 »: a fixture's code, when its name starts with one. */
const shortName = (label: string) => label.split(" · ")[0]!.trim();

/**
 * A look's animated preview, for a glance from its button on the Live (docs/specs/ui-dashboards.md):
 * the server's preview of the look as saved, its cells in the stage's order, each fixture's code
 * above its cells, a spot widened beside long bars; « Sur la scène » plays it on the stage plan.
 * `onStage` tells the menu to widen; `compact` (the hover tooltip) leaves the stage out.
 */
export function LookPeek({ id, onStage, compact }: { id: string; onStage?: (on: boolean) => void; compact?: boolean }) {
  const t = useT();
  const tempo = useTopic<{ bpm: number } | null>("light:tempo", null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [error, setError] = useState("");
  const [stage, setStage] = useState(false);
  useEffect(() => {
    let live = true;
    // the menu opens on an edit to come: always fresh; the tooltip reuses what it fetched
    if (!compact) peeks.delete(id);
    void fetchPeek(id)
      .then((s) => live && setShown(s))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [id, compact]);
  const frame = usePreviewFrame(shown?.preview ?? null, shown?.look.timing ?? { every: { beats: 1 }, attack: 0, order: "loop" }, tempo?.bpm ?? 120);
  const starts = useMemo(() => new Set((shown?.blocks ?? []).filter((b) => b.from > 0).map((b) => b.from)), [shown]);
  const stageColors = useMemo(() => (stage && shown ? fixtureColors(frame, shown.render) : undefined), [stage, shown, frame]);
  if (error) return <p className="error">{error}</p>;
  if (!shown) return <p className="hint">…</p>;
  const line = shown.preview.topology !== "grid";
  const columns = line && shown.blocks.length ? stripColumns(shown.blocks) : undefined;
  return (
    <div className="look-peek">
      {columns && shown.blocks.some((b) => b.label) && (
        <div className="preview-names" style={{ gridTemplateColumns: columns.template }} aria-label={t.stepBlocks}>
          {shown.blocks.map((b, i) => (
            <span key={b.from} className={b.from > 0 ? "block-start" : undefined} style={{ gridColumn: `span ${b.to - b.from + 1}` }} title={b.label}>
              {columns.width[i]! >= 3 ? shortName(b.label) : ""}
            </span>
          ))}
        </div>
      )}
      <LookPreview preview={shown.preview} frame={frame} label={t.preview} order={shown.order} starts={starts} plain columns={columns?.template} />
      {!compact && (
      <button
        className={stage ? "ghost on" : "ghost"}
        aria-pressed={stage}
        title={t.previewOnStageHelp}
        onClick={() => {
          setStage(!stage);
          onStage?.(!stage);
        }}
      >
        {t.peekOnStage}
      </button>
      )}
      {stage && !compact && <LiveStage onError={setError} shownColors={stageColors} views initialView="front" /* in a menu, from the audience reads best */ />}
    </div>
  );
}
