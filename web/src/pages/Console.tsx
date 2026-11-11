import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
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
  /** `head`: the colour head it drives on a fixture with several (0-based); `accent`: that head is the halo. */
  fixture?: { id: string; name: string; offset: number; channel?: string; attribute?: string; definition: boolean; head?: number; accent?: true };
  /** A colour channel: the looks painting its head (or the whole fixture) now. */
  paintingLooks?: { id: string; name: string; level?: number }[];
  /** Every DCA covering the fixture, each once: `own` is the factor multiplied; `dosesRaw` on its light channel (a raw write there is dosed). */
  intensity?: { grandMaster: number; dcas: { id: string; name: string; own: number; effective: number }[]; factor: number; dosesRaw?: true };
  /** Not a light channel: neither the grand master nor any DCA doses it. */
  undosed?: true;
  /** The DCAs channel faders link to this light channel: they dose the looks writing it too. */
  faderDcas?: { dcas: { id: string; name: string; own: number }[]; factor: number };
  /** `effective`: the fader's own value here, its DCAs (`dcas`) and the grand master when it reaches it; `doses` on a colour fixture's dimmer. */
  faders: { id: string; name: string; level: number; travel: number; dca?: string; effective: number; dcas: { id: string; name: string; own: number }[]; grandMaster?: number; doses?: true }[];
  /** `level`: what the groups including the look give it on this fixture, when below 100 %. */
  rawLooks: { id: string; name: string; leaving?: true; level?: number }[];
  clamps: { rule: string; name?: string; from: number; to: number }[];
  /** A lamp's colour wheel: the slot held (its real colour, two joined by « + » for a split slot), the colour asked and the gap between them (OKLab). */
  wheel?: { slot: string; color: string; asked?: string; gap: number };
  /** Its fixture has Reset channels, held at rest by the built-in protection: fixture.reset resets it on purpose. */
  resettable?: boolean;
  /** Those channels, the Reset range each would send, and the seconds left while a reset runs. */
  reset?: { channels: { name: string; range: string; others: string[] }[]; secondsLeft?: number };
}

/** The last DMX slot of a universe: a fixture running past it loses its last channels. */
const SLOTS = 512;

const pct = (x: number) => `${Math.round(x * 100)} %`;

/** A wheel colour (or two, « #a+#b ») as swatches before its hex. */
function WheelColors({ hex }: { hex: string }) {
  return (
    <>
      {hex.split("+").map((h) => (
        <span key={h} className="swatch-dot" style={{ background: h }} />
      ))}
      {hex}
    </>
  );
}

/** Why a channel has its value, one line per cause, as the console's « why » panel says it. */
function WhyPanel({ why, onClose, onError }: { why: Explain; onClose: () => void; onError: (message: string) => void }) {
  const t = useT();
  const f = why.fixture;
  /** What the last reset answered (a warning when part of it could not go out), until its window ends. */
  const [status, setStatus] = useState<{ text: string; warn: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  // Escape closes the panel, like the ✕ (a modal open above it keeps its own Escape)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector("[role=dialog], dialog[open]")) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const running = why.reset?.secondsLeft;
  /** A voluntary reset: the built-in protection is lifted on this fixture's Reset channels, a few seconds. */
  const reset = (fixture: { id: string; name: string }) => {
    // the range sent, and the channel's other Reset ranges left alone: the user knows which reset goes out
    const ranges = (why.reset?.channels ?? []).map((c) => `${c.name}${t.colon} ${c.range}${c.others.length ? ` — ${t.resetOthers.replace("{list}", c.others.join(", "))}` : ""}`).join(", ");
    if (!confirm(t.resetFixtureConfirm.replace("{name}", quoted(t, fixture.name)).replace("{ranges}", ranges))) return;
    setBusy(true);
    void cmd<{ seconds: number; warning?: string }>("fixture.reset", { id: fixture.id, confirm: true })
      .then(
        (r) => {
          setStatus({ text: r.warning ?? t.resetFixtureDone.replace("{s}", String(r.seconds)), warn: Boolean(r.warning) });
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setStatus(null), r.seconds * 1000);
        },
        (e: Error) => onError(e.message),
      )
      .finally(() => setBusy(false));
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
            {f.head !== undefined && ` · ${f.accent ? t.headAccent : `${t.headZone} ${f.head + 1}`}`}
            {!f.definition && <span className="badge conflict"> {t.noDefinition}</span>}
          </li>
        ) : (
          <li className="hint">{t.whyNoFixture}</li>
        )}
        {why.wheel && (
          <li className="why-wheel">
            {t.whyWheelSlot} {why.wheel.slot} (<WheelColors hex={why.wheel.color} />)
            {why.wheel.asked && (
              <>
                {" · "}
                {t.whyWheelAsked} <WheelColors hex={why.wheel.asked} />
                {" · "}
                {t.whyWheelGap} {why.wheel.gap.toFixed(3).replace(".", t.decimalMark)}
              </>
            )}
          </li>
        )}
        {why.undosed && !why.wheel && <li className="why-undosed">{t.whyUndosed}</li>}
        {why.intensity && !why.wheel && !why.undosed && (
          <li>
            {t.whyIntensity}{t.colon} {t.grandMasterShort} {pct(why.intensity.grandMaster)}
            {why.intensity.dcas.map((d) => ` × ${d.name} ${pct(d.own)}`).join("")} = {pct(why.intensity.factor)}
          </li>
        )}
        {why.intensity?.dosesRaw && <li className="why-raw-dosed">{t.whyRawDosed}</li>}
        {why.faderDcas && (
          <li className="why-fader-dcas">
            {(why.faderDcas.dcas.length > 1 ? t.whyFaderDcasMany : t.whyFaderDcas) + t.colon} {why.faderDcas.dcas.map((d) => `${d.name} ${pct(d.own)}`).join(" × ")} = {pct(why.faderDcas.factor)}
          </li>
        )}
        {why.faders.map((x) => (
          <li key={x.id}>
            {/* its travel within its range: the first factor of the product shown */}
            {t.whyFader} {quoted(t, x.name)} {pct(x.travel)}
            {x.dcas.map((d) => ` × ${d.name} ${pct(d.own)}`).join("")}
            {x.grandMaster !== undefined ? ` × ${t.grandMasterShort} ${pct(x.grandMaster)}` : ""}
            {x.dcas.length || x.grandMaster !== undefined ? ` → ${pct(x.effective)}` : ""}
            {x.doses ? ` (${t.whyFaderDoses})` : ""}
          </li>
        ))}
        {why.paintingLooks?.length ? (
          <li>
            {t.whyPainting} {why.paintingLooks.map((l) => quoted(t, l.name) + (l.level !== undefined ? ` ${t.whyLookLevel.replace("{pct}", pct(l.level))}` : "")).join(", ")}
          </li>
        ) : null}
        {why.rawLooks.map((l) => (
          <li key={l.id}>
            {t.whyRawLook} {quoted(t, l.name)}
            {l.level !== undefined ? ` ${t.whyLookLevel.replace("{pct}", pct(l.level))}` : ""}
            {l.leaving ? ` (${t.whyLeaving})` : ""}
          </li>
        ))}
        {why.clamps.map((c, i) => (
          <li key={i} className="warn">
            {t.whyClamp.replace("{rule}", c.name ?? c.rule).replace("{from}", String(c.from)).replace("{to}", String(c.to))}
          </li>
        ))}
      </ul>
      {f && why.resettable && (
        <>
          <div className="row">
            <button className="danger" disabled={busy || status !== null || running !== undefined} onClick={() => reset(f)}>
              {t.resetFixture}
            </button>
            <span role="status" className={status?.warn ? "warn" : "hint"}>
              {status?.text ?? (running !== undefined ? t.resetFixtureRunning.replace("{s}", String(running)) : "")}
            </span>
          </div>
          <p className="hint">{t.resetFixtureHelp}</p>
        </>
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
  /** Stable: the panel's Escape listener is added once, not at every render. */
  const closeWhy = useCallback(() => setExplained(null), []);
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
    const name = names.get(ch);
    // a fixture running off the universe: its last channels are never sent, nothing to force
    if (ch > SLOTS)
      return (
        <div key={ch} className="ch unsent" title={`${name ? `${name.fixture} · ${name.channel} — ` : ""}${t.channelNotSent}`}>
          <span className="num">{ch}</span>
          <input type="range" min={0} max={255} value={0} disabled aria-label={`${ch} ${name ? `${name.fixture} ${name.channel} ` : ""}— ${t.channelNotSent}`} />
          <span className="val">—</span>
          <span className="unsent-note">{t.channelNotSentShort}</span>
          {name && <span className="lbl">{name.channel}</span>}
        </div>
      );
    const isParked = parked[ch] !== undefined;
    const v = values[ch - 1] ?? 0;
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
      {why && <WhyPanel key={`${why.universe}.${why.channel}`} why={why} onClose={closeWhy} onError={setError} />}
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
