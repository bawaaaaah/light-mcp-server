import type { ReactElement } from "react";
import { useT } from "../i18n-context";
import { ArmedMark, pressHandlers } from "./press";
import type { WidgetProps } from "./env";

/** Blackout, played by its press mode (latch by default), optionally « À confirmer ». */
export function BlackoutWidget({ w, env }: WidgetProps): ReactElement {
  const t = useT();
  const { state, armed, run } = env;
  return (
    <button
      className={`fill blackout ${state?.blackout ? "on" : ""} ${armed === w.id ? "armed" : ""}`}
      title={t.modes[w.mode ?? "latch"]}
      {...env.locked("commands:blackout")}
      {...pressHandlers(env, w.mode ?? "latch", Boolean(state?.blackout), () => void run("blackout", { on: true }), () => void run("blackout", { on: false }), w.confirm ? w.id : undefined)}
    >
      {state?.blackout ? t.blackoutOn : t.blackout}
      <ArmedMark id={w.id} armed={armed} />
    </button>
  );
}
