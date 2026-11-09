/**
 * Control panel of a fixture held on the stage plan (docs/specs/venue-fixtures-stage.md, « Lyres »):
 * it moves its head with the XY pad (`position.set`, a manual position that wins over the looks), and
 * drives its light's channels as channel faders — at the first touch of a channel, `fader.put`
 * creates a fader for this one channel (started at the level the fixture really has now, dosed by the
 * DCAs like any other fader), then `fader.level` follows the gesture. The sections close themselves
 * by right: « Mouvement » only shows itself with `commands:position` (and a head to move), « Lumière »
 * with `show:write` and `commands:level` (else a line says what is missing). Lives on the Venue
 * page's plan only, where the selection is.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { can, cmd, type Role } from "../api";
import { useMe, useT } from "../App";
import { useCommandEvents, useTopic } from "../hooks/useTopic";
import { FaderTrack } from "./FaderTrack";
import { XyPad } from "./XyPad";

interface Head {
  id: string;
  manual: { pan: number; tilt: number } | null;
}
interface ChannelRow {
  offset: number;
  name: string;
  attribute: string;
  color?: string;
}
interface FaderRow {
  id: string;
  name: string;
  channels: { fixture: string; offset: number }[];
  level: number;
}
/** Levels of the smoothed faders still on their way (topic light:glide). */
interface Glide {
  faders: Record<string, number>;
}

export function FixturePanel({ fixture, onError, onClose }: { fixture: { id: string; name: string; absent?: boolean }; onError: (msg: string) => void; onClose: () => void }) {
  const t = useT();
  const me = useMe() as Role | null;
  const [heads, setHeads] = useState<Head[]>([]);
  const [channels, setChannels] = useState<ChannelRow[]>([]);
  const [faders, setFaders] = useState<FaderRow[]>([]);
  const [patch, setPatch] = useState<{ universe: number; address: number } | null>(null);
  /** Level shown for each channel (its fader's, or the channel's value before its fader exists). */
  const [levels, setLevels] = useState<Record<number, number>>({});
  /** The manual position read or sent by the pad, for the read-out. */
  const [pos, setPos] = useState<{ pan: number; tilt: number } | null>(null);
  /** Bumped on every read: the pad reads its dot again from position.list. */
  const [stamp, setStamp] = useState(0);
  /** Channels whose fader is being created (the gesture's level rides along until it is saved). */
  const working = useRef(new Map<number, { pending?: number }>());
  /** Channel values read once (a channel shown before its fader exists starts at what the fixture has). */
  const explained = useRef(new Set<string>());

  useEffect(() => {
    setLevels({});
    explained.current.clear();
    working.current.clear();
  }, [fixture.id]);

  const read = useCallback(() => {
    void cmd<FaderRow[]>("fader.list").then(setFaders).catch(() => undefined);
    void cmd<Head[]>("position.list").then(setHeads).catch(() => undefined);
    // channels that can be dosed: everything but the pan and tilt of a moving head, whatever the rest does
    void cmd<{ id: string; channels: ChannelRow[] }[]>("venue.fixture.channels")
      .then((rows) => setChannels((rows.find((r) => r.id === fixture.id)?.channels ?? []).filter((c) => c.attribute !== "pan" && c.attribute !== "tilt")))
      .catch(() => undefined);
    void cmd<{ id: string; universe: number; address: number }[]>("venue.fixture.list")
      .then((rows) => {
        const row = rows.find((r) => r.id === fixture.id);
        setPatch(row ? { universe: row.universe, address: row.address } : null);
      })
      .catch(() => undefined);
    setStamp((s) => s + 1);
  }, [fixture.id]);
  useEffect(read, [read]);
  // the light follows fader changes from elsewhere, and the movement an aim, a Panic, a show
  // opened, or the patch itself (a re-patch, a definition added)
  useCommandEvents(["position.", "panic", "show.", "fader.", "venue.fixture."], read);
  const glide = useTopic<Glide>("light:glide", { faders: {} });

  /** The channel faders that drive this fixture only, by channel offset. */
  const byOffset = new Map(faders.filter((f) => f.channels.length === 1 && f.channels[0]!.fixture === fixture.id).map((f) => [f.channels[0]!.offset, f]));
  const head = heads.find((h) => h.id === fixture.id);
  const may = (right: string) => (me ? can(me, right) : false);

  // A channel without a fader shows what the fixture has now: its future fader starts there.
  useEffect(() => {
    if (!patch) return;
    for (const c of channels) {
      const key = `${fixture.id}:${c.offset}`;
      if (byOffset.has(c.offset) || explained.current.has(key)) continue;
      explained.current.add(key);
      void cmd<{ value: number }>("dmx.explain", { universe: patch.universe, channel: patch.address + c.offset })
        .then((e) => setLevels((l) => ({ ...l, [c.offset]: Math.round(((e.value ?? 0) / 255) * 1000) / 1000 })))
        .catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channels, patch, byOffset]);

  /** A channel's level: creates its fader on the first touch, from the level the fixture has now. */
  const setChannelLevel = (c: ChannelRow, level: number) => {
    if (fixture.absent || !patch) return;
    setLevels((l) => ({ ...l, [c.offset]: level }));
    const created = working.current.get(c.offset);
    if (created) {
      created.pending = level;
      return;
    }
    const existing = byOffset.get(c.offset);
    if (existing) {
      setFaders((fs) => fs.map((x) => (x.id === existing.id ? { ...x, level } : x))); // the gesture shows at once, like the dashboards
      void cmd("fader.level", { id: existing.id, level }).catch((e: Error) => onError(e.message));
      return;
    }
    const wait: { pending?: number } = { pending: level };
    working.current.set(c.offset, wait);
    void (async () => {
      // the level the channel really has now: creating a fader must not switch a dimmer off (its
      // default would be 0), and the DCAs dose the created fader like any other
      const e = await cmd<{ value: number }>("dmx.explain", { universe: patch.universe, channel: patch.address + c.offset });
      const initial = Math.round(((e.value ?? 0) / 255) * 1000) / 1000;
      // a deterministic id, ours alone to re-find; a fader already in the way is not reused unless it
      // is strictly this one channel (byOffset holds every one that is)
      const base = `panel-${fixture.id}-${c.offset}`;
      const ours = byOffset.get(c.offset);
      const taken = new Set(faders.filter((f) => f !== ours).map((f) => f.id));
      let id = base;
      for (let k = 2; taken.has(id) && k < 100; k++) id = `${base}-${k}`;
      const name = `${t.panelFaderPrefix} ${fixture.name} · ${c.name}`;
      const saved = await cmd<{ id: string }>("fader.put", { fader: { id, name, channels: [{ fixture: fixture.id, offset: c.offset }], level: initial } });
      setFaders((fs) => [...fs.filter((f) => f.id !== saved.id), { id: saved.id, name, channels: [{ fixture: fixture.id, offset: c.offset }], level: initial }]);
      setLevels((l) => ({ ...l, [c.offset]: wait.pending ?? initial }));
      if (wait.pending !== undefined && wait.pending !== initial) await cmd("fader.level", { id: saved.id, level: wait.pending });
    })()
      .catch((e: Error) => onError(e.message))
      .finally(() => void working.current.delete(c.offset));
  };

  const faderRow = (c: ChannelRow) => {
    const f = byOffset.get(c.offset);
    const level = f ? f.level : levels[c.offset] ?? 0;
    return (
      <div key={c.offset} className="fader" style={c.color ? ({ "--wc": c.color } as CSSProperties) : undefined}>
        <FaderTrack label={`${t.channelFader} ${c.name}`} value={level} sent={f ? glide.faders[f.id] : undefined} disabled={false} interactive={true} onChange={(v) => setChannelLevel(c, v)} />
        <span className="value">{Math.round(level * 100)}%</span>
        <label title={c.name}>{c.name}</label>
      </div>
    );
  };

  return (
    <div className="fixture-panel">
      <div className="row">
        <strong>{fixture.name}</strong>
        <button className="ghost" title={t.closePanel} aria-label={`${t.closePanel} ${fixture.name}`} onClick={onClose}>
          ✕
        </button>
      </div>
      {fixture.absent && <small className="hint">{t.panelAbsent}</small>}
      {!fixture.absent && (
        <>
          {head && (
            <section>
              <h4>{t.panelMovement}</h4>
              {may("commands:position") ? (
                <>
                  <XyPad fixture={fixture.id} label={fixture.name} onPosition={setPos} resync={stamp} onError={onError} />
                  <small>{pos ? `pan ${Math.round(pos.pan * 100)} % · tilt ${Math.round(pos.tilt * 100)} %` : t.followsLooks}</small>
                </>
              ) : (
                <small className="hint">{t.panelNoPositionRight}</small>
              )}
            </section>
          )}
          <section>
            <h4>{t.panelLight}</h4>
            {may("show:write") && may("commands:level") ? (
              channels.length ? (
                <div className="panel-channels">{channels.map(faderRow)}</div>
              ) : (
                <small className="hint">{t.panelNoDefinition}</small>
              )
            ) : (
              <small className="hint">{t.panelNoLevelRight}</small>
            )}
          </section>
        </>
      )}
    </div>
  );
}
