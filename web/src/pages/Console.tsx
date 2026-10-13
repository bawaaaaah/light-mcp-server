import { useEffect, useRef, useState } from "react";
import { cmd, lightState } from "../api";
import { useT } from "../App";
import { stream } from "../ws";

/** DMX console: one fader per channel, live output values, park/release (docs/specs/ui-dashboards.md). */
export function ConsolePage() {
  const t = useT();
  const [universe, setUniverse] = useState(1);
  const [count, setCount] = useState(1);
  const [values, setValues] = useState<Uint8Array>(new Uint8Array(512));
  const [parked, setParked] = useState<Record<number, number>>({});
  const pending = useRef(new Map<number, number>());
  const timer = useRef<number | null>(null);

  useEffect(() => {
    void lightState()
      .then((s) => setCount(s.universes))
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
      void cmd("dmx.set", { universe, values });
    });
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
        <button
          onClick={() =>
            void cmd("dmx.release", { universe }).then(() => {
              setParked({});
            })
          }
        >
          {t.releaseAll}
        </button>
      </section>
      <div className="channels">
        {Array.from({ length: 512 }, (_, i) => {
          const ch = i + 1;
          const isParked = parked[ch] !== undefined;
          const v = values[i] ?? 0;
          return (
            <div key={ch} className={isParked ? "ch parked" : "ch"}>
              <span className="num">{ch}</span>
              <input
                type="range"
                min={0}
                max={255}
                value={isParked ? parked[ch] : v}
                onChange={(e) => park(ch, Number(e.target.value))}
                onDoubleClick={() => {
                  void cmd("dmx.release", { universe, channels: [ch] });
                  setParked((p) => {
                    const n = { ...p };
                    delete n[ch];
                    return n;
                  });
                }}
                title={isParked ? `${t.parked} — ${t.release}: double-clic` : ""}
              />
              <span className="val" style={{ background: `rgba(255,190,90,${v / 255})` }}>
                {v}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
