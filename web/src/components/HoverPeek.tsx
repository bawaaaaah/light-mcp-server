/**
 * A look's colours at a glance (docs/specs/ui-dashboards.md): a mouse resting on a look button of
 * the Live shows its preview in a tooltip — the fixtures' codes over their cells, as in its menu.
 * Mouse only: on a touch screen a long press already opens the menu with the same preview.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useCommandEvents } from "../hooks/useTopic";
import { clearPeeks, LookPeek } from "./LookPeek";
import { useFloatingMenu } from "./menu";

const HOVER_MS = 400;

interface Peek {
  id: string;
  title: string;
  at: { x: number; y: number };
}

export function useHoverPeek(enabled: boolean) {
  const [peek, setPeek] = useState<Peek | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const close = () => {
    window.clearTimeout(timer.current);
    setPeek(null);
  };
  // what a peek shows changes with the look, its palette or the venue: fetched again then
  useCommandEvents(["look.put", "look.delete", "look.restore", "palette.", "venue.", "history.", "show.open", "archive."], clearPeeks);
  useEffect(() => {
    if (!enabled) close();
    return () => window.clearTimeout(timer.current);
  }, [enabled]);
  useEffect(() => {
    if (!peek) return;
    window.addEventListener("scroll", close, true);
    return () => window.removeEventListener("scroll", close, true);
  }, [peek]);
  return {
    /** Whether the tooltip shows this look (its button then drops its native title: one bubble only). */
    shows: (id: string) => peek?.id === id,
    /** The handlers for one look button. */
    bind: (id: string, title: string) => ({
      onPointerEnter: (e: ReactPointerEvent<HTMLElement>) => {
        if (!enabled || e.pointerType !== "mouse") return;
        const r = e.currentTarget.getBoundingClientRect();
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setPeek({ id, title, at: { x: r.left, y: r.bottom + 6 } }), HOVER_MS);
      },
      onPointerLeave: close,
      onPointerDownCapture: close,
    }),
    node: peek ? <HoverPeekBox key={peek.id} peek={peek} onClose={close} /> : null,
  };
}

function HoverPeekBox({ peek, onClose }: { peek: Peek; onClose: () => void }) {
  const { box, style } = useFloatingMenu(peek.at, onClose);
  return (
    <div ref={box} className="hover-peek" role="tooltip" style={style}>
      <strong>{peek.title}</strong>
      <LookPeek id={peek.id} compact />
    </div>
  );
}
