import type { ReactElement } from "react";
import { useT } from "../i18n-context";
import { warmPeek } from "../components/LookPeek";
import { asksBeforeLaunch } from "../preview-first";
import { tagsShown } from "../intentions";
import { ArmedMark, pressHandlers } from "./press";
import type { WidgetProps } from "./env";

/**
 * A look's button, played by its press mode (latch by default): its colours on hover, its preview first when asked
 * (« Aperçu d'abord »), and while arranging, the exclusive set it belongs to.
 */
export function LookButtonWidget({ w, env }: WidgetProps): ReactElement {
  const t = useT();
  const { edit, hoverPeek, previewFirst, armed, run, setOf } = env;
  const l = env.lookById.get(w.target ?? "");
  if (!l) return <div className="fill missing">{w.target}</div>;
  const set = setOf(l.id);
  const title = [w.label ?? l.name, t.modes[w.mode ?? "latch"], ...(set ? [`${t.exclusiveSet}${t.colon} ${set.name}`] : []), ...tagsShown(env.knowledge, l.tags)].join(" · ");
  const go = () => void run("look.go", { id: l.id });
  const asksFirst = asksBeforeLaunch({ on: previewFirst, mode: w.mode, playing: l.active });
  return (
    <button
      className={`fill look ${l.active ? "on" : ""} ${l.danger ? "danger" : ""} ${armed === w.id ? "armed" : ""}`}
      title={hoverPeek.shows(l.id) ? undefined : title /* the whole name: a long one is cut on the button */}
      {...hoverPeek.bind(l.id, title)}
      {...env.locked("commands:trigger")}
      onPointerDown={() => previewFirst && !edit && warmPeek(l.id)}
      {...pressHandlers(
        env,
        w.mode ?? "latch",
        l.active,
        asksFirst ? () => env.preview({ id: l.id, name: w.label ?? l.name, fire: go }) : go,
        () => void run("look.stop", { id: l.id }),
        // the preview takes the place of the two presses of « À confirmer »: not asked twice
        asksFirst ? undefined : w.confirm ? w.id : undefined,
      )}
    >
      {l.manualOnly ? "✋ " : ""}
      {w.label ?? l.name}
      {/* toggle plays as a latch on the Live: no mark either */}
      {w.mode && w.mode !== "latch" && w.mode !== "toggle" && <small className="mode-mark">{w.mode === "momentary" ? " ⇣" : " ▸"}</small>}
      {/* while arranging: which set it is exclusive with */}
      {edit && set && <small className="set-mark">◉ {set.name}</small>}
      <ArmedMark id={w.id} armed={armed} />
    </button>
  );
}
