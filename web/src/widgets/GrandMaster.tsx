import type { ReactElement } from "react";
import { useT } from "../i18n-context";
import { FaderTrack } from "../components/FaderTrack";
import { Sent, SmoothedMark } from "./marks";
import type { WidgetProps } from "./env";

/** The grand master: as dragged until the server says it, then as the server says it. */
export function GrandMasterWidget({ w, env }: WidgetProps): ReactElement {
  const t = useT();
  const { state, glide } = env;
  const level = env.gm ?? state?.grandMaster ?? 1;
  return (
    <div className="fader fill grand-master">
      <FaderTrack
        label={t.widgetKinds["grand-master"]}
        value={level}
        sent={glide.gm}
        disabled={!env.may("commands:level")}
        interactive={!env.edit}
        onChange={(v) => {
          env.setGm(v);
          void env.run("grandmaster.set", { level: v });
        }}
      />
      <span className="value">
        {Math.round(level * 100)}%<Sent level={glide.gm} />
      </span>
      <label>
        {w.label ?? t.widgetKinds["grand-master"]}
        <SmoothedMark on={Boolean(state?.grandMasterSmoothed)} />
      </label>
    </div>
  );
}
