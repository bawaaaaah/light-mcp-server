import { useEffect, useRef, type ReactNode, type ReactPortal } from "react";
import { createPortal } from "react-dom";
import { wrappedFocus } from "../focus-trap";
import { guardPassed } from "../preview-first";

const FOCUSABLE = "input, select, textarea, button, [href], [tabindex]:not([tabindex='-1'])";

/**
 * An editor over the page (docs/specs/ui-dashboards.md, « Éditeurs ») : opened from the bottom of a
 * long list, it shows where the eye is, not at the top of the page. Full screen on a phone; a long
 * editor scrolls in it, the page behind stays put. Closed by the editor's own buttons only: a tap
 * beside it on a tablet must not lose an edit.
 *
 * `onClose` turns it into a quick choice (the preview before a launch): Escape and a press on the
 * backdrop call it, Tab stays inside, and the focus goes back to what opened it. Without it nothing
 * of that applies and an editor behaves as it always did.
 */
export function Modal({ label, className, onClose, children }: { label: string; /** e.g. « narrow » for a short form */ className?: string; /** a way out that loses nothing */ onClose?: () => void; children: ReactNode }): ReactPortal {
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const openedAt = useRef(performance.now());
  const pressedBackdrop = useRef(false);
  useEffect(() => {
    const before = document.body.style.overflow;
    const opener = close.current ? (document.activeElement as HTMLElement | null) : null;
    document.body.style.overflow = "hidden";
    // the first field takes the keyboard, as the editor did inline
    box.current?.querySelector<HTMLElement>("input, select, textarea, button")?.focus({ preventScroll: true });
    // a quick choice owns the keyboard wherever the focus is (a press on the backdrop sends it to the page): at the document, before
    // the page behind sees a key (the digits switch dashboards there)
    const keys = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        close.current?.();
        return;
      }
      if (e.key !== "Tab") return;
      // the focus goes round inside the dialog, and comes back into it when it was outside
      const items = [...(box.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter((el) => !el.hasAttribute("disabled"));
      if (!items.length) return;
      const to = items.includes(document.activeElement as HTMLElement) ? wrappedFocus(items, document.activeElement, e.shiftKey) : items[e.shiftKey ? items.length - 1 : 0];
      if (to) {
        e.preventDefault();
        to.focus();
      }
    };
    if (close.current) document.addEventListener("keydown", keys, true);
    return () => {
      document.removeEventListener("keydown", keys, true);
      document.body.style.overflow = before;
      opener?.focus?.({ preventScroll: true });
    };
  }, []);
  return createPortal(
    <div
      className="modal-backdrop"
      // on click, not on pointer down: closing at the touch would let the click that follows land on what is under the finger;
      // and the press must have started on the backdrop: one that began in the dialog and ended outside is not a way out
      onPointerDown={(e) => {
        pressedBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        const started = pressedBackdrop.current;
        pressedBackdrop.current = false;
        if (close.current && started && e.target === e.currentTarget && guardPassed(performance.now(), openedAt.current)) close.current();
      }}
    >
      <div ref={box} className={className ? `modal ${className}` : "modal"} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
        {children}
      </div>
    </div>,
    document.body,
  );
}
