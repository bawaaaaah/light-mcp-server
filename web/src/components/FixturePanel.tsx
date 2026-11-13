/**
 * Control panel of a fixture held on the stage plan (docs/specs/venue-fixtures-stage.md, « Lyres »):
 * it moves its head with the XY pad (`position.set`, a manual position that wins over the looks), and
 * drives its light's channels as channel faders — at the first touch of a channel, `fader.channel`
 * creates a fader for this one channel (at the gesture's level, dosed by the DCAs like any other
 * fader), then `fader.level` follows the gesture. Mounted per fixture (keyed by its id). The sections close themselves
 * by right: « Mouvement » only shows itself with `commands:position` (and a head to move), « Lumière »
 * with `show:write` and `commands:level` (else a line says what is missing). Lives on the Venue
 * page's plan only, where the selection is.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactElement } from "react";
import { useFloatingMenu } from "./menu";
import { can, cmd, type Role } from "../api";
import { useMe, useT } from "../App";
import { useCommandEvents, useTopic } from "../hooks/useTopic";
import { rangeAt, type NamedRange } from "../fader-functions";
import { quoted } from "../typography";
import { stream } from "../ws";
import { FaderTrack } from "./FaderTrack";
import { ModePicker, type ModeItem } from "./ModePicker";
import { XyPad, type MotionHead } from "./XyPad";

interface ChannelMode {
  name: string;
  min: number;
  max: number;
  variants: NamedRange[];
  continuous: boolean;
}
interface ChannelRow {
  offset: number;
  name: string;
  attribute: string;
  color?: string;
  /** A channel cut into functions (venue.fixture.channels): its flat ranges, and the same read as modes (T6). */
  ranges?: NamedRange[];
  modes?: ChannelMode[];
}
/** What fixture.channel.mode answers: the look or faders holding the channel higher, when they do. */
interface ModeSet {
  heldBy?: { looks: { name: string }[]; faders: { name: string }[] };
  below?: true;
  blackout?: true;
  clamps?: { rule: string; name?: string }[];
  dcas?: string[];
  grandMaster?: number;
}

/**
 * A channel's modes, opened right under its button (anchored, kept on screen: on a phone the list would
 * otherwise land after every fader, off screen): the focus goes in when it opens, Escape or a click
 * elsewhere closes it; the panel gives the focus back to the button.
 */
function ChannelModeMenu({ anchor, title, items, onPick, onClose }: { anchor: DOMRect; title: string; items: ModeItem[]; onPick: (i: ModeItem) => void; onClose: () => void }): ReactElement {
  const { box, style } = useFloatingMenu({ x: anchor.left, y: anchor.bottom + 4 }, onClose, anchor.top - 4);
  return (
    <div ref={box} className="widget-menu mode-menu" role="dialog" aria-label={title} style={style}>
      <ModePicker title={title} heading={false} focusOnOpen items={items} onPick={onPick} />
    </div>
  );
}
interface FaderRow {
  id: string;
  name: string;
  channels: { fixture: string; offset: number }[];
  level: number;
  /** Set on a fader narrowed to part of the travel (a function, T12): not this panel's. */
  range?: { min: number; max: number };
}
/** Levels of the smoothed faders still on their way (topic light:glide). */
interface Glide {
  faders: Record<string, number>;
}

/** Whether a fader's range leaves part of the travel out (an explicit 0..255 is the whole travel): such a fader is not the panel's. */
const narrowed = (range: { min: number; max: number } | undefined) => range !== undefined && (range.min > 0 || range.max < 255);

export function FixturePanel({ fixture, onError, onClose }: { fixture: { id: string; name: string; absent?: boolean }; onError: (msg: string) => void; onClose: () => void }): ReactElement {
  const t = useT();
  const me = useMe() as Role | null;
  const [heads, setHeads] = useState<MotionHead[]>([]);
  const [channels, setChannels] = useState<ChannelRow[]>([]);
  const [faders, setFaders] = useState<FaderRow[]>([]);
  const [patch, setPatch] = useState<{ universe: number; address: number } | null>(null);
  /** Level shown for each channel (its fader's, or the channel's value before its fader exists). */
  const [levels, setLevels] = useState<Record<number, number>>({});
  /** Bumped on every read: the pad reads its dot again from position.list. */
  const [stamp, setStamp] = useState(0);
  /** Channels whose fader is being created (the gesture's level rides along until it is saved). */
  const working = useRef(new Map<number, { pending?: number }>());
  /** Channel values read once (a channel shown before its fader exists starts at what the fixture has). */
  const explained = useRef(new Set<string>());
  /** The fixture's universe as it goes out (light:dmx): the mode in force is read there, a look that wins shows (T6). */
  const [out, setOut] = useState<Uint8Array | null>(null);
  /** The channel whose mode list is open, by offset. */
  const [picking, setPicking] = useState<{ offset: number; anchor: DOMRect } | null>(null);
  /** Each channel's mode button, by offset: the focus goes back there when its list closes. */
  const modeButtons = useRef<Record<number, HTMLButtonElement | null>>({});
  const closePicker = () => {
    const back = picking ? modeButtons.current[picking.offset] : undefined;
    setPicking(null);
    back?.focus();
  };
  /** By offset: the range last asked from the panel, and who held the channel higher then (or the blackout). */
  const [asked, setAsked] = useState<Record<number, { min: number; max: number; above: string; below: string }>>({});

  const read = useCallback(() => {
    void cmd<FaderRow[]>("fader.list").then(setFaders).catch(() => undefined);
    void cmd<MotionHead[]>("position.list").then(setHeads).catch(() => undefined);
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
  // one universe followed, only while a channel has modes to show; left when the panel goes (a tablet keeps no stream)
  const followsModes = channels.some((c) => c.modes?.length);
  const universe = patch?.universe;
  /** The DMX slots of the channels with modes: the panel renders again only when one of them changes (not 25 times a second). */
  const watched = patch ? channels.filter((c) => c.modes?.length).map((c) => patch.address - 1 + c.offset) : [];
  const watchedKey = watched.join(",");
  const lastSeen = useRef("");
  useEffect(() => {
    if (!followsModes || universe === undefined) return;
    const slots = watchedKey.split(",").map(Number);
    lastSeen.current = "";
    return stream.subscribe(
      "light:dmx",
      (d) => {
        const mine = (d as { universes: [number, Uint8Array][] }).universes.find(([u]) => u === universe);
        if (!mine) return;
        const seen = slots.map((i) => mine[1][i] ?? 0).join(",");
        if (seen === lastSeen.current) return;
        lastSeen.current = seen;
        setOut(new Uint8Array(mine[1]));
      },
      { universes: [universe] },
    );
  }, [followsModes, universe, watchedKey]);

  /** The channel faders that drive one channel of this fixture over its whole travel, by channel offset (as fader.channel finds them). */
  const byOffset = new Map(faders.filter((f) => f.channels.length === 1 && f.channels[0]!.fixture === fixture.id && !narrowed(f.range)).map((f) => [f.channels[0]!.offset, f]));
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
    // moved by hand: the mode asked from the list no longer is, nothing to say about who holds it
    setAsked((a) => {
      if (!(c.offset in a)) return a;
      const { [c.offset]: _gone, ...rest } = a;
      return rest;
    });
    // the gesture shows at once on this channel's fader, like the dashboards
    setFaders((fs) => fs.map((x) => (x.channels.length === 1 && x.channels[0]!.fixture === fixture.id && x.channels[0]!.offset === c.offset && !narrowed(x.range) ? { ...x, level } : x)));
    const created = working.current.get(c.offset);
    if (created) {
      created.pending = level;
      return;
    }
    const existing = byOffset.get(c.offset);
    if (existing) {
      void cmd("fader.level", { id: existing.id, level }).catch((e: Error) => onError(e.message));
      return;
    }
    const wait: { pending?: number } = { pending: level };
    working.current.set(c.offset, wait);
    void (async () => {
      // the server finds or creates the fader of exactly this channel (docs/specs/venue-fixtures-stage.md, « Lyres »)
      const name = `${t.panelFaderPrefix} ${fixture.name} · ${c.name}`;
      const saved = await cmd<FaderRow & { created: boolean }>("fader.channel", { fixture: fixture.id, offset: c.offset, name, level });
      let sent = saved.created ? level : saved.level;
      setFaders((fs) => [...fs.filter((f) => f.id !== saved.id), { ...saved, level: wait.pending ?? sent }]);
      // what the gesture asked while a request was out goes too, until the last value has been sent
      while (wait.pending !== undefined && wait.pending !== sent) {
        sent = wait.pending;
        await cmd("fader.level", { id: saved.id, level: sent });
      }
    })()
      .catch((e: Error) => onError(e.message))
      .finally(() => void working.current.delete(c.offset));
  };

  /** What goes out on a channel now (light:dmx), once the stream has spoken. */
  const outOf = (c: ChannelRow) => (out && patch ? out[patch.address - 1 + c.offset] : undefined);
  /** The mode and variant a value is in, by their ranges. */
  const modeOf = (c: ChannelRow, value: number | undefined) => {
    if (value === undefined) return undefined;
    for (const m of c.modes ?? []) {
      const v = rangeAt(m.variants, value);
      if (v) return { mode: m, variant: v };
    }
    return undefined;
  };
  /** A channel's mode by name (fixture.channel.mode), through its own fader; who holds it higher is kept to be said. */
  const pickMode = (c: ChannelRow, mode: ChannelMode, variant?: NamedRange) => {
    closePicker();
    // `min` tells two modes of one name apart (« No function » at both ends of a channel)
    void cmd<ModeSet>("fixture.channel.mode", { fixture: fixture.id, offset: c.offset, mode: mode.name, min: mode.min, ...(variant ? { variant: variant.name, variantMin: variant.min } : {}) })
      .then((r) => {
        const v = variant ?? mode.variants[0]!;
        const heldBy = [...(r.heldBy?.looks ?? []), ...(r.heldBy?.faders ?? [])].map((x) => quoted(t, x.name)).join(", ");
        // below the range: a blackout, the DCA dosing this fader, or a rule bounding the channel says why
        const below = r.blackout
          ? t.fixtureMode.blackout
          : [
              r.dcas?.length === 1 ? t.fixtureMode.dosedBy.replace("{dca}", r.dcas[0]!) : r.dcas?.length ? t.fixtureMode.dosedByMany.replace("{list}", r.dcas.map((d) => quoted(t, d)).join(", ")) : "",
              r.grandMaster !== undefined ? t.fixtureMode.grandMasterBelow.replace("{n}", String(Math.round(r.grandMaster * 100))) : "",
              r.clamps?.length ? t.fixtureMode.boundBy.replace("{rules}", r.clamps.map((x) => quoted(t, x.name ?? x.rule)).join(", ")) : "",
            ]
              .filter(Boolean)
              .join(" ");
        setAsked((a) => ({ ...a, [c.offset]: { min: v.min, max: v.max, above: heldBy ? t.fixtureMode.heldBy.replace("{who}", heldBy) : "", below } }));
      })
      .catch((e: Error) => onError(e.message));
  };
  const modeItems = (c: ChannelRow): ModeItem[] => {
    const now = modeOf(c, outOf(c));
    const range = (r: { min: number; max: number }) => `${r.min}–${r.max}`;
    return (c.modes ?? []).flatMap((m) => {
      // a mode's own row sets its first variant: it shows that variant's values, the ones it sends
      const row: ModeItem = { key: `m:${m.name}:${m.min}`, label: m.name, detail: range(m.variants[0]!), current: m.variants.length < 2 && now?.mode === m };
      if (m.variants.length < 2) return [row];
      return [row, ...m.variants.map((v) => ({ key: `v:${v.name}:${v.min}`, label: v.name, detail: range(v), parent: row.key, current: now?.variant === v }))];
    });
  };
  const onModePick = (c: ChannelRow, item: ModeItem) => {
    for (const m of c.modes ?? []) {
      if (item.key === `m:${m.name}:${m.min}`) return pickMode(c, m);
      const v = m.variants.find((x) => item.key === `v:${x.name}:${x.min}`);
      if (v) return pickMode(c, m, v);
    }
  };

  const faderRow = (c: ChannelRow) => {
    const f = byOffset.get(c.offset);
    const level = f ? f.level : levels[c.offset] ?? 0;
    const now = c.modes?.length ? modeOf(c, outOf(c)) : undefined;
    const shown = now ? (now.mode.variants.length > 1 ? now.variant.name : now.mode.name) : t.fixtureMode.between;
    return (
      <div key={c.offset} className="fader" style={c.color ? ({ "--wc": c.color } as CSSProperties) : undefined}>
        {c.modes?.length
          ? (() => {
              const text = t.fixtureMode.pick.replace("{channel}", c.name).replace("{mode}", outOf(c) === undefined ? "…" : shown);
              return (
                <button
                  type="button"
                  className="mode-button"
                  ref={(el) => void (modeButtons.current[c.offset] = el)}
                  title={`${text} — ${t.fixtureMode.pickHelp}`}
                  aria-haspopup="dialog"
                  aria-expanded={picking?.offset === c.offset}
                  // the open list closes on a press elsewhere: this press toggles it instead of reopening it
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => (picking?.offset === c.offset ? closePicker() : setPicking({ offset: c.offset, anchor: e.currentTarget.getBoundingClientRect() }))}
                >
                  <span className="mode-text">{text}</span>
                  <span aria-hidden> ▾</span>
                </button>
              );
            })()
          : null}
        <FaderTrack
          label={`${t.channelFader} ${c.name}`}
          value={level}
          sent={f ? glide.faders[f.id] : undefined}
          disabled={false}
          interactive={true}
          onChange={(v) => setChannelLevel(c, v)}
          ranges={c.ranges}
          rangesLabel={t.fixtureMode.ranges.replace("{channel}", c.name)}
        />
        <span className="value">{Math.round(level * 100)}%</span>
        <label title={c.name}>{c.name}</label>
      </div>
    );
  };
  /** The channels whose asked mode does not go out: someone holds them higher (highest takes precedence, decision T6). */
  const held = channels.flatMap((c) => {
    const a = asked[c.offset];
    const v = outOf(c);
    // HTP: held above the range by a look or a fader; below it, a blackout, a DCA or a rule
    const say = v === undefined || !a ? "" : v > a.max ? a.above : v < a.min ? a.below : "";
    return say ? [{ c, say }] : [];
  });
  const open = channels.find((c) => c.offset === picking?.offset);

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
                  <XyPad fixture={fixture.id} label={fixture.name} resync={stamp} onError={onError} restControls />
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
                <>
                  <div className="panel-channels">{channels.map(faderRow)}</div>
                  {open?.modes && picking && <ChannelModeMenu anchor={picking.anchor} title={`${open.name} — ${t.fixtureMode.pickHelp}`} items={modeItems(open)} onPick={(i) => onModePick(open, i)} onClose={closePicker} />}
                  {held.map(({ c, say }) => (
                    <p key={c.offset} className="warn" role="status">
                      {c.name}
                      {t.colon} {say}
                    </p>
                  ))}
                </>
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
