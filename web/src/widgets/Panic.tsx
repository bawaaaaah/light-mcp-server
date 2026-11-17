import type { ReactElement } from "react";
import { useT } from "../i18n-context";
import type { WidgetProps } from "./env";

/** « Panique », and for a minute after it « ↶ Revenir »: a Panic pressed by mistake gives back what played just before. */
export function PanicWidget({ env }: WidgetProps): ReactElement {
  const t = useT();
  const { locked, run, state } = env;
  return (
    <div className="panic-cell">
      <button className="panic fill" {...locked("commands:panic")} onClick={() => void run("panic")}>
        {t.panic}
      </button>
      {state?.panicUndo && (
        <button className="panic-undo" title={t.panicUndoHelp} {...locked("commands:panic")} onClick={() => void run("panic.undo")}>
          ↶ {t.panicUndo}
        </button>
      )}
    </div>
  );
}
