import { useCallback, useEffect, useMemo, useState } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { useCommandEvents, useTopic } from "../hooks/useTopic";
import { XyPad } from "../components/XyPad";
import { LiveStage } from "../components/StagePlan";

type Kind = "look" | "group-fader" | "panic" | "blackout" | "tap" | "section" | "song-nav" | "label" | "stop-all" | "xy" | "preview" | "channel-fader";
interface Widget {
  id: string;
  kind: Kind;
  x: number;
  y: number;
  w: number;
  h: number;
  target?: string;
  label?: string;
  /** Look and Blackout buttons: trigger (always on), latch (on/off), momentary (on while pressed). */
  mode?: ButtonMode;
}
type ButtonMode = "trigger" | "latch" | "momentary";
interface Dashboard {
  id: string;
  name: string;
  columns: number;
  widgets: Widget[];
}
interface Look {
  id: string;
  name: string;
  active: boolean;
  danger: boolean;
  manualOnly: boolean;
  tags: string[];
}
interface Group {
  id: string;
  name: string;
  master?: { level: number; mute: boolean };
  limits?: { min?: number; max?: number; mode?: "clamp" | "scale" };
  effectiveLevel: number;
}
interface ChannelFader {
  id: string;
  name: string;
  level: number;
  channels: unknown[];
}
interface Tempo {
  bpm: number;
  source: string;
  clockMissing: boolean;
  beats: number;
}
interface SongState {
  song?: string;
  section?: string;
}

const KINDS: Kind[] = ["look", "group-fader", "section", "panic", "blackout", "tap", "stop-all", "song-nav", "label", "xy", "preview", "channel-fader"];
const SIZE: Partial<Record<Kind, { w: number; h: number }>> = { "group-fader": { w: 1, h: 4 }, "channel-fader": { w: 1, h: 4 }, xy: { w: 3, h: 4 }, preview: { w: 6, h: 4 } };

export function DashboardsPage() {
  const t = useT();
  const [dashboards, setDashboards] = useState<Dashboard[]>([]);
  const [current, setCurrent] = useState(0);
  const [looks, setLooks] = useState<Look[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [faders, setFaders] = useState<ChannelFader[]>([]);
  const [edit, setEdit] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const state = useTopic<{ blackout: boolean } | null>("light:state", null);
  const tempo = useTopic<Tempo | null>("light:tempo", null);
  const song = useTopic<SongState>("light:song", {});

  const refresh = useCallback(() => {
    void cmd<Look[]>("look.list").then(setLooks).catch(() => undefined);
    void cmd<Group[]>("group.list").then(setGroups).catch(() => undefined);
    void cmd<ChannelFader[]>("fader.list").then(setFaders).catch(() => undefined);
  }, []);
  useEffect(() => {
    refresh();
    void cmd<Dashboard[]>("dashboard.list").then(setDashboards).catch((e: Error) => setError(e.message));
  }, [refresh]);
  useCommandEvents(["look.", "group.", "fader.", "panic", "import.", "selftest.", "song.", "setlist."], refresh);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      const n = Number(e.key);
      if (n >= 1 && n <= 9 && n <= dashboards.length) setCurrent(n - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dashboards.length]);

  const run = (name: string, args: unknown = {}) => cmd(name, args).catch((e: Error) => setError(e.message));
  const dash = dashboards[current];
  const lookById = useMemo(() => new Map(looks.map((l) => [l.id, l])), [looks]);
  const groupById = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups]);

  const update = (fn: (d: Dashboard) => Dashboard) => setDashboards((ds) => ds.map((d, i) => (i === current ? fn(d) : d)));
  const updateWidget = (id: string, patch: Partial<Widget>) => update((d) => ({ ...d, widgets: d.widgets.map((w) => (w.id === id ? { ...w, ...patch } : w)) }));
  const save = () =>
    dash &&
    void cmd("dashboard.put", { dashboard: dash })
      .then(() => setEdit(false))
      .catch((e: Error) => setError(e.message));
  const addWidget = (kind: Kind) => {
    if (!dash) return;
    const y = dash.widgets.reduce((m, w) => Math.max(m, w.y + w.h), 0);
    const id = `${kind}-${Date.now().toString(36)}`;
    update((d) => ({ ...d, widgets: [...d.widgets, { id, kind, x: 0, y, ...(SIZE[kind] ?? { w: 2, h: 1 }) }] }));
    setSelected(id);
  };

  /**
   * Press behaviour of a look or Blackout button (docs/specs/ui-dashboards.md): « Déclencher »
   * always switches on, « Latch » toggles, « Momentané » is on while the button is held.
   */
  const press = (mode: ButtonMode, active: boolean, on: () => void, off: () => void) =>
    mode === "momentary"
      ? {
          onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
            if (edit) return;
            e.currentTarget.setPointerCapture?.(e.pointerId); // released outside the button: still released
            on();
          },
          onPointerUp: () => !edit && off(),
          onPointerCancel: () => !edit && off(),
          onKeyDown: (e: React.KeyboardEvent) => !edit && !e.repeat && (e.key === " " || e.key === "Enter") && on(),
          onKeyUp: (e: React.KeyboardEvent) => !edit && (e.key === " " || e.key === "Enter") && off(),
        }
      : { onClick: () => (mode === "latch" && active ? off() : on()) };

  const render = (w: Widget) => {
    switch (w.kind) {
      case "label":
        return <div className="w-label">{w.label ?? w.target}</div>;
      case "panic":
        return (
          <button className="panic fill" onClick={() => void run("panic")}>
            {t.panic}
          </button>
        );
      case "blackout":
        return (
          <button className={`fill blackout ${state?.blackout ? "on" : ""}`} title={t.modes[w.mode ?? "latch"]} {...press(w.mode ?? "latch", Boolean(state?.blackout), () => void run("blackout", { on: true }), () => void run("blackout", { on: false }))}>
            {state?.blackout ? t.blackoutOn : t.blackout}
          </button>
        );
      case "stop-all":
        return (
          <button className="fill" onClick={() => void run("look.stopall")}>
            ■ {t.looks}
          </button>
        );
      case "tap":
        return (
          <button className="fill tap" onClick={() => void run("tempo.tap")}>
            {t.tap} · {tempo ? tempo.bpm.toFixed(1) : "—"} <span className={`beat ${tempo && Math.floor(tempo.beats) % 2 === 0 ? "even" : ""}`} />
            {tempo?.clockMissing && <small className="warn"> ⚠</small>}
          </button>
        );
      case "song-nav":
        return (
          <div className="fill row">
            <button onClick={() => void run("song.prev")}>◀</button>
            <span className="grow">{song.song ? `${song.song} · ${song.section ?? ""}` : "—"}</span>
            <button onClick={() => void run("song.next")}>▶</button>
          </div>
        );
      case "section": {
        const [songId, sectionId] = (w.target ?? "").split(":");
        const on = song.song === songId && song.section === sectionId;
        return (
          <button className={`fill look ${on ? "on" : ""}`} onClick={() => void run("song.section.go", { song: songId, section: sectionId })}>
            {w.label ?? sectionId}
          </button>
        );
      }
      case "look": {
        const l = lookById.get(w.target ?? "");
        if (!l) return <div className="fill missing">{w.target}</div>;
        return (
          <button
            className={`fill look ${l.active ? "on" : ""} ${l.danger ? "danger" : ""}`}
            title={`${t.modes[w.mode ?? "latch"]} · ${l.tags.join(" · ")}`}
            {...press(
              w.mode ?? "latch",
              l.active,
              () => void run("look.go", { id: l.id }),
              () => void run("look.stop", { id: l.id }),
            )}
          >
            {l.manualOnly ? "✋ " : ""}
            {w.label ?? l.name}
            {w.mode && w.mode !== "latch" && <small className="mode-mark">{w.mode === "momentary" ? " ⇣" : " ▸"}</small>}
          </button>
        );
      }
      case "preview":
        return (
          <div className="fill preview-widget">
            <LiveStage onError={setError} />
          </div>
        );
      case "xy":
        return <XyPad group={w.target || undefined} label={w.label} onError={setError} />;
      case "channel-fader": {
        const f = faders.find((x) => x.id === w.target);
        if (!f) return <div className="fill missing">{w.target}</div>;
        return (
          <div className="fader fill channel">
            <div className="track">
              <input
                type="range"
                min={0}
                max={1000}
                aria-label={`${t.channelFader} ${f.name}`}
                value={Math.round(f.level * 1000)}
                onChange={(e) => {
                  const level = Number(e.target.value) / 1000;
                  setFaders((fs) => fs.map((x) => (x.id === f.id ? { ...x, level } : x)));
                  void run("fader.level", { id: f.id, level });
                }}
              />
            </div>
            <span className="value">{Math.round(f.level * 100)}%</span>
            <small className="limits">
              {f.channels.length} {t.channelsShort}
            </small>
            <label>{w.label ?? f.name}</label>
          </div>
        );
      }
      case "group-fader": {
        const g = groupById.get(w.target ?? "");
        if (!g) return <div className="fill missing">{w.target}</div>;
        // stop mode: the fader is shown where the DCA really is (on the mark when pushed past it)
        const shown = g.limits?.mode === "scale" ? (g.master?.level ?? 1) : Math.min(g.limits?.max ?? 1, Math.max(g.limits?.min ?? 0, g.master?.level ?? 1));
        return (
          <div className="fader fill">
            <div className="track">
            <input
              type="range"
              min={0}
              max={1000}
              aria-label={`DCA ${g.name}`}
              value={Math.round(shown * 1000)}
              onChange={(e) => {
                let level = Number(e.target.value) / 1000;
                // clamp mode: the fader stops at the DCA limits (position = level)
                if (g.limits?.mode !== "scale") level = Math.min(g.limits?.max ?? 1, Math.max(g.limits?.min ?? 0, level));
                setGroups((gs) => gs.map((x) => (x.id === g.id ? { ...x, master: { level, mute: x.master?.mute ?? false } } : x)));
                void run("group.level", { id: g.id, level });
              }}
            />
            {g.limits?.mode !== "scale" && g.limits?.max !== undefined && <span className="mark max" style={{ bottom: `${g.limits.max * 100}%` }} title={`max ${Math.round(g.limits.max * 100)} %`} />}
            {g.limits?.mode !== "scale" && g.limits?.min !== undefined && <span className="mark min" style={{ bottom: `${g.limits.min * 100}%` }} title={`min ${Math.round(g.limits.min * 100)} %`} />}
            </div>
            <span className="value">
              {Math.round(shown * 100)}%<small> ({Math.round(g.effectiveLevel * 100)}%)</small>
            </span>
            {g.limits && (g.limits.min !== undefined || g.limits.max !== undefined) && (
              <small className="limits">
                {Math.round((g.limits.min ?? 0) * 100)}–{Math.round((g.limits.max ?? 1) * 100)} %{g.limits.mode === "scale" ? " ↕" : ""}
              </small>
            )}
            <div className="row">
              <button className={g.master?.mute ? "mute on" : "mute"} onClick={() => void run("group.mute", { id: g.id, mute: !g.master?.mute })}>
                M
              </button>
              <button onPointerDown={() => void run("group.flash", { id: g.id, on: true })} onPointerUp={() => void run("group.flash", { id: g.id, on: false })}>
                F
              </button>
            </div>
            <label>{w.label ?? g.name}</label>
          </div>
        );
      }
    }
  };

  const sel = dash?.widgets.find((w) => w.id === selected);
  return (
    <div className="dashboards">
      <section className="bar">
        {dashboards.map((d, i) => (
          <button key={d.id} className={i === current ? "tab active" : "tab"} onClick={() => setCurrent(i)}>
            {i < 9 ? `${i + 1}. ` : ""}
            {d.name}
          </button>
        ))}
        <span className="grow" />
        {edit ? (
          <>
            <select value="" onChange={(e) => e.target.value && addWidget(e.target.value as Kind)}>
              <option value="">+ widget</option>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {t.widgetKinds[k]}
                </option>
              ))}
            </select>
            <button className="primary" onClick={save}>
              ✔
            </button>
            <button
              onClick={() => {
                setEdit(false);
                void cmd<Dashboard[]>("dashboard.list").then(setDashboards);
              }}
            >
              ✕
            </button>
          </>
        ) : (
          <button
            className="ghost"
            onClick={() => {
              refresh(); // the lists the editor offers (looks, groups, faders) are read afresh
              setEdit(true);
            }}
          >
            ✎
          </button>
        )}
        {error && (
          <span className="error" onClick={() => setError("")}>
            {error}
          </span>
        )}
      </section>

      {edit && sel && (
        <section className="editor">
          <select value={sel.target ?? ""} onChange={(e) => updateWidget(sel.id, { target: e.target.value })}>
            <option value="">—</option>
            {sel.kind === "look" && looks.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            {sel.kind === "channel-fader" && faders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            {(sel.kind === "group-fader" || sel.kind === "xy") && groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
          <input placeholder="label" value={sel.label ?? ""} onChange={(e) => updateWidget(sel.id, { label: e.target.value || undefined })} />
          {(sel.kind === "look" || sel.kind === "blackout") && (
            <select aria-label={t.mode} value={sel.mode ?? "latch"} onChange={(e) => updateWidget(sel.id, { mode: e.target.value as ButtonMode })}>
              {(["latch", "momentary", "trigger"] as const).map((m) => (
                <option key={m} value={m}>
                  {t.modes[m]}
                </option>
              ))}
            </select>
          )}
          <button onClick={() => updateWidget(sel.id, { x: Math.max(0, sel.x - 1) })}>←</button>
          <button onClick={() => updateWidget(sel.id, { x: Math.min((dash?.columns ?? 12) - sel.w, sel.x + 1) })}>→</button>
          <button onClick={() => updateWidget(sel.id, { y: Math.max(0, sel.y - 1) })}>↑</button>
          <button onClick={() => updateWidget(sel.id, { y: sel.y + 1 })}>↓</button>
          <button onClick={() => updateWidget(sel.id, { w: Math.max(1, sel.w - 1) })}>⇠</button>
          <button onClick={() => updateWidget(sel.id, { w: Math.min(dash?.columns ?? 12, sel.w + 1) })}>⇢</button>
          <button onClick={() => updateWidget(sel.id, { h: Math.max(1, sel.h - 1) })}>⇡</button>
          <button onClick={() => updateWidget(sel.id, { h: sel.h + 1 })}>⇣</button>
          <button
            className="danger"
            onClick={() => {
              update((d) => ({ ...d, widgets: d.widgets.filter((w) => w.id !== sel.id) }));
              setSelected(null);
            }}
          >
            ✕
          </button>
        </section>
      )}

      {dash && (
        <div className="dgrid" style={{ gridTemplateColumns: `repeat(${dash.columns}, minmax(0, 1fr))` }}>
          {dash.widgets.map((w) => (
            <div
              key={w.id}
              className={`cell ${edit ? "editing" : ""} ${selected === w.id ? "selected" : ""}`}
              style={{ gridColumn: `${w.x + 1} / span ${w.w}`, gridRow: `${w.y + 1} / span ${w.h}` }}
              onClickCapture={(e) => {
                if (!edit) return;
                e.stopPropagation();
                e.preventDefault();
                setSelected(w.id);
              }}
            >
              {render(w)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
