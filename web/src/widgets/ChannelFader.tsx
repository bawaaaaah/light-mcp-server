import type { ReactElement } from "react";
import { useT } from "../i18n-context";
import { FaderTrack } from "../components/FaderTrack";
import { sharedRanges } from "../fader-functions";
import { Sent, SmoothedMark } from "./marks";
import type { WidgetProps } from "./env";

/** A channel fader: its level, the named ranges of its channels beside the track (T6), its travel. */
export function ChannelFaderWidget({ w, env }: WidgetProps): ReactElement {
  const t = useT();
  const { glide } = env;
  const f = env.faders.find((x) => x.id === w.target);
  if (!f) return <div className="fill missing">{w.target}</div>;
  return (
    <div className="fader fill channel">
      <FaderTrack
        label={`${t.channelFader} ${f.name}`}
        value={f.level}
        sent={glide.faders[f.id]}
        disabled={!env.may("commands:level")}
        interactive={!env.edit}
        onChange={(level) => {
          env.setFaders((fs) => fs.map((x) => (x.id === f.id ? { ...x, level } : x)));
          void env.run("fader.level", { id: f.id, level });
        }}
        ranges={sharedRanges(env.fixtureChannels, f.channels)}
        travel={f.range}
        rangesLabel={t.fixtureMode.ranges.replace("{channel}", f.name)}
        // one cell wide, the column would push the track out of its cell: the range input still says the range
        ladder={w.w >= 2}
      />
      <span className="value">
        {Math.round(f.level * 100)}%<Sent level={glide.faders[f.id]} />
      </span>
      <small className="limits">
        {f.channels.length} {t.channelsShort}
      </small>
      <label>
        {w.label ?? f.name}
        <SmoothedMark on={Boolean(f.smoothing)} />
      </label>
    </div>
  );
}
