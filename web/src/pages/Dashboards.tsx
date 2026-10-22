import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, lazy, Suspense } from "react";
import { ApiError, can, cmd, type Role } from "../api";
import { useT } from "../App";
import { useCommandEvents, useTopic } from "../hooks/useTopic";
import { XyPad } from "../components/XyPad";
import { LiveStage } from "../components/StagePlan";
import { WidgetMenu } from "../components/WidgetMenu";
import { Modal } from "../components/Modal";
import type { LookDraft } from "../components/LookEditor";
// the editor only when a look is opened from the Live: the Live page stays light to load
const LookEditor = lazy(() => import("../components/LookEditor").then((m) => ({ default: m.LookEditor })));
import { GettingStarted } from "../components/GettingStarted";
import { RecentlyDeleted, Versions } from "../components/Versions";
import { isHex, SWATCHES, textOn } from "../color";
import { pick } from "../selection";
import { microphone } from "../audio/microphone";

type Kind = "look" | "group-fader" | "panic" | "blackout" | "tap" | "section" | "song-nav" | "label" | "stop-all" | "xy" | "preview" | "channel-fader" | "snapshot" | "grand-master";
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
  /** "#rrggbb", or "auto" (a look button takes its look's colour); absent = neutral. */
  color?: string;
  /** Two presses to switch on (look, Blackout, snapshot). */
  confirm?: boolean;
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
  /** The colour that sums the look up (look.list), for « auto » buttons. */
  swatch?: string;
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
  /** MIDI clock ticks arrive (Ableton plays), followed or not. */
  clock?: boolean;
}
interface SongState {
  song?: string;
  section?: string;
}

/** A grid cell is split in quarters, so a widget can sit between the lines of the magnetic grid. */
const SUB = 4;
/** How long an « À confirmer » button waits for its second press. */
const CONFIRM_MS = 3000;
type Handle = "move" | "nw" | "ne" | "sw" | "se";
const CORNERS: Handle[] = ["nw", "ne", "sw", "se"];

/** A widget dropped onto others pushes them down (in cascade), as in a classic dashboard editor. */
function settle<T extends { id: string; x: number; y: number; w: number; h: number }>(widgets: T[], movedId: string): T[] {
  const ws = widgets.map((w) => ({ ...w }));
  const overlap = (a: T, b: T) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const queue = [movedId];
  for (let guard = 0; queue.length && guard < 1000; guard++) {
    const id = queue.shift();
    const a = ws.find((w) => w.id === id);
    if (!a) continue;
    for (const b of ws) {
      if (b.id !== a.id && overlap(a, b)) {
        b.y = a.y + a.h;
        queue.push(b.id);
      }
    }
  }
  return ws;
}

const KINDS: Kind[] = ["look", "group-fader", "grand-master", "section", "snapshot", "panic", "blackout", "tap", "stop-all", "song-nav", "label", "xy", "preview", "channel-fader"];
/** What a palette chip drops: a kind of widget, possibly already bound (a look, a snapshot). */
const DRAG_TYPE = "application/x-light-widget";
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const SIZE: Partial<Record<Kind, { w: number; h: number }>> = { "group-fader": { w: 1, h: 4 }, "grand-master": { w: 1, h: 4 }, "channel-fader": { w: 1, h: 4 }, xy: { w: 3, h: 4 }, preview: { w: 6, h: 4 } };

export function DashboardsPage({ role }: { role: Role }) {
  const t = useT();
  /** A control whose command the role may not run is shown, greyed, rather than refused on use. */
  const may = (right: string) => can(role, right);
  const locked = (right: string) => (may(right) ? {} : { disabled: true, title: t.noRight });
  // A phone gets 4 columns and the widgets in reading order (a 12-column layout would crush them).
  const [narrow, setNarrow] = useState(() => window.matchMedia?.("(max-width: 600px)").matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.("(max-width: 600px)");
    if (!mq) return;
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const editor = may("show:write");
  /** The dashboards this role sees (role.dashboards), all when it names none. */
  const mine = (list: Dashboard[]) => (role.dashboards?.length ? list.filter((d) => role.dashboards!.includes(d.id)) : list);
  const [dashboards, setDashboards] = useState<Dashboard[]>([]);
  const [current, setCurrent] = useState(0);
  const [looks, setLooks] = useState<Look[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [faders, setFaders] = useState<ChannelFader[]>([]);
  const [snapshots, setSnapshots] = useState<{ id: string; name: string }[]>([]);
  const [edit, setEdit] = useState(false);
  const [paletteSearch, setPaletteSearch] = useState("");
  // Full screen to play: no side bar, no top bar, only the dashboards.
  const [kiosk, setKiosk] = useState(false);
  /** The show on the stage plan above the buttons, as it goes out (rehearsing without the kit): remembered by this browser. */
  const [stageShown, setStageShown] = useState<boolean>(() => {
    try {
      return localStorage.getItem("liveStage") === "1";
    } catch {
      return false;
    }
  });
  const toggleStage = () => {
    setStageShown(!stageShown);
    try {
      localStorage.setItem("liveStage", stageShown ? "0" : "1");
    } catch {
      /* per-browser comfort only */
    }
  };
  useEffect(() => {
    document.body.classList.toggle("kiosk", kiosk);
    const out = () => !document.fullscreenElement && setKiosk(false);
    document.addEventListener("fullscreenchange", out);
    return () => {
      document.removeEventListener("fullscreenchange", out);
      document.body.classList.remove("kiosk");
    };
  }, [kiosk]);
  // a tablet left on the Live must not fall asleep mid-service: full screen keeps the screen awake
  // (Screen Wake Lock, where the browser allows it: HTTPS or localhost)
  useEffect(() => {
    if (!kiosk) return;
    type Sentinel = { release(): Promise<void> };
    const nav = navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<Sentinel> } };
    let lock: Sentinel | undefined;
    let stop = false;
    const take = () => {
      if (stop || document.visibilityState !== "visible" || !nav.wakeLock) return;
      void nav.wakeLock.request("screen").then(
        (l) => (stop ? void l.release() : (lock = l)),
        () => undefined,
      );
    };
    take();
    document.addEventListener("visibilitychange", take); // the browser drops the lock when the page hides: taken again on return
    return () => {
      stop = true;
      document.removeEventListener("visibilitychange", take);
      void lock?.release().catch(() => undefined);
    };
  }, [kiosk]);
  const toggleKiosk = () => {
    if (kiosk) {
      if (document.fullscreenElement) void document.exitFullscreen?.();
      setKiosk(false);
    } else {
      void document.documentElement.requestFullscreen?.().catch(() => undefined);
      setKiosk(true);
    }
  };
  /** Layout undo / redo while editing (⌘Z, ⇧⌘Z); a whole drag is one step. */
  const past = useRef<Dashboard[]>([]);
  const future = useRef<Dashboard[]>([]);
  const dragging = useRef(false);
  /** The widgets selected while editing: one gets the full panel, several the panel for all of them. */
  const [selection, setSelection] = useState<string[]>([]);
  const selected = selection.length === 1 ? selection[0]! : null;
  const setSelected = (id: string | null) => setSelection(id ? [id] : []);
  /** The last widget clicked: the corner a Shift+click frames from. */
  const anchor = useRef<string | undefined>(undefined);
  /** A tablet has no Ctrl nor Shift: each tap adds (add) or frames from the last one (frame). */
  const [touchPick, setTouchPick] = useState<"add" | "frame" | null>(null);
  /** The widget whose right-click menu is open, and where. */
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  /** A look opened for editing from its button's menu, over the dashboard. */
  const [editingLook, setEditingLook] = useState<LookDraft | null>(null);
  /**
   * A finger has no right button: a long press opens the same menu on a tablet. Not on what one
   * holds or drags anyway (momentary buttons, faders, the XY pad); the click that ends it is eaten.
   */
  const press$ = useRef<{ timer: number; x: number; y: number; fired: boolean } | null>(null);
  const LONG_PRESS_MS = 600;

  // ---- layout editing: drag to move, corners to resize, on a grid of quarter cells
  /** Magnetic grid: moves and sizes go by whole cells; off, by quarters. Remembered by this browser. */
  const [snap, setSnap] = useState<boolean>(() => {
    try {
      return localStorage.getItem("dashboardSnap") !== "0";
    } catch {
      return true;
    }
  });
  const toggleSnap = () => {
    setSnap(!snap);
    try {
      localStorage.setItem("dashboardSnap", snap ? "0" : "1");
    } catch {
      /* per-browser comfort only */
    }
  };
  const step = snap ? 1 : 1 / SUB;
  const gridRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; mode: Handle; x0: number; y0: number; w0: number; h0: number; px: number; py: number; cw: number; rh: number } | null>(null);
  const startDrag = (e: React.PointerEvent, w: Widget, mode: Handle) => {
    const grid = gridRef.current;
    if (!edit || !grid || !dash || e.button !== 0) return;
    if (mode === "move" && (e.shiftKey || e.metaKey || e.ctrlKey || touchPick)) return; // a selecting click, not a move
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const cw = grid.getBoundingClientRect().width / dash.columns;
    const rh = Number.parseFloat(getComputedStyle(grid).gridAutoRows) * SUB;
    drag.current = { id: w.id, mode, x0: w.x, y0: w.y, w0: w.w, h0: w.h, px: e.clientX, py: e.clientY, cw, rh };
    remember();
    dragging.current = true;
    setSelected(w.id);
  };
  const moveDrag = (e: React.PointerEvent) => {
    const g = drag.current;
    if (!g || !dash) return;
    const q = (v: number) => Math.round(v / step) * step;
    const dx = (e.clientX - g.px) / g.cw;
    const dy = (e.clientY - g.py) / g.rh;
    let { x0: x, y0: y, w0: w, h0: h } = g;
    if (g.mode === "move") {
      x = q(g.x0 + dx);
      y = q(g.y0 + dy);
    } else {
      if (g.mode.includes("e")) w = q(g.w0 + dx);
      if (g.mode.includes("s")) h = q(g.h0 + dy);
      if (g.mode.includes("w")) {
        x = Math.min(q(g.x0 + dx), g.x0 + g.w0 - step);
        w = g.w0 + g.x0 - x;
      }
      if (g.mode.includes("n")) {
        y = Math.min(q(g.y0 + dy), g.y0 + g.h0 - step);
        h = g.h0 + g.y0 - y;
      }
    }
    w = Math.max(step, Math.min(w, dash.columns));
    h = Math.max(step, h);
    x = Math.max(0, Math.min(x, dash.columns - w));
    y = Math.max(0, y);
    const cur = dash.widgets.find((c) => c.id === g.id);
    if (cur && (cur.x !== x || cur.y !== y || cur.w !== w || cur.h !== h)) updateWidget(g.id, { x, y, w, h });
  };
  const endDrag = () => {
    const g = drag.current;
    drag.current = null;
    if (g) update((d) => ({ ...d, widgets: settle(d.widgets, g.id) }));
    dragging.current = false;
  };
  const holdable = (w: Widget) => (w.kind === "look" || w.kind === "blackout" ? (w.mode ?? "latch") !== "momentary" : ["section", "label", "stop-all", "tap", "song-nav", "snapshot"].includes(w.kind));
  const [error, setError] = useState("");
  const state = useTopic<{ blackout: boolean; panicUndo?: boolean; grandMaster?: number } | null>("light:state", null);
  // the grand master as dragged, until the server says it (a fader must not jump back mid-gesture)
  const [gm, setGm] = useState<number | null>(null);
  useEffect(() => setGm(null), [state?.grandMaster]);
  const tempo = useTopic<Tempo | null>("light:tempo", null);
  const mic = useSyncExternalStore(microphone.subscribe, () => microphone.state);
  // the tempo heard in the room: followed while the microphone is on, a manual tempo again after
  const toggleMic = () => {
    if (!mic.on) void microphone.start(({ bpm, beatAgoMs }) => void run("tempo.set", { bpm, source: "audio", ...(beatAgoMs !== undefined ? { beatAgoMs } : {}) }));
    else {
      microphone.stop();
      if (tempo?.source === "audio") void run("tempo.set", { source: "manual" });
    }
  };
  // the tempo typed by hand: the field keeps what is typed while it has the focus (the live tempo
  // would overwrite it), then sets it — a manual tempo, the microphone off
  const [bpmDraft, setBpmDraft] = useState<{ id: string; value: string; typed: boolean } | null>(null);
  const bpmCancelled = useRef(false);
  const setBpmByHand = (value: string) => {
    const typed = bpmDraft?.typed && !bpmCancelled.current;
    bpmCancelled.current = false;
    setBpmDraft(null);
    const bpm = Number(value.replace(",", "."));
    if (!typed || !(bpm >= 20 && bpm <= 400)) return; // left untouched, or Escape: nothing sent
    if (mic.on) microphone.stop();
    void run("tempo.set", { bpm: Math.round(bpm * 10) / 10, source: "manual" });
  };
  const song = useTopic<SongState>("light:song", {});

  const refresh = useCallback(() => {
    void cmd<Look[]>("look.list", { brief: true }).then(setLooks).catch(() => undefined);
    void cmd<Group[]>("group.list").then(setGroups).catch(() => undefined);
    void cmd<ChannelFader[]>("fader.list").then(setFaders).catch(() => undefined);
    void cmd<{ id: string; name: string }[]>("snapshot.list").then(setSnapshots).catch(() => undefined);
  }, []);
  useEffect(() => {
    refresh();
    void cmd<Dashboard[]>("dashboard.list").then((l) => setDashboards(mine(l))).catch((e: Error) => setError(e.message));
  }, [refresh]);
  useCommandEvents(["look.", "group.", "fader.", "panic", "import.", "selftest.", "song.", "setlist.", "snapshot.", "show.autopresets"], refresh);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (edit && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (edit && e.key === "Escape") {
        setSelection([]);
        setTouchPick(null);
        return;
      }
      const n = Number(e.key);
      if (n >= 1 && n <= 9 && n <= dashboards.length) setCurrent(n - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // a rule may ask before a look is launched (onViolation: confirm): the question, then again with the yes
  const run = (name: string, args: unknown = {}): Promise<unknown> =>
    cmd(name, args).catch((e: ApiError | Error) => {
      if (e instanceof ApiError && e.detail?.confirm && confirm(e.message)) return run(name, { ...(args as object), confirm: true });
      setError(e.message);
    });
  const dash = dashboards[current];
  const lookById = useMemo(() => new Map(looks.map((l) => [l.id, l])), [looks]);
  const groupById = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups]);

  /** Keeps the layout as it is, before a change (undo); a drag remembers once, at its start. */
  const remember = () => {
    if (!dash) return;
    past.current.push(clone(dash));
    if (past.current.length > 100) past.current.shift();
    future.current = [];
  };
  const replaceCurrent = (next: Dashboard) => setDashboards((ds) => ds.map((d, i) => (i === current ? next : d)));
  const undo = () => {
    const prev = past.current.pop();
    if (!prev || !dash) return;
    future.current.push(clone(dash));
    replaceCurrent(prev);
  };
  const redo = () => {
    const next = future.current.pop();
    if (!next || !dash) return;
    past.current.push(clone(dash));
    replaceCurrent(next);
  };
  const update = (fn: (d: Dashboard) => Dashboard) => {
    if (edit && !dragging.current) remember();
    setDashboards((ds) => ds.map((d, i) => (i === current ? fn(d) : d)));
  };
  const updateWidget = (id: string, patch: Partial<Widget>) => update((d) => ({ ...d, widgets: d.widgets.map((w) => (w.id === id ? { ...w, ...patch } : w)) }));
  /** A change from the right-click menu: applied and saved at once (no edit mode needed). */
  const persist = (fn: (d: Dashboard) => Dashboard) => {
    if (!dash) return;
    const next = fn(dash);
    setDashboards((ds) => ds.map((d, i) => (i === current ? next : d)));
    void cmd("dashboard.put", { dashboard: next }).catch((e: Error) => setError(e.message));
  };
  const save = () =>
    dash &&
    void cmd("dashboard.put", { dashboard: dash })
      .then(() => {
        setEdit(false);
        setSelected(null);
        past.current = [];
        future.current = [];
      })
      .catch((e: Error) => setError(e.message));
  /** A new widget: where it is dropped (what is under it goes down), or under the others. */
  const addWidget = (kind: Kind, at?: { x: number; y: number }, target?: string) => {
    if (!dash) return;
    const size = SIZE[kind] ?? { w: 2, h: 1 };
    const y = at?.y ?? dash.widgets.reduce((m, w) => Math.max(m, w.y + w.h), 0);
    const x = Math.max(0, Math.min(at?.x ?? 0, dash.columns - size.w));
    const id = `${kind}-${Date.now().toString(36)}`;
    update((d) => ({ ...d, widgets: settle([...d.widgets, { id, kind, x, y, ...size, ...(target ? { target } : {}) }], id) }));
    setSelected(id);
  };
  /** The grid cell under a drop, snapped. */
  const dropAt = (e: React.DragEvent) => {
    const grid = gridRef.current!;
    const r = grid.getBoundingClientRect();
    const cw = r.width / (dash?.columns ?? 12);
    const rh = Number.parseFloat(getComputedStyle(grid).gridAutoRows) * SUB;
    const q = (v: number) => Math.max(0, Math.floor(v / step) * step);
    return { x: q((e.clientX - r.left) / cw), y: q((e.clientY - r.top) / rh) };
  };
  // ---- dashboards themselves: the current one is saved first, then the action applies
  const reloadDashboards = async (select?: string) => {
    const list = mine(await cmd<Dashboard[]>("dashboard.list"));
    setDashboards(list);
    const i = select ? list.findIndex((d) => d.id === select) : 0;
    setCurrent(Math.max(0, i));
    past.current = [];
    future.current = [];
  };
  const freeId = (base: string) => {
    let id = base;
    for (let i = 2; dashboards.some((d) => d.id === id); i++) id = `${base}-${i}`;
    return id;
  };
  const manage = async (action: "new" | "duplicate" | "generate" | "delete") => {
    if (!dash) return;
    try {
      await cmd("dashboard.put", { dashboard: dash });
      if (action === "delete") {
        if (dashboards.length < 2 || !confirm(`${t.deleteDashboardConfirm} « ${dash.name} »`)) return;
        await cmd("dashboard.delete", { id: dash.id });
        return await reloadDashboards();
      }
      const id = freeId(action === "duplicate" ? `${dash.id}-copie` : action === "generate" ? "genere" : "dashboard");
      if (action === "new") await cmd("dashboard.put", { dashboard: { id, name: t.newDashboardName, columns: 12, widgets: [] } });
      if (action === "duplicate") await cmd("dashboard.put", { dashboard: { ...clone(dash), id, name: `${dash.name} (${t.copySuffix})` } });
      if (action === "generate") await cmd("dashboard.generate", { id, name: t.generatedDashboardName });
      await reloadDashboards(id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /**
   * Press behaviour of a look or Blackout button (docs/specs/ui-dashboards.md): « Déclencher »
   * always switches on, « Latch » toggles, « Momentané » is on while the button is held.
   */
  // « À confirmer » buttons: the first press arms the button for a few seconds, the second fires.
  // Only switching on asks: stopping a look or leaving a Blackout is never delayed.
  const [armed, setArmed] = useState<string | null>(null);
  const armTimer = useRef(0);
  const confirmed = (id: string | undefined, fire: () => void) => {
    window.clearTimeout(armTimer.current);
    if (!id || armed === id) {
      setArmed(null);
      fire();
      return;
    }
    setArmed(id);
    armTimer.current = window.setTimeout(() => setArmed(null), CONFIRM_MS);
  };
  const armedMark = (w: Widget) => armed === w.id && <small className="armed-mark">{t.pressAgain}</small>;
  const press = (mode: ButtonMode, active: boolean, on: () => void, off: () => void, confirm?: string) =>
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
      : { onClick: () => (mode === "latch" && active ? off() : confirmed(confirm, on)) };

  const render = (w: Widget) => {
    switch (w.kind) {
      case "label":
        return <div className="w-label">{w.label ?? w.target}</div>;
      case "panic":
        return (
          <div className="panic-cell">
            <button className="panic fill" {...locked("commands:panic")} onClick={() => void run("panic")}>
              {t.panic}
            </button>
            {/* a Panic pressed by mistake: what played just before comes back, for a minute */}
            {state?.panicUndo && (
              <button className="panic-undo" title={t.panicUndoHelp} {...locked("commands:panic")} onClick={() => void run("panic.undo")}>
                ↶ {t.panicUndo}
              </button>
            )}
          </div>
        );
      case "blackout":
        return (
          <button
            className={`fill blackout ${state?.blackout ? "on" : ""} ${armed === w.id ? "armed" : ""}`}
            title={t.modes[w.mode ?? "latch"]}
            {...locked("commands:blackout")}
            {...press(w.mode ?? "latch", Boolean(state?.blackout), () => void run("blackout", { on: true }), () => void run("blackout", { on: false }), w.confirm ? w.id : undefined)}
          >
            {state?.blackout ? t.blackoutOn : t.blackout}
            {armedMark(w)}
          </button>
        );
      case "stop-all":
        return (
          <button className="fill" {...locked("commands:trigger")} onClick={() => void run("look.stopall")}>
            ■ {t.looks}
          </button>
        );
      case "tap":
        return (
          <div className="fill tap-cell">
            <button className="fill tap" {...locked("commands:tempo")} onClick={() => void run("tempo.tap")}>
              {t.tap} <span className={`beat ${tempo && Math.floor(tempo.beats) % 2 === 0 ? "even" : ""}`} />
              {tempo?.clockMissing && <small className="warn"> ⚠</small>}
            </button>
            <input
              className="bpm"
              inputMode="decimal"
              aria-label={t.bpmByHand}
              title={`${t.bpmByHandHelp} (${t.tempoSourceNames[(tempo?.source ?? "manual") as keyof typeof t.tempoSourceNames] ?? tempo?.source})`}
              {...locked("commands:tempo")}
              value={bpmDraft?.id === w.id ? bpmDraft.value : tempo ? tempo.bpm.toFixed(1) : ""}
              onFocus={(e) => (setBpmDraft({ id: w.id, value: tempo ? tempo.bpm.toFixed(1) : "", typed: false }), e.target.select())}
              onChange={(e) => setBpmDraft({ id: w.id, value: e.target.value, typed: true })}
              onBlur={(e) => setBpmByHand(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") ((bpmCancelled.current = true), e.currentTarget.blur());
              }}
            />
            {/* Ableton plays but its clock is not followed (a tempo typed or tapped, the DJ): one press gives it the lead back */}
            {tempo && tempo.source !== "midi" && tempo.clock && (
              <button
                className="to-midi"
                {...locked("commands:tempo")}
                title={t.backToMidiHelp}
                aria-label={t.backToMidiHelp}
                onClick={() => {
                  if (mic.on) microphone.stop();
                  void run("tempo.set", { source: "midi" });
                }}
              >
                ↺<span className="word"> MIDI</span>
              </button>
            )}
            <button
              className={`mic ${mic.on ? (mic.following ? "on following" : "on") : ""}`}
              {...locked("commands:tempo")}
              aria-pressed={mic.on}
              aria-label={t.micListen}
              title={mic.on ? (mic.reading ? `${t.micHeard} ≈ ${mic.reading.bpm} BPM${mic.following ? "" : ` (${t.micUnsure})`}` : t.micListening) : mic.error ? t.micErrors[mic.error] : t.micHelp}
              onClick={toggleMic}
            >
              🎤{mic.on && mic.reading && <small> {Math.round(mic.reading.bpm)}</small>}
              {!mic.on && mic.error && <small className="warn"> ⚠</small>}
            </button>
          </div>
        );
      case "song-nav":
        return (
          <div className="fill row">
            <button {...locked("commands:trigger")} onClick={() => void run("song.prev")}>◀</button>
            <span className="grow">{song.song ? `${song.song} · ${song.section ?? ""}` : "—"}</span>
            <button {...locked("commands:trigger")} onClick={() => void run("song.next")}>▶</button>
          </div>
        );
      case "section": {
        const [songId, sectionId] = (w.target ?? "").split(":");
        const on = song.song === songId && song.section === sectionId;
        return (
          <button className={`fill look ${on ? "on" : ""}`} {...locked("commands:trigger")} onClick={() => void run("song.section.go", { song: songId, section: sectionId })}>
            {w.label ?? sectionId}
          </button>
        );
      }
      case "look": {
        const l = lookById.get(w.target ?? "");
        if (!l) return <div className="fill missing">{w.target}</div>;
        return (
          <button
            className={`fill look ${l.active ? "on" : ""} ${l.danger ? "danger" : ""} ${armed === w.id ? "armed" : ""}`}
            title={[w.label ?? l.name, t.modes[w.mode ?? "latch"], ...l.tags].join(" · ") /* the whole name: a long one is cut on the button */}
            {...locked("commands:trigger")}
            {...press(
              w.mode ?? "latch",
              l.active,
              () => void run("look.go", { id: l.id }),
              () => void run("look.stop", { id: l.id }),
              w.confirm ? w.id : undefined,
            )}
          >
            {l.manualOnly ? "✋ " : ""}
            {w.label ?? l.name}
            {w.mode && w.mode !== "latch" && <small className="mode-mark">{w.mode === "momentary" ? " ⇣" : " ▸"}</small>}
            {armedMark(w)}
          </button>
        );
      }
      case "snapshot": {
        const snap = snapshots.find((x) => x.id === w.target);
        if (!snap) return <div className="fill missing">{w.target}</div>;
        return (
          <button className={`fill snapshot ${armed === w.id ? "armed" : ""}`} title={t.snapshotButtonHelp} {...locked("commands:snapshot")} onClick={() => confirmed(w.confirm ? w.id : undefined, () => void run("snapshot.recall", { id: snap.id }))}>
            ◉ {w.label ?? snap.name}
            {armedMark(w)}
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
        return <XyPad group={w.target || undefined} label={w.label} onError={setError} disabled={!may("commands:position")} />;
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
                disabled={!may("commands:level")}
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
      case "grand-master": {
        const level = gm ?? state?.grandMaster ?? 1;
        return (
          <div className="fader fill grand-master">
            <div className="track">
              <input
                type="range"
                min={0}
                max={1000}
                aria-label={t.widgetKinds["grand-master"]}
                disabled={!may("commands:level")}
                value={Math.round(level * 1000)}
                onChange={(e) => {
                  const v = Number(e.target.value) / 1000;
                  setGm(v);
                  void run("grandmaster.set", { level: v });
                }}
              />
            </div>
            <span className="value">{Math.round(level * 100)}%</span>
            <label>{w.label ?? t.widgetKinds["grand-master"]}</label>
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
              disabled={!may("commands:level")}
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
              <button className={g.master?.mute ? "mute on" : "mute"} title={t.muteHelp} aria-label={`${t.muteHelp} ${w.label ?? g.name}`} {...locked("commands:level")} onClick={() => void run("group.mute", { id: g.id, mute: !g.master?.mute })}>
                M
              </button>
              <button title={t.flashHelp} aria-label={`${t.flashHelp} ${w.label ?? g.name}`} {...locked("commands:trigger")} onPointerDown={() => void run("group.flash", { id: g.id, on: true })} onPointerUp={() => void run("group.flash", { id: g.id, on: false })}>
                F
              </button>
            </div>
            <label>{w.label ?? g.name}</label>
          </div>
        );
      }
    }
  };

  /** The colour a widget shows: its own, or its look's for « auto ». */
  const colorOf = (w: Widget): string | undefined => (w.color === "auto" ? lookById.get(w.target ?? "")?.swatch : isHex(w.color) ? w.color : undefined);
  const tint = (w: Widget) => {
    const c = colorOf(w);
    return c ? { className: " tinted", style: { "--wc": c, "--wc-text": textOn(c) } as React.CSSProperties } : { className: "", style: {} };
  };
  const sel = dash?.widgets.find((w) => w.id === selected);
  // several selected: what they share is set for all of them at once (one step to undo)
  const many = selection.length > 1 ? (dash?.widgets.filter((w) => selection.includes(w.id)) ?? []) : [];
  const patchMany = (fn: (w: Widget) => Partial<Widget> | undefined) => update((d) => ({ ...d, widgets: d.widgets.map((w) => (selection.includes(w.id) ? { ...w, ...fn(w) } : w)) }));
  const pressable = (w: Widget) => w.kind === "look" || w.kind === "blackout";
  /** A held button is already deliberate: no second press for momentary ones. */
  const confirmable = (w: Widget) => (pressable(w) && w.mode !== "momentary") || w.kind === "snapshot";
  const shared = <K extends keyof Widget>(k: K, ws: Widget[], fallback?: Widget[K]) => (new Set(ws.map((w) => w[k] ?? fallback)).size === 1 ? (ws[0]![k] ?? fallback) : undefined);
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
            <button title={`${t.undo} (⌘Z)`} aria-label={t.undo} disabled={!past.current.length} onClick={undo}>
              ↶
            </button>
            <button title={`${t.redo} (⇧⌘Z)`} aria-label={t.redo} disabled={!future.current.length} onClick={redo}>
              ↷
            </button>
            <button className={touchPick === "add" ? "toggle on" : "toggle"} aria-pressed={touchPick === "add"} title={t.pickAddHelp} onClick={() => setTouchPick(touchPick === "add" ? null : "add")}>
              {t.pickAdd}
            </button>
            <button className={touchPick === "frame" ? "toggle on" : "toggle"} aria-pressed={touchPick === "frame"} title={t.pickFrameHelp} onClick={() => setTouchPick(touchPick === "frame" ? null : "frame")}>
              {t.pickFrame}
            </button>
            <button className={snap ? "toggle on" : "toggle"} aria-pressed={snap} title={t.snapHelp} onClick={toggleSnap}>
              {t.snapGrid}
            </button>
            <label className="inline" title={t.columnsHelp}>
              {t.columns}
              <input
                type="number"
                min={4}
                max={64}
                value={dash?.columns ?? 12}
                onChange={(e) => {
                  const columns = Math.max(4, Math.min(64, Number(e.target.value) || 12));
                  update((d) => ({ ...d, columns }));
                }}
              />
            </label>
            <button
              title={t.autoColorsHelp}
              onClick={() => update((d) => ({ ...d, widgets: d.widgets.map((w) => (w.kind === "look" && !w.color ? { ...w, color: "auto" } : w)) }))}
            >
              {t.autoColors}
            </button>
            <button className="primary" onClick={save}>
              ✔
            </button>
            <button
              onClick={() => {
                setEdit(false);
                setSelected(null);
                past.current = [];
                future.current = [];
                void cmd<Dashboard[]>("dashboard.list").then((l) => setDashboards(mine(l)));
              }}
            >
              ✕
            </button>
          </>
        ) : (
          <>
            <button className={stageShown ? "ghost on" : "ghost"} title={t.liveStageHelp} aria-pressed={stageShown} onClick={toggleStage}>
              {t.liveStageToggle}
            </button>
            <button className="ghost" title={t.fullScreenHelp} aria-label={t.fullScreen} aria-pressed={kiosk} onClick={toggleKiosk}>
              {kiosk ? "⤡" : "⛶"}
            </button>
            {editor && (
              <button
                className="ghost"
                title={t.editLayoutHelp}
                onClick={() => {
                  refresh(); // the lists the editor offers (looks, groups, faders) are read afresh
                  setEdit(true);
                }}
              >
                ✎
              </button>
            )}
          </>
        )}
        {error && (
          <span className="error" onClick={() => setError("")}>
            {error}
          </span>
        )}
      </section>

      {edit && dash && (
        <section className="dash-manage">
          <label className="inline">
            {t.dashboardName}
            <input aria-label={t.dashboardName} value={dash.name} onChange={(e) => update((d) => ({ ...d, name: e.target.value }))} />
          </label>
          <button onClick={() => void manage("new")}>+ {t.newDashboard}</button>
          <button onClick={() => void manage("duplicate")}>{t.duplicate}</button>
          <button title={t.generateDashboardHelp} onClick={() => void manage("generate")}>
            {t.generateDashboard}
          </button>
          <button className="ghost" disabled={dashboards.length < 2} onClick={() => void manage("delete")}>
            {t.delete}
          </button>
          <div className="dash-history">
            <Versions key={dash.id} collection="dashboards" id={dash.id} onRestored={() => void reloadDashboards(dash.id)} />
            <RecentlyDeleted collections={["dashboards"]} onRestored={() => void reloadDashboards(dash.id)} />
          </div>
        </section>
      )}
      {edit && dash && (
        <section className="palette" aria-label={t.palette}>
          <span className="hint">{t.paletteHelp}</span>
          <div className="chips">
            {KINDS.map((k) => (
              <button key={k} className="chip" draggable onDragStart={(e) => e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ kind: k }))} onClick={() => addWidget(k)}>
                {t.widgetKinds[k]}
              </button>
            ))}
          </div>
          <input className="search" placeholder={t.paletteSearch} aria-label={t.paletteSearch} value={paletteSearch} onChange={(e) => setPaletteSearch(e.target.value)} />
          <div className="chips bound">
            {[
              ...looks.map((l) => ({ kind: "look" as Kind, id: l.id, name: l.name, color: l.swatch })),
              ...snapshots.map((x) => ({ kind: "snapshot" as Kind, id: x.id, name: `◉ ${x.name}`, color: undefined })),
            ]
              .filter((c) => !paletteSearch || c.name.toLowerCase().includes(paletteSearch.toLowerCase()))
              .slice(0, 60)
              .map((c) => (
                <button
                  key={`${c.kind}:${c.id}`}
                  className="chip"
                  draggable
                  style={c.color ? ({ "--wc": c.color } as React.CSSProperties) : undefined}
                  onDragStart={(e) => e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ kind: c.kind, target: c.id }))}
                  onClick={() => addWidget(c.kind, undefined, c.id)}
                >
                  {c.name}
                </button>
              ))}
          </div>
        </section>
      )}

      {edit && many.length > 1 && (
        <section className="editor many" aria-label={`${many.length} ${t.widgetsSelected}`}>
          <strong>
            {many.length} {t.widgetsSelected}
          </strong>
          <div className="swatches" role="radiogroup" aria-label={t.widgetColor}>
            <button className={`swatch none ${many.every((w) => !w.color) ? "chosen" : ""}`} role="radio" aria-checked={many.every((w) => !w.color)} title={t.noColor} aria-label={t.noColor} onClick={() => patchMany(() => ({ color: undefined }))} />
            {many.some((w) => w.kind === "look") && (
              <button className={`swatch auto ${shared("color", many) === "auto" ? "chosen" : ""}`} role="radio" aria-checked={shared("color", many) === "auto"} title={t.autoColorHelp} aria-label={t.autoColorHelp} onClick={() => patchMany((w) => (w.kind === "look" ? { color: "auto" } : undefined))}>
                A
              </button>
            )}
            {SWATCHES.map(([name, hex]) => (
              <button key={hex} className={`swatch ${shared("color", many) === hex ? "chosen" : ""}`} role="radio" aria-checked={shared("color", many) === hex} title={t.swatchNames[name as keyof typeof t.swatchNames]} aria-label={t.swatchNames[name as keyof typeof t.swatchNames]} style={{ background: hex }} onClick={() => patchMany((w) => (w.kind === "preview" ? undefined : { color: hex }))} />
            ))}
            <input type="color" aria-label={t.customColor} title={t.customColor} value={isHex(shared("color", many)) ? shared("color", many) : "#ffffff"} onChange={(e) => patchMany((w) => (w.kind === "preview" ? undefined : { color: e.target.value }))} />
          </div>
          {many.some(pressable) && (
            <select aria-label={t.mode} value={shared("mode", many.filter(pressable), "latch") ?? ""} onChange={(e) => e.target.value && patchMany((w) => (pressable(w) ? { mode: e.target.value as ButtonMode } : undefined))}>
              {shared("mode", many.filter(pressable), "latch") === undefined && <option value="">{t.mixedModes}</option>}
              {(["latch", "momentary", "trigger"] as const).map((m) => (
                <option key={m} value={m}>
                  {t.modes[m]}
                </option>
              ))}
            </select>
          )}
          {many.some(confirmable) && (
            <label className="row" title={t.confirmPressHelp}>
              <input type="checkbox" checked={many.filter(confirmable).every((w) => w.confirm)} onChange={(e) => patchMany((w) => (confirmable(w) ? { confirm: e.target.checked || undefined } : undefined))} /> {t.confirmPress}
            </label>
          )}
          <button onClick={() => setSelection([])}>{t.deselect}</button>
          <button
            className="danger"
            title={t.removeSelected}
            aria-label={t.removeSelected}
            onClick={() => {
              update((d) => ({ ...d, widgets: d.widgets.filter((w) => !selection.includes(w.id)) }));
              setSelection([]);
            }}
          >
            ✕
          </button>
        </section>
      )}
      {edit && sel && (
        <section className="editor">
          <select value={sel.target ?? ""} onChange={(e) => updateWidget(sel.id, { target: e.target.value })}>
            <option value="">—</option>
            {sel.kind === "look" && looks.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            {sel.kind === "channel-fader" && faders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            {(sel.kind === "group-fader" || sel.kind === "xy") && groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
          <input placeholder={t.labelText} aria-label={t.labelText} value={sel.label ?? ""} onChange={(e) => updateWidget(sel.id, { label: e.target.value || undefined })} />
          {(sel.kind === "look" || sel.kind === "blackout") && (
            <select aria-label={t.mode} value={sel.mode ?? "latch"} onChange={(e) => updateWidget(sel.id, { mode: e.target.value as ButtonMode })}>
              {(["latch", "momentary", "trigger"] as const).map((m) => (
                <option key={m} value={m}>
                  {t.modes[m]}
                </option>
              ))}
            </select>
          )}
          <button onClick={() => updateWidget(sel.id, { x: Math.max(0, sel.x - step) })}>←</button>
          <button onClick={() => updateWidget(sel.id, { x: Math.min((dash?.columns ?? 12) - sel.w, sel.x + step) })}>→</button>
          <button onClick={() => updateWidget(sel.id, { y: Math.max(0, sel.y - step) })}>↑</button>
          <button onClick={() => updateWidget(sel.id, { y: sel.y + step })}>↓</button>
          <button onClick={() => updateWidget(sel.id, { w: Math.max(step, sel.w - step) })}>⇠</button>
          <button onClick={() => updateWidget(sel.id, { w: Math.min(dash?.columns ?? 12, sel.w + step) })}>⇢</button>
          <button onClick={() => updateWidget(sel.id, { h: Math.max(step, sel.h - step) })}>⇡</button>
          <button onClick={() => updateWidget(sel.id, { h: sel.h + step })}>⇣</button>
          <span className="hint">
            {sel.x},{sel.y} · {sel.w}×{sel.h}
          </span>
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

      {stageShown && !edit && (
        <section className="live-stage-panel" aria-label={t.liveStageToggle}>
          <LiveStage onError={setError} views />
        </section>
      )}
      {dash && (
        <div className={`dgrid-scroll${edit ? " editing" : ""}`}>
        <div
          ref={gridRef}
          className={narrow && !edit ? "dgrid" : `dgrid fine${edit ? " editing" : ""}${edit && !snap ? " free" : ""}`}
          style={
            narrow && !edit
              ? { gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gridAutoFlow: "row" }
              : ({ "--cols": dash.columns, gridTemplateColumns: `repeat(${dash.columns * SUB}, minmax(calc(var(--colmin) / ${SUB}), 1fr))`, minWidth: `calc(${dash.columns} * var(--colmin))` } as React.CSSProperties)
          }
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDragOver={(e) => edit && e.dataTransfer.types.includes(DRAG_TYPE) && e.preventDefault()}
          onDrop={(e) => {
            const raw = e.dataTransfer.getData(DRAG_TYPE);
            if (!edit || !raw) return;
            e.preventDefault();
            const { kind, target } = JSON.parse(raw) as { kind: Kind; target?: string };
            addWidget(kind, dropAt(e), target);
          }}
        >
          {(narrow && !edit ? [...dash.widgets].sort((a, b) => a.y - b.y || a.x - b.x) : dash.widgets).map((w) => (
            <div
              key={w.id}
              data-widget={w.id}
              className={`cell ${edit ? "editing" : ""} ${selection.includes(w.id) ? "selected" : ""}${tint(w).className}`}
              style={{
                ...tint(w).style,
                ...(narrow && !edit
                  ? { gridColumn: `span ${Math.min(Math.ceil(w.w), 4)}`, gridRow: `span ${Math.ceil(w.h)}` }
                  : { gridColumn: `${Math.round(w.x * SUB) + 1} / span ${Math.round(w.w * SUB)}`, gridRow: `${Math.round(w.y * SUB) + 1} / span ${Math.round(w.h * SUB)}` }),
              }}
              onClickCapture={(e) => {
                if (press$.current?.fired) {
                  // the click that ends a long press only opened the menu
                  press$.current = null;
                  e.stopPropagation();
                  e.preventDefault();
                  return;
                }
                if (!edit) return;
                e.stopPropagation();
                e.preventDefault();
                const next = pick(dash.widgets, selection, anchor.current, w, { add: e.metaKey || e.ctrlKey || touchPick === "add", frame: e.shiftKey || touchPick === "frame" });
                anchor.current = next.anchor;
                setSelection(next.selection);
              }}
              onContextMenu={(e) => {
                if (!editor) return;
                e.preventDefault();
                refresh();
                setMenu({ id: w.id, x: e.clientX, y: e.clientY });
              }}
              onPointerDown={(e) => {
                if (edit) return startDrag(e, w, "move");
                if (!editor || e.pointerType !== "touch" || !holdable(w)) return;
                const at = { x: e.clientX, y: e.clientY };
                const timer = window.setTimeout(() => {
                  if (!press$.current) return;
                  press$.current.fired = true;
                  refresh();
                  setMenu({ id: w.id, ...at });
                }, LONG_PRESS_MS);
                press$.current = { timer, ...at, fired: false };
              }}
              onPointerMove={(e) => {
                const p = press$.current;
                if (p && !p.fired && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) {
                  window.clearTimeout(p.timer);
                  press$.current = null;
                }
              }}
              onPointerUp={() => {
                const p = press$.current;
                if (p && !p.fired) {
                  window.clearTimeout(p.timer);
                  press$.current = null;
                }
              }}
            >
              {render(w)}
              {edit && CORNERS.map((c) => <span key={c} className={`handle ${c}`} aria-hidden onPointerDown={(e) => startDrag(e, w, c)} />)}
            </div>
          ))}
        </div>
        {/* while editing, a finger on a widget moves it: this strip, kept on the right, scrolls */}
        {edit && <div className="scroll-gutter" title={t.scrollGutter} aria-hidden />}
        </div>
      )}
      {/* under the grid: the safety bar stays at the top, where the hand looks for it */}
      {!edit && !kiosk && <GettingStarted role={role} looks={looks.length} dashboards={dashboards} current={dash} onDashboard={() => void cmd<Dashboard[]>("dashboard.list").then((l) => setDashboards(mine(l)))} />}
      {menu && dash?.widgets.some((w) => w.id === menu.id) && (
        <WidgetMenu
          key={menu.id}
          widget={dash.widgets.find((w) => w.id === menu.id)!}
          at={menu}
          looks={looks}
          groups={groups}
          faders={faders}
          snapshots={snapshots}
          onChange={(patch) => persist((d) => ({ ...d, widgets: d.widgets.map((w) => (w.id === menu.id ? { ...w, ...patch } : w)) }))}
          onRemove={() => {
            persist((d) => ({ ...d, widgets: d.widgets.filter((w) => w.id !== menu.id) }));
            setMenu(null);
          }}
          onClose={() => setMenu(null)}
          onEditLook={(id) => {
            setMenu(null);
            void cmd<LookDraft>("look.get", { id }).then(setEditingLook, (e: Error) => setError(e.message)); // the list is brief: the editor needs the whole look
          }}
        />
      )}
      {editingLook && (
        <Modal label={editingLook.name}>
          <Suspense fallback={<p className="hint">…</p>}>
            <LookEditor
              key={editingLook.id}
              initial={editingLook}
              existing={looks.map((l) => l.id)}
              onClose={() => {
                setEditingLook(null);
                refresh();
              }}
            />
          </Suspense>
        </Modal>
      )}
    </div>
  );
}
