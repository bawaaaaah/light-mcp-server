/** The key handler of a row of `role="radio"` buttons (radio-keys.ts says how the keys move). */
import type { KeyboardEvent } from "react";
import { radioTarget } from "./radio-keys";

/** onKeyDown of a radiogroup: the arrow keys choose the next radio (`choose(i)`) and move the focus to it. */
export function onRadioKey(e: KeyboardEvent<HTMLElement>, choose: (index: number) => void): void {
  const radios = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')];
  const from = radios.indexOf(document.activeElement as HTMLElement);
  if (from < 0) return;
  const to = radioTarget(e.key, from, radios.length, (i) => radios[i]!.getAttribute("aria-disabled") !== "true");
  if (to === undefined) return;
  e.preventDefault();
  choose(to);
  radios[to]!.focus();
}
