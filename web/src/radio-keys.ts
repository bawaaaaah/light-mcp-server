/**
 * A row of buttons with `role="radio"` (a `radiogroup`) driven from the keyboard as a native radio group (WAI-ARIA
 * « radio group » pattern): one stop in the Tab order — the checked button (`radioTabIndex`), the first one when none is
 * — and the arrow keys move both the focus and the choice, wrapping round; Home and End go to the ends; buttons marked
 * `aria-disabled="true"` are skipped. Pure (no DOM, no React): the key handler is `onRadioKey` (radio-group.ts).
 */

/** The tab index of one radio of a group: 0 for the checked one (or the first when none is), −1 for the others. */
export const radioTabIndex = (checked: boolean, index: number, anyChecked: boolean): 0 | -1 => (checked || (!anyChecked && index === 0) ? 0 : -1);

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
