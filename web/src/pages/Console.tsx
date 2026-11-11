import { useEffect, useRef, useState, type ReactElement } from "react";
import { cmd, lightState } from "../api";
import { useT } from "../App";
import { stream } from "../ws";
import { quoted } from "../typography";

interface Patched {
  id: string;
  name: string;
  universe: number;
  address: number;
  channels: { offset: number; name: string }[];
}

const PATCHED_ONLY = "console.patchedOnly";

interface Explain {
  universe: number;
  channel: number;
  value: number;
  parked?: number;
  fixture?: { id: string; name: string; offset: number; channel?: string; attribute?: string; definition: boolean };
  intensity?: { grandMaster: number; dcas: { id: string; name: string; own: number; effective: number }[]; factor: number };
  faders: { id: string; name: string; level: number; dca?: string; effective: number }[];
  rawLooks: { id: string; name: string; leaving?: true }[];
  clamps: { rule: string; name?: string; from: number; to: number }[];
  /** Its fixture has Reset channels, held at rest by the built-in protection: fixture.reset resets it on purpose. */
  resettable?: boolean;
}

const pct = (x: number) => `${Math.round(x * 100)} %`;

/** Why a channel has its value, one line per cause, as the console's « why » panel says it. */
function WhyPanel({ why, onClose, onError }: { why: Explain; onClose: () => void; onError: (message: string) => void }) {
  const t = useT();
  const f = why.fixture;
  const [resetDone, setResetDone] = useState("");
  /** A voluntary reset: the built-in protection is lifted for this fixture only, a few seconds. */
  const reset = (fixture: { id: string; name: string }) => {
    if (!confirm(t.resetFixtureConfirm.replace("{name}", quoted(t, fixture.name)))) return;
    void cmd<{ seconds: number }>("fixture.reset", { id: fixture.id }).then((r) => setResetDone(t.resetFixtureDone.replace("{s}", String(r.seconds))), (e: Error) => onError(e.message));
  };
  return (
    <section className="report why" aria-label={`${t.whyChannel} ${why.channel}`}>
      <div className="row">
        <strong>
          U{why.universe}.{why.channel} = {why.value}
        </strong>
        <span className="grow" />
        <button className="ghost" aria-label={t.close} onClick={onClose}>
          ✕
        </button>
      </div>
      <ul>
        {why.parked !== undefined && <li className="warn">{t.whyParked.replace("{v}", String(why.parked))}</li>}
        {f ? (
          <li>
            {f.name} · {t.whyChannelOf} {f.offset}
            {f.channel ? ` (${f.channel}${f.attribute ? `, ${f.attribute}` : ""})` : ""}
            {!f.definition && <span className="badge conflict"> {t.noDefinition}</span>}
          </li>
        ) : (
          <li className="hint">{t.whyNoFixture}</li>
        )}
        {why.intensity && (
          <li>
            {t.whyIntensity}{t.colon} {t.grandMasterShort} {pct(why.intensity.grandMaster)}
            {why.intensity.dcas.map((d) => ` × ${d.name} ${pct(d.effective)}${d.effective !== d.own ? ` (${t.whyOwn} ${pct(d.own)})` : ""}`).join("")} = {pct(why.intensity.factor)}
          </li>
        )}
        {why.faders.map((x) => (
          <li key={x.id}>
            {t.whyFader} {quoted(t, x.name)} {pct(x.level)}
            {x.dca ? ` × DCA → ${pct(x.effective)}` : ""}
          </li>
        ))}
        {why.rawLooks.map((l) => (
          <li key={l.id}>
            {t.whyRawLook} {quoted(t, l.name)}{l.leaving ? ` (${t.whyLeaving})` : ""}
          </li>
        ))}
        {why.clamps.map((c, i) => (
          <li key={i} className="warn">
            {t.whyClamp.replace("{rule}", c.name ?? c.rule).replace("{from}", String(c.from)).replace("{to}", String(c.to))}
          </li>
        ))}
      </ul>
      {f && why.resettable && (
        <div className="row">
          <button title={t.resetFixtureHelp} onClick={() => reset(f)}>
            {t.resetFixture}
          </button>
          {resetDone && <span className="hint">{resetDone}</span>}
        </div>
      )}
    </section>
  );
}

/**
 * DMX console: one fader per channel, live output values, park/release (docs/specs/ui-dashboards.md).
 * By default it shows the patched channels grouped by fixture, with their names, as a console's
 * fixture sheet does; « tous les canaux » brings back the 512.
 */
export function ConsolePage(): ReactElement {
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
  /** The channel whose value is explained (dmx.explain), read again every second while open. */
  const [explained, setExplained] = useState<number | null>(null);
  const [why, setWhy] = useState<Explain | null>(null);
  useEffect(() => {
    if (explained === null) return setWhy(null);
    const load = () => void cmd<Explain>("dmx.explain", { universe, channel: explained }).then(setWhy, (e: Error) => setError(e.message));
    load();
    const poll = window.setInterval(load, 1000);
    return () => window.clearInterval(poll);
  }, [explained, universe]);
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
      .then(([list, channels]) => setPatch(list.map((f) => ({ ...f, channels: channels.find((c) => c.id === f.id)?.channels ?? [] }))))
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
      const batch = Object.fromEntries(pending.current);
      pending.current.clear();
      void cmd("dmx.set", { universe, values: batch }).catch((e: Error) => {
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
      <div key={ch} className={`ch${isParked ? " parked" : ""}${explained === ch ? " explained" : ""}`} title={name ? `${name.fixture} · ${name.channel}` : undefined}>
        <button className="num" aria-label={`${t.whyChannel} ${ch}`} aria-pressed={explained === ch} onClick={() => setExplained(explained === ch ? null : ch)}>
          {ch}
        </button>
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
      {why && <WhyPanel key={why.channel} why={why} onClose={() => setExplained(null)} onError={setError} />}
      {!why && <p className="hint">{t.whyChannelHelp}</p>}
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
