import { useRef, useState, type ReactElement } from "react";
import { useT } from "../i18n-context";
import { useStored } from "../hooks/useStored";
import { LiveStage } from "./StagePlan";

/**
 * The show on the stage plan above the Live's buttons, as it goes out (rehearsing without the kit). It folds in place
 * (its row stays, to open it again where it was); pinned under the bar, its bottom edge sets its height: dragged, or the
 * arrows; a double click gives it back its own. Both remembered by this browser.
 */
export function LiveStagePanel({ pinned, beams, onBeams, onError }: { pinned: boolean; beams: boolean; onBeams: (on: boolean) => void; onError: (message: string) => void }): ReactElement {
  const t = useT();
  const [folded, setFolded] = useStored("liveStageFolded", false);
  /** The pinned stage's height, dragged by its bottom edge (px); none: up to 42 % of the window. */
  const [stageHeight, setStageHeight] = useStored<number | null>("liveStageHeight", null);
  const [draggedHeight, setDraggedHeight] = useState<number | null>(null);
  const panel = useRef<HTMLElement>(null);
  const resize = useRef<{ y0: number; h0: number } | null>(null);
  /** Never so small it vanishes, never the whole window. */
  const fitHeight = (h: number) => Math.round(Math.min(Math.max(h, 80), window.innerHeight * 0.75));
  const pinnedHeight = pinned ? (draggedHeight ?? (stageHeight === null ? undefined : fitHeight(stageHeight))) : undefined;
  const drawnHeight = () => panel.current?.querySelector(".plan-scroll:not([hidden]) svg, .stage-3d canvas")?.getBoundingClientRect().height ?? 200;
  return (
    <section ref={panel} className={pinnedHeight ? "live-stage-panel sized" : "live-stage-panel"} aria-label={t.liveStageToggle}>
      <LiveStage
        onError={onError}
        views
        beamsShown={beams}
        collapsed={folded}
        height={pinnedHeight}
        controls={
          <>
            <button className="ghost" aria-expanded={!folded} title={t.foldStageHelp} onClick={() => setFolded(!folded)}>
              {folded ? `▸ ${t.reveal}` : `▾ ${t.hide}`}
            </button>
            <button className={beams ? "ghost on" : "ghost"} aria-pressed={beams} title={t.stageBeamsHelp} onClick={() => onBeams(!beams)}>
              {t.stageBeams}
            </button>
          </>
        }
      />
      {pinned && !folded && (
        <div
          className="stage-resize"
          role="separator"
          aria-orientation="horizontal"
          aria-label={t.stageHeight}
          title={t.stageHeightHelp}
          tabIndex={0}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            resize.current = { y0: e.clientY, h0: pinnedHeight ?? drawnHeight() };
            setDraggedHeight(fitHeight(resize.current.h0));
          }}
          onPointerMove={(e) => resize.current && setDraggedHeight(fitHeight(resize.current.h0 + e.clientY - resize.current.y0))}
          onPointerUp={() => {
            if (!resize.current) return;
            resize.current = null;
            if (draggedHeight !== null) setStageHeight(draggedHeight);
            setDraggedHeight(null);
          }}
          onPointerCancel={() => ((resize.current = null), setDraggedHeight(null))}
          onDoubleClick={() => setStageHeight(null)}
          onKeyDown={(e) => {
            const nudge = e.key === "ArrowDown" ? 20 : e.key === "ArrowUp" ? -20 : 0;
            if (!nudge) return;
            e.preventDefault();
            setStageHeight(fitHeight((pinnedHeight ?? drawnHeight()) + nudge));
          }}
        />
      )}
    </section>
  );
}
