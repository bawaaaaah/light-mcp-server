import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { ApiError, can, cmd, type Role } from "../api";
import { useT } from "../i18n-context";
import { useHoverPeek } from "../components/HoverPeek";
import { PreviewBeforeLaunch } from "../components/PreviewBeforeLaunch";
import { useFreezeFast, usePreviewFirst } from "../hooks/usePreviewSettings";
import { useDomainEvents, useTopic } from "../hooks/useTopic";
import { useStored } from "../hooks/useStored";
import type { ZoneChip } from "../components/XyPad";
import type { PadFixture, PadZone } from "../components/TargetPad";
import { useTargetNames } from "../hooks/useTargets";
import { PROJECTION_CHANGES } from "../hooks/useZoneProjection";
import { usePositions } from "../hooks/usePositions";
import type { FixtureFunctions } from "../fader-functions";
import { LiveStagePanel } from "../components/LiveStagePanel";
import { AdvancedEditors } from "../components/AdvancedEditors";
import { putInSet, WidgetMenu, type ExclusiveSet, type TargetLists } from "../components/WidgetMenu";
import type { LookDraft } from "../components/LookEditor";
import type { KnowledgeIntentions } from "../intentions";
import type { GroupDraft } from "../components/GroupEditor";
import type { FaderDraft } from "../components/FaderEditor";
import { GettingStarted } from "../components/GettingStarted";
import { RecentlyDeleted, Versions } from "../components/Versions";
import { textOn } from "../color";
import { pick } from "../selection";
import { quoted } from "../typography";
import { useArm } from "../hooks/useArm";
import { useKiosk } from "../hooks/useKiosk";
import { added, clone, colorOf, CORNERS, dragged, dropCell, holdable, settle, SUB, type Dashboard, type Drag, type Handle, type Widget, type WidgetKind } from "../dashboard-layout";
import { latestRead } from "../list-reads";
import type { ChannelFader, Glide, Group, LightState, Look, Tempo, SongState, WidgetEnv } from "../widgets/env";
import { WidgetView } from "../widgets/registry";
import { ManyEditor, WidgetEditor } from "../widgets/WidgetEditor";
import { DRAG_TYPE, Palette } from "../widgets/Palette";

/** What changes the target pads' plan and the zone chips: the fixtures, the zones (T24, T27). */
const TARGET_STAGE_CHANGES = PROJECTION_CHANGES;

export function DashboardsPage({ role }: { role: Role }): ReactElement {
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
  // the intentions, to say a look's ambiance: tags by label (T15b)
  const [knowledge, setKnowledge] = useState<KnowledgeIntentions | null>(null);
  const readKnowledge = useCallback(() => void cmd<KnowledgeIntentions>("knowledge.get").then(setKnowledge).catch(() => undefined), []);
  useEffect(readKnowledge, [readKnowledge]);
  useDomainEvents(["intentions", "show"], readKnowledge);
  const [groups, setGroups] = useState<Group[]>([]);
  const [faders, setFaders] = useState<ChannelFader[]>([]);
  /** The patch's channels and their named ranges: a channel fader on a channel cut into functions shows them beside its track (T6). */
  const [fixtureChannels, setFixtureChannels] = useState<FixtureFunctions[]>([]);
  const readChannels = useCallback(() => void cmd<FixtureFunctions[]>("venue.fixture.channels").then(setFixtureChannels, () => undefined), []);
  useEffect(readChannels, [readChannels]);
  useDomainEvents(["patch", "show"], readChannels);
  const [snapshots, setSnapshots] = useState<{ id: string; name: string }[]>([]);
  /** The show's 3D targets (T24), their names only: the menus (each pad reads its own target). */
  const { names: targets, loaded: targetsLoaded } = useTargetNames();
  /** The show's named positions (T32): their buttons, menus and colours. */
  const { positions, loaded: positionsLoaded } = usePositions();
  const positionColor = (id: string | undefined) => positions.find((x) => x.id === id)?.color;
  /** Folders named ahead (show.folder.create): offered in the look editor like the Show page does. */
  const [namedFolders, setNamedFolders] = useState<string[]>([]);
  const [edit, setEdit] = useState(false);
  const [paletteSearch, setPaletteSearch] = useState("");
  const { kiosk, toggleKiosk } = useKiosk();
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
  // The bar always stays in view while the page scrolls; pinned, the stage (Live) or the edit tools
  // stay with it, both remembered by this browser.
  const [stagePinned, setStagePinned] = useStored("liveStagePinned", false);
  const [toolsPinned, setToolsPinned] = useStored("dashboardToolsPinned", true);
  /** The beams on the Live's stage, and a look's colours on hovering its button: both can be left out. */
  const [stageBeams, setStageBeams] = useStored("liveStageBeams", true);
  const [hoverPeekOn, setHoverPeekOn] = useStored("lookHoverPeek", true);
  /** A press on a look button opens its preview first (on by default on a touch screen), and the previews of fast-flashing looks can be frozen. */
  const [previewFirst, setPreviewFirst] = usePreviewFirst();
  const [freezeFast, setFreezeFast] = useFreezeFast();
  /** The look whose preview is open before its launch: what to show, and what starting it runs. */
  const [previewing, setPreviewing] = useState<{ id: string; name: string; fire: () => void } | null>(null);
  /** A mouse to hover with: a touch screen has no hover preview, nor its switch. */
  const [mouse] = useState(() => window.matchMedia?.("(hover: hover)").matches ?? true);
  const pinned = edit ? toolsPinned : stageShown && stagePinned;
  // what stays in view (the bar, or all that is pinned) is left out when the page brings something
  // into view (keyboard focus, find in page), so nothing lands under it (--live-top)
  const topRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const stuck = pinned ? topRef.current : topRef.current?.querySelector<HTMLElement>(".bar");
    if (!stuck || typeof ResizeObserver === "undefined") return;
    const root = document.documentElement;
    const watch = new ResizeObserver(() => root.style.setProperty("--live-top", `${stuck.offsetHeight}px`));
    watch.observe(stuck);
    return () => {
      watch.disconnect();
      root.style.removeProperty("--live-top");
    };
  }, [pinned]);
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
  // a DCA's or a channel fader's whole editor, from the « Advanced » of a widget's menu
  const [editingGroup, setEditingGroup] = useState<GroupDraft | null>(null);
  const [editingFader, setEditingFader] = useState<FaderDraft | null>(null);
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
  const drag = useRef<Drag | null>(null);
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
    const { x, y, w, h } = dragged(g, e.clientX, e.clientY, step, dash.columns);
    const cur = dash.widgets.find((c) => c.id === g.id);
    if (cur && (cur.x !== x || cur.y !== y || cur.w !== w || cur.h !== h)) updateWidget(g.id, { x, y, w, h });
  };
  const endDrag = () => {
    const g = drag.current;
    drag.current = null;
    if (g) update((d) => ({ ...d, widgets: settle(d.widgets, g.id) }));
    dragging.current = false;
  };
  const [error, setError] = useState("");
  const state = useTopic<LightState | null>("light:state", null);
  // the grand master as dragged, until the server says it (a fader must not jump back mid-gesture)
  const [gm, setGm] = useState<number | null>(null);
  useEffect(() => setGm(null), [state?.grandMaster]);
  const tempo = useTopic<Tempo | null>("light:tempo", null);
  // smoothed faders on their way: the level really sent, drawn as a ghost bar (groups-masters.md, « Lissage »)
  const glide = useTopic<Glide>("light:glide", { groups: {}, faders: {} });
  const song = useTopic<SongState>("light:song", {});

  // a late answer arriving after a newer read of the same list must not rewrite the widgets with a
  // mid-glide snapshot (a thumb left at 20 % while the fader sits at 80 %): per list, only the last read wins
  const reads = useRef({ looks: 0, groups: 0, faders: 0, snapshots: 0, folders: 0 });
  /** The lists read at least once: before, a widget's target is not said « introuvable » (the list is only empty). */
  const [listsRead, setListsRead] = useState({ looks: false, groups: false, faders: false, snapshots: false });
  /** The one way a read list is written: kept, and marked read. */
  const [applyRead] = useState(() => {
    const readOnce = (list: keyof typeof listsRead) => setListsRead((r) => (r[list] ? r : { ...r, [list]: true }));
    return {
      looks: (v: Look[]) => (setLooks(v), readOnce("looks")),
      groups: (v: Group[]) => (setGroups(v), readOnce("groups")),
      faders: (v: ChannelFader[]) => (setFaders(v), readOnce("faders")),
      snapshots: (v: { id: string; name: string }[]) => (setSnapshots(v), readOnce("snapshots")),
    };
  });
  /** A read that fails twice is said, like the dashboards' own (and the list stays as it was). */
  const [readRetry] = useState(() => ({ onError: (e: Error) => setError(e.message) }));
  const readGroups = useCallback(() => latestRead(reads.current, "groups", () => cmd<Group[]>("group.list"), applyRead.groups, readRetry), [applyRead, readRetry]);
  const refresh = useCallback(() => {
    latestRead(reads.current, "looks", () => cmd<Look[]>("look.list", { brief: true }), applyRead.looks, readRetry);
    readGroups();
    latestRead(reads.current, "faders", () => cmd<ChannelFader[]>("fader.list"), applyRead.faders, readRetry);
    latestRead(reads.current, "snapshots", () => cmd<{ id: string; name: string }[]>("snapshot.list"), applyRead.snapshots, readRetry);
    latestRead(reads.current, "folders", () => cmd<{ folders: string[] }>("show.settings"), (s) => setNamedFolders(s.folders ?? []), readRetry);
  }, [applyRead, readGroups, readRetry]);
  useEffect(() => {
    refresh();
    void cmd<Dashboard[]>("dashboard.list").then((l) => setDashboards(mine(l))).catch((e: Error) => setError(e.message));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `mine` is a new closure on every render; the list is filtered once, when the page opens (the role does not change under it)
  }, [refresh]);
  useDomainEvents(["looks", "playback", "canvases", "groups", "faders", "settings", "snapshots", "songs", "show"], refresh);
  // an effective level read while the group still glided is stale (a fader left at 5 % kept showing
  // the 43 % it had half-way there): the topic announces the gliders still running, so a group that
  // leaves it has landed — read its effective level then, not once the last glide of the page ended
  const glided = useRef<string[]>([]);
  useEffect(() => {
    const now = Object.keys(glide.groups);
    if (glided.current.some((id) => !now.includes(id))) readGroups();
    glided.current = now;
  }, [glide.groups, readGroups]);
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
  // the target pads' plan (T24): the venue's fixtures and zones, read once for all of them, only when there is one; the
  // XY pads' zone chips (T27, lot 4) read the same zones
  const hasTargetPad = Boolean(dash?.widgets.some((w) => w.kind === "target" || w.kind === "xy" || w.kind === "zones"));
  const [targetStage, setTargetStage] = useState<{ fixtures: PadFixture[]; zones: PadZone[] }>({ fixtures: [], zones: [] });
  const hasTargetPadRef = useRef(hasTargetPad);
  hasTargetPadRef.current = hasTargetPad;
  // stable: useDomainEvents keeps the function it was first given
  const readTargetStage = useCallback(() => {
    if (!hasTargetPadRef.current) return;
    void Promise.all([cmd<PadFixture[]>("venue.fixture.list"), cmd<PadZone[]>("stage.zone.list")]).then(([fixtures, zones]) => setTargetStage({ fixtures, zones }), () => undefined);
  }, []);
  useEffect(readTargetStage, [readTargetStage, hasTargetPad]);
  // what changes the fixtures or the zones (the same as a head's projected zones, stage.zone.project)
  useDomainEvents(TARGET_STAGE_CHANGES, readTargetStage);
  /** The aiming zones, as chips under the group pads (T27, lot 4). */
  const zoneChips = useMemo<ZoneChip[]>(() => targetStage.zones.flatMap((z) => (z.aim ? [{ id: z.id, name: z.name, color: z.aim.color }] : [])), [targetStage.zones]);
  const lookById = useMemo(() => new Map(looks.map((l) => [l.id, l])), [looks]);
  // a look deleted while its sheet is open: forget it, or a look put back under the same id would bring the sheet back
  useEffect(() => {
    if (previewing && !lookById.has(previewing.id)) setPreviewing(null);
  }, [previewing, lookById]);
  /** The exclusive sets (radio buttons): a look started releases the others of its set only. */
  const sets = useMemo<ExclusiveSet[]>(() => groups.filter((g) => g.exclusive).map((g) => ({ id: g.id, name: g.name, looks: g.members?.looks ?? [] })), [groups]);
  const setOf = (look: string | undefined) => sets.find((g) => look !== undefined && g.looks.includes(look));
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
  const addWidget = (kind: WidgetKind, at?: { x: number; y: number }, target?: string) => {
    if (!dash) return;
    const id = `${kind}-${Date.now().toString(36)}`;
    update((d) => ({ ...d, widgets: added(d, kind, id, at, target) }));
    setSelected(id);
  };
  /** The grid cell under a drop, snapped. */
  const dropAt = (e: React.DragEvent) => {
    const grid = gridRef.current!;
    const r = grid.getBoundingClientRect();
    const rh = Number.parseFloat(getComputedStyle(grid).gridAutoRows) * SUB;
    return dropCell(e.clientX - r.left, e.clientY - r.top, r.width / (dash?.columns ?? 12), rh, step);
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
        if (dashboards.length < 2 || !confirm(`${t.deleteDashboardConfirm} ${quoted(t, dash.name)}`)) return;
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

  // « À confirmer » buttons (widgets/press.tsx): one button armed at a time on the page; a second press sooner than
  // CONFIRM_MIN_MS (a double click, a double tap, a held key) does not confirm
  const { armed, press: armPress } = useArm<() => void>();
  const confirmed = (id: string | undefined, fire: () => void) => {
    if (!id) return fire();
    armPress(id, fire)?.payload();
  };
  // a look's colours in a tooltip, under the mouse; not while arranging the widgets
  const hoverPeek = useHoverPeek(!edit && hoverPeekOn);
  /** What the widgets read and run: read once here for all of them. */
  const env: WidgetEnv = {
    edit,
    may,
    locked,
    run,
    onError: setError,
    state,
    tempo,
    song,
    glide,
    gm,
    setGm,
    lookById,
    groupById,
    groupsRead: listsRead.groups,
    setGroups,
    faders,
    setFaders,
    snapshots,
    fixtureChannels,
    zoneChips,
    targetStage,
    stageBeams,
    knowledge,
    setOf,
    hoverPeek,
    previewFirst,
    preview: setPreviewing,
    armed,
    confirmed,
  };

  const tint = (w: Widget) => {
    const c = colorOf(w, (id) => lookById.get(id)?.swatch, positionColor);
    return c ? { className: " tinted", style: { "--wc": c, "--wc-text": textOn(c) } as React.CSSProperties } : { className: "", style: {} };
  };
  const sel = dash?.widgets.find((w) => w.id === selected);
  // several selected: what they share is set for all of them at once (one step to undo)
  const many = selection.length > 1 ? (dash?.widgets.filter((w) => selection.includes(w.id)) ?? []) : [];
  /** What a widget can drive, per list; a list not read yet is null. */
  const targetLists: TargetLists = {
    looks: listsRead.looks ? looks : null,
    groups: listsRead.groups ? groups : null,
    faders: listsRead.faders ? faders : null,
    snapshots: listsRead.snapshots ? snapshots : null,
    targets: targetsLoaded ? targets : null,
    positions: positionsLoaded ? positions : null,
  };
  const patchMany = (fn: (w: Widget) => Partial<Widget> | undefined) => update((d) => ({ ...d, widgets: d.widgets.map((w) => (selection.includes(w.id) ? { ...w, ...fn(w) } : w)) }));
  return (
    <div className="dashboards">
      <div ref={topRef} className={`dash-top${pinned ? " pinned" : ""}${edit ? " editing" : ""}`}>
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
            <button className={toolsPinned ? "toggle pin on" : "toggle pin"} aria-pressed={toolsPinned} aria-label={t.pinTools} title={t.pinToolsHelp} onClick={() => setToolsPinned(!toolsPinned)}>
              📌
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
            {mouse && (
              <button className={hoverPeekOn ? "ghost on" : "ghost"} aria-pressed={hoverPeekOn} title={t.hoverPeekHelp} onClick={() => setHoverPeekOn(!hoverPeekOn)}>
                {t.hoverPeekToggle}
              </button>
            )}
            {may("commands:trigger") && (
              <button className={previewFirst ? "ghost on" : "ghost"} aria-pressed={previewFirst} title={t.previewFirstHelp} onClick={() => setPreviewFirst(!previewFirst)}>
                {t.previewFirstToggle}
              </button>
            )}
            <button className={freezeFast ? "ghost on" : "ghost"} aria-pressed={freezeFast} title={t.freezeFastHelp} onClick={() => setFreezeFast(!freezeFast)}>
              {t.freezeFastToggle}
            </button>
            <button className={stageShown ? "ghost on" : "ghost"} title={t.liveStageHelp} aria-pressed={stageShown} onClick={toggleStage}>
              {t.liveStageToggle}
            </button>
            {stageShown && (
              <button className={stagePinned ? "ghost pin on" : "ghost pin"} aria-pressed={stagePinned} aria-label={t.pinStage} title={t.pinStageHelp} onClick={() => setStagePinned(!stagePinned)}>
                {stagePinned ? `📌 ${t.pinned}` : "📌"}
              </button>
            )}
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
      {edit && dash && <Palette looks={looks} snapshots={snapshots} positions={positions} search={paletteSearch} onSearch={setPaletteSearch} onAdd={(kind, target) => addWidget(kind, undefined, target)} />}

      {edit && many.length > 1 && (
        <ManyEditor
          many={many}
          sets={editor ? sets : undefined}
          setOf={setOf}
          onPatch={patchMany}
          onSetPick={(ids, v) => void putInSet(ids, v).then(refresh, (e: Error) => setError(e.message))}
          onDeselect={() => setSelection([])}
          onRemove={() => {
            update((d) => ({ ...d, widgets: d.widgets.filter((w) => !selection.includes(w.id)) }));
            setSelection([]);
          }}
        />
      )}
      {edit && sel && (
        <WidgetEditor
          w={sel}
          columns={dash?.columns ?? 12}
          step={step}
          lists={targetLists}
          onPatch={(patch) => updateWidget(sel.id, patch)}
          onRemove={() => {
            update((d) => ({ ...d, widgets: d.widgets.filter((w) => w.id !== sel.id) }));
            setSelected(null);
          }}
        />
      )}

      {stageShown && !edit && <LiveStagePanel pinned={stagePinned} beams={stageBeams} onBeams={setStageBeams} onError={setError} />}
      </div>
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
            const { kind, target } = JSON.parse(raw) as { kind: WidgetKind; target?: string };
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
              <WidgetView w={w} env={env} />
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
      {hoverPeek.node}
      {previewing && lookById.get(previewing.id) && (
        <PreviewBeforeLaunch
          lookId={previewing.id}
          name={previewing.name}
          danger={lookById.get(previewing.id)!.danger}
          manualOnly={lookById.get(previewing.id)!.manualOnly}
          onCancel={() => setPreviewing(null)}
          onLaunch={() => {
            // the sheet goes first, so the rule dialog of the browser does not pile onto it
            const { fire } = previewing;
            setPreviewing(null);
            fire();
          }}
        />
      )}
      {menu && dash?.widgets.some((w) => w.id === menu.id) && (
        <WidgetMenu
          key={menu.id}
          widget={dash.widgets.find((w) => w.id === menu.id)!}
          at={menu}
          lists={targetLists}
          exclusives={editor ? sets : undefined}
          onGroupsChange={refresh}
          onChange={(patch) => persist((d) => ({ ...d, widgets: d.widgets.map((w) => (w.id === menu.id ? { ...w, ...patch } : w)) }))}
          onRemove={() => {
            persist((d) => ({ ...d, widgets: d.widgets.filter((w) => w.id !== menu.id) }));
            setMenu(null);
          }}
          onClose={() => setMenu(null)}
          onAdvanced={(kind, id) => {
            setMenu(null);
            const fail = (e: Error) => setError(e.message);
            if (kind === "look") void cmd<LookDraft>("look.get", { id }).then(setEditingLook, fail); // the list is brief: the editor needs the whole look
            else if (kind === "group") void cmd<GroupDraft[]>("group.list").then((l) => setEditingGroup(l.find((g) => g.id === id) ?? null), fail);
            else void cmd<FaderDraft[]>("fader.list").then((l) => setEditingFader(l.find((f) => f.id === id) ?? null), fail);
          }}
        />
      )}
      <AdvancedEditors
        look={editingLook}
        group={editingGroup}
        fader={editingFader}
        looks={looks}
        groups={groups}
        faders={faders}
        namedFolders={namedFolders}
        onClose={(kind) => {
          if (kind === "look") setEditingLook(null);
          else if (kind === "group") setEditingGroup(null);
          else setEditingFader(null);
          refresh();
        }}
      />
    </div>
  );
}
