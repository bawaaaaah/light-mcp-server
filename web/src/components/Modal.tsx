import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * An editor over the page (docs/specs/ui-dashboards.md, « Éditeurs ») : opened from the bottom of a
 * long list, it shows where the eye is, not at the top of the page. Full screen on a phone; a long
 * editor scrolls in it, the page behind stays put. Closed by the editor's own buttons only: a tap
 * beside it on a tablet must not lose an edit.
 */
export function Modal({ label, className, children }: { label: string; /** e.g. « narrow » for a short form */ className?: string; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // the first field takes the keyboard, as the editor did inline
    box.current?.querySelector<HTMLElement>("input, select, textarea, button")?.focus({ preventScroll: true });
    return () => {
      document.body.style.overflow = before;
    };
  }, []);
  return createPortal(
    <div className="modal-backdrop">
      <div ref={box} className={className ? `modal ${className}` : "modal"} role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </div>,
    document.body,
  );
}
