import { useEffect, useRef, useState } from "react";
import { cmd, lightState } from "../api";
import { useT } from "../App";
import { stream } from "../ws";

interface Patched {
  id: string;
  name: string;
  universe: number;
  address: number;
  channels: { offset: number; name: string }[];
}

const PATCHED_ONLY = "console.patchedOnly";

/**
 * DMX console: one fader per channel, live output values, park/release (docs/specs/ui-dashboards.md).
 * By default it shows the patched channels grouped by fixture, with their names, as a console's
 * fixture sheet does; « tous les canaux » brings back the 512.
 */
export function ConsolePage() {
  const t = useT();
  const [universe, setUniverse] = useState(1);
  const [count, setCount] = useState(1);
  const [values, setValues] = useState<Uint8Array>(new Uint8Array(512));
  const [parked, setParked] = useState<Record<number, number>>({});
  const [patch, setPatch] = useState<Patched[] | null>(null);
  const [patchedOnly, setPatchedOnly] = useState(() => {
    try {
      return localStorage.getItem(PATCHED_ONLY) !== "0";
    } catch {
      return true;
    }
  });
  const [error, setError] = useState("");
  const pending = useRef(new Map<number, number>());
  const timer = useRef<number | null>(null);

  useEffect(() => {
    void lightState()
      .then((s) => setCount(s.universes))
      .catch(() => undefined);
    void Promise.all([
      cmd<{ id: string; name: string; universe: number; address: number }[]>("venue.fixture.list"),
      cmd<{ id: string; channels: { offset: number; name: string }[] }[]>("venue.fixture.channels"),
    ])
      .then(([fixtures, channels]) => setPatch(fixtures.map((f) => ({ ...f, channels: channels.find((c) => c.id === f.id)?.channels ?? [] }))))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    void cmd<{ parked: Record<number, number> }>("dmx.get", { universe }).then((r) => setParked(r.parked));
    return stream.subscribe(
      "light:dmx",
      (d) => {
        const frame = d as { universes: [number, Uint8Array][] };
        const mine = frame.universes.find(([u]) => u === universe);
        if (mine) setValues(new Uint8Array(mine[1]));
      },
      { universes: [universe] },
    );
  }, [universe]);

  /** Coalesces fader moves into one dmx.set per animation frame. */
  const park = (channel: number, value: number) => {
    pending.current.set(channel, value);
    setParked((p) => ({ ...p, [channel]: value }));
    if (timer.current !== null) return;
    timer.current = requestAnimationFrame(() => {
      timer.current = null;
      const values = Object.fromEntries(pending.current);
      pending.current.clear();
      void cmd("dmx.set", { universe, values }).catch((e: Error) => {
        setError(e.message);
        void cmd<{ parked: Record<number, number> }>("dmx.get", { universe }).then((r) => setParked(r.parked));
      });
    });
  };
  const release = (ch: number) => {
    void cmd("dmx.release", { universe, channels: [ch] });
    setParked((p) => {
      const n = { ...p };
      delete n[ch];
      return n;
    });
  };
  const showPatchedOnly = (on: boolean) => {
    setPatchedOnly(on);
    try {
      localStorage.setItem(PATCHED_ONLY, on ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
  };

  const fixtures = (patch ?? []).filter((f) => f.universe === universe && f.channels.length > 0).sort((a, b) => a.address - b.address);
  const names = new Map<number, { fixture: string; channel: string }>();
  for (const f of fixtures) for (const c of f.channels) names.set(f.address + c.offset, { fixture: f.name, channel: c.name });
  const byFixture = patchedOnly && fixtures.length > 0;

  const fader = (ch: number) => {
    const isParked = parked[ch] !== undefined;
    const v = values[ch - 1] ?? 0;
    const name = names.get(ch);
    return (
      <div key={ch} className={isParked ? "ch parked" : "ch"} title={name ? `${name.fixture} · ${name.channel}` : undefined}>
        <span className="num">{ch}</span>
        <input
          type="range"
          min={0}
          max={255}
          aria-label={name ? `${ch} ${name.fixture} ${name.channel}` : String(ch)}
          value={isParked ? parked[ch] : v}
          onChange={(e) => park(ch, Number(e.target.value))}
          onDoubleClick={() => release(ch)}
          title={isParked ? `${t.parked} — ${t.release}: ${t.doubleClick}` : ""}
        />
        <span className="val" style={{ background: `rgba(255,190,90,${v / 255})` }}>
          {v}
        </span>
        {name && <span className="lbl">{name.channel}</span>}
      </div>
    );
  };

  return (
    <div className="console">
      <section className="bar">
        <label>
          {t.universe}{" "}
          <select value={universe} onChange={(e) => setUniverse(Number(e.target.value))}>
            {Array.from({ length: count }, (_, i) => i + 1).map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </label>
        {fixtures.length > 0 && (
          <span className="row view-switch" role="radiogroup" aria-label={t.consoleView}>
            <button role="radio" aria-checked={byFixture} className={byFixture ? "ghost on" : "ghost"} onClick={() => showPatchedOnly(true)}>
              {t.patchedChannels}
            </button>
            <button role="radio" aria-checked={!byFixture} className={byFixture ? "ghost" : "ghost on"} onClick={() => showPatchedOnly(false)}>
              {t.allChannels}
            </button>
          </span>
        )}
        <button
          onClick={() =>
            void cmd("dmx.release", { universe }).then(() => {
              setParked({});
            })
          }
        >
          {t.releaseAll}
        </button>
        {error && (
          <span className="error" onClick={() => setError("")}>
            {error}
          </span>
        )}
      </section>
      {patch !== null && fixtures.length === 0 && <p className="hint">{t.noPatchHere}</p>}
      {byFixture ? (
        <div className="channels by-fixture">
          {fixtures.map((f) => (
            <section key={f.id} className="fx" aria-label={f.name}>
              <h3>
                {f.name} <small>U{f.universe}.{f.address}</small>
              </h3>
              <div className="fx-ch">{f.channels.map((c) => fader(f.address + c.offset))}</div>
            </section>
          ))}
        </div>
      ) : (
        <div className="channels">{Array.from({ length: 512 }, (_, i) => fader(i + 1))}</div>
      )}
    </div>
  );
}
