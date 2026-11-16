/**
 * The keys of a row of `role="radio"` buttons (WAI-ARIA « radio group » pattern, `components/SegmentedRadio.tsx`): the
 * arrows move to the next or previous choice, wrapping round; Home and End go to the first and the last; a choice that
 * cannot be taken now (`aria-disabled`) is skipped. Pure (no DOM, no React): tested without a browser.
 */

/** The index the key leads to among `count` radios, `enabled(i)` the ones that can be chosen; undefined for another key. */
export function radioTarget(key: string, from: number, count: number, enabled: (i: number) => boolean = () => true): number | undefined {
  if (count === 0) return undefined;
  if (key === "Home" || key === "End") {
    const order = Array.from({ length: count }, (_, k) => (key === "Home" ? k : count - 1 - k));
    return order.find(enabled);
  }
  const step = key === "ArrowRight" || key === "ArrowDown" ? 1 : key === "ArrowLeft" || key === "ArrowUp" ? -1 : undefined;
  if (step === undefined) return undefined;
  for (let k = 1; k <= count; k++) {
    const i = (((from + step * k) % count) + count) % count;
    if (enabled(i)) return i;
  }
  return undefined;
}
