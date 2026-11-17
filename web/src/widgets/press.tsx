import type { ButtonHTMLAttributes, KeyboardEvent, PointerEvent, ReactElement } from "react";
import { useT } from "../i18n-context";
import { noKeyRepeat } from "../hooks/useArm";
import type { ButtonMode } from "../dashboard-layout";
import type { WidgetEnv } from "./env";

/**
 * Press behaviour of a look or Blackout button (docs/specs/ui-dashboards.md): « Déclencher » always switches on,
 * « Latch » toggles, « Momentané » is on while the button is held. « À confirmer » (`confirm`, the button's id): the
 * first press arms the button for a few seconds, the second fires; only switching on asks, stopping a look or leaving
 * a Blackout is never delayed. Nothing plays while arranging the widgets.
 */
type PressProps = Pick<ButtonHTMLAttributes<HTMLButtonElement>, "onPointerDown" | "onPointerUp" | "onPointerCancel" | "onKeyDown" | "onKeyUp" | "onClick">;

export function pressHandlers(env: Pick<WidgetEnv, "edit" | "confirmed">, mode: ButtonMode, active: boolean, on: () => void, off: () => void, confirm?: string): PressProps {
  const { edit } = env;
  return mode === "momentary"
    ? {
        onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
          if (edit) return;
          e.currentTarget.setPointerCapture?.(e.pointerId); // released outside the button: still released
          on();
        },
        onPointerUp: () => !edit && off(),
        onPointerCancel: () => !edit && off(),
        onKeyDown: (e: KeyboardEvent) => !edit && !e.repeat && (e.key === " " || e.key === "Enter") && on(),
        onKeyUp: (e: KeyboardEvent) => !edit && (e.key === " " || e.key === "Enter") && off(),
      }
    : { onClick: () => ((mode === "latch" || mode === "toggle") && active ? off() : env.confirmed(confirm, on)), ...noKeyRepeat };
}

/** « Appuyer encore »: on a button armed by its first press. */
export function ArmedMark({ id, armed }: { id: string; armed: string | null }): ReactElement | null {
  const t = useT();
  return armed === id ? <small className="armed-mark">{t.pressAgain}</small> : null;
}
