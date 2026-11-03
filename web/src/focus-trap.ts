/**
 * Where Tab must send the focus to keep it inside a dialog: the first item when going forward from the
 * last, the last when going back (Shift+Tab) from the first; undefined when the browser may move it
 * by itself. `items` are the dialog's focusable elements in page order.
 */
export function wrappedFocus<T>(items: readonly T[], active: unknown, shift: boolean): T | undefined {
  if (!items.length) return undefined;
  const first = items[0]!;
  const last = items[items.length - 1]!;
  if (shift && active === first) return last;
  if (!shift && active === last) return first;
  return undefined;
}
