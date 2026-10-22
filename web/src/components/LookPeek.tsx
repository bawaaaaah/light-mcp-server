import { useEffect, useState } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { useTopic } from "../hooks/useTopic";
import { canvasBlocks, stageOrder, type CanvasRender } from "../canvas-blocks";
import { LookPreview, usePreviewFrame, type Preview } from "./LookPreview";

interface Timing {
  every: { beats?: number; seconds?: number };
  attack: number;
  order: string;
}

/**
 * A look's animated preview, for a glance from its button on the Live (docs/specs/ui-dashboards.md):
 * the server's preview of the look as saved, its cells in the stage's order, a line where a fixture
 * begins. Loaded when shown.
 */
export function LookPeek({ id }: { id: string }) {
  const t = useT();
  const tempo = useTopic<{ bpm: number } | null>("light:tempo", null);
  const [shown, setShown] = useState<{ look: { timing: Timing }; preview: Preview; order: number[]; starts: Set<number> } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    void Promise.all([
      cmd<{ canvas: string; timing: Timing }>("look.get", { id }),
      cmd<{ id: string; cells: number; render?: CanvasRender[] }[]>("venue.canvas.list"),
      cmd<{ id: string; name: string; color?: string; position?: { x: number } }[]>("venue.fixture.list"),
    ])
      .then(async ([look, canvases, fixtures]) => {
        const canvas = canvases.find((c) => c.id === look.canvas);
        const blocks = canvasBlocks(canvas?.cells ?? 0, canvas?.render ?? [], fixtures);
        const { order, blocks: placed } = stageOrder(blocks, new Map(fixtures.filter((f) => f.position).map((f) => [f.id, f.position!.x])));
        const preview = await cmd<Preview>("look.preview", { look });
        if (live) setShown({ look, preview, order, starts: new Set(placed.filter((b) => b.from > 0).map((b) => b.from)) });
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [id]);
  const frame = usePreviewFrame(shown?.preview ?? null, shown?.look.timing ?? { every: { beats: 1 }, attack: 0, order: "loop" }, tempo?.bpm ?? 120);
  if (error) return <p className="error">{error}</p>;
  if (!shown) return <p className="hint">…</p>;
  return <LookPreview preview={shown.preview} frame={frame} label={t.preview} order={shown.order} starts={shown.starts} plain />;
}
