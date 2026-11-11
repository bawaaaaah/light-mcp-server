import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";
import { ApiError, cmd } from "../api";
import { useT } from "../App";
import { useCommandEvents } from "../hooks/useTopic";
import { Modal } from "./Modal";
import { Versions } from "./Versions";
import { canvasBlocks, type CanvasRender } from "../canvas-blocks";
import { addOrder, cellsInFrame, cellTargets, EditHistory, gapAt, isNoMove, isRun, pickCells, pickedAfterMove, shiftOps, shownIn } from "../canvas-edit-view";
import { wrappedFocus } from "../focus-trap";
import { labelOf } from "../util";

/** A canvas as the server stores it (venue.canvas.list). */
export interface CanvasData {
  id: string;
  name: string;
  topology: string;
  cells: number;
  columns?: number;
  notes?: string;
  render: CanvasRender[];
}
/** What the editor needs of a patched fixture. */
export interface EditorFixture {
  id: string;
  name: string;
  color?: string;
  universe: number;
  address: number;
  position?: { x: number; y: number; z: number };
}
interface AffectedLook {
  id: string;
  name: string;
  technique: string;
  reason: "steps" | "cells";
}
interface Adaptable {
  id: string;
  name: string;
  rows: number;
  before: string[][];
  after: string[][];
}
/** A look's rows as its technique stores them (steps, masks or patterns): given back as they came. */
type Rows = string[][] | string[];
interface Impact {
  cellsBefore: number;
  cellsAfter: number;
  shifted: boolean;
  looksAffected: AffectedLook[];
}
/** venue.canvas.get: the canvas, its revision, what is wrong in it. */
interface Got {
  canvas: CanvasData;
  revision: string;
  warnings?: string[];
}
interface EditAnswer extends Got {
  impact: Impact;
  adapted: string[];
  steps?: Record<string, { before: Rows; after: Rows }>;
}
/** A refusal of a canvas write that names what it would break (the server's `detail`). */
interface Refusal {
  impact: Impact;
  broken: string[];
  shared: string[];
  adaptable: Adaptable[];
}
type Op = Record<string, unknown> & { op: string };
type How = { adapt?: true; force?: true };
/** A question open in the window: what was refused, and how to go on. */
interface Ask {
  refusal: Refusal;
  /** A put, a restore: nothing says where each cell went, the steps cannot follow. */
  canAdapt: boolean;
  go: (how: How) => void;
}
type Rect = { left: number; top: number; width: number; height: number };

const refusalOf = (e: unknown): Refusal | undefined => {
  if (!(e instanceof ApiError) || !e.detail?.impact) return undefined;
  const d = e.detail as unknown as Partial<Refusal> & { impact: Impact };
  const broken = d.broken ?? [];
  // only a look still broken is offered to adapt: one the attempt already adapted is not asked again
  return { impact: d.impact, broken, shared: d.shared ?? [], adaptable: (d.adaptable ?? []).filter((a) => broken.includes(a.id)) };
};
/** What a canvas put answers: the canvas with its revision and warnings beside its fields. */
type Put = CanvasData & { revision: string; warnings?: string[] };
const gotOf = ({ revision, warnings, ...canvas }: Put): Got => ({ canvas, revision, ...(warnings ? { warnings } : {}) });
const unknownCanvas = (e: unknown) => e instanceof ApiError && e.detail?.unknown === "canvas";
/** A look as look.preview takes it: what look.get adds (whether it plays, its swatch) left out. */
const lookOnly = (l: Record<string, unknown>): Record<string, unknown> => {
  const { active: _a, swatch: _s, ...rest } = l;
  return rest;
};
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const isField = (el: HTMLElement | null) => !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
const FOCUSABLE = "input, select, textarea, button, summary, [href], [tabindex]";
/** How near the strip a drag still drops (px); farther, letting go cancels it. */
const DROP_MARGIN = 24;

/**
 * The canvas editor (docs/specs/venue-fixtures-stage.md, « Éditer un canevas », T13): a window opened from the
 * canvas list of the Venue page. One square per cell, grouped by fixture; pick by click, Ctrl/⌘, Shift, a frame
 * or the keyboard; drag (mouse or pen) to move, or « move before… » then a touch; Delete to remove; add
 * fixtures; ↶ ↷. Every gesture is one venue.canvas.edit, saved at once, sent one after the other (a burst of
 * keys loses none); undo puts the previous canvas back with the steps of the looks it had adapted, in one
 * venue.canvas.put. When looks of exact steps would no longer line up, the server refuses: the window names
 * them and offers to adapt their steps (with a preview) or to do it anyway.
 */
export function CanvasEditor({ id, fixtures, onClose }: { id: string; fixtures: EditorFixture[]; onClose: () => void }): ReactElement {
  const t = useT();
  const tc = t.canvasEditor;
  const [canvas, setCanvasState] = useState<CanvasData | null>(null);
  const canvasRef = useRef<CanvasData | null>(null);
  const revision = useRef<string | undefined>(undefined);
  const [selection, setSelectionState] = useState<number[]>([]);
  const selectionRef = useRef<number[]>([]);
  const setSelection = useCallback((s: number[]) => {
    selectionRef.current = s;
    setSelectionState(s);
  }, []);
  const anchor = useRef<number | undefined>(undefined);
  const [focusCell, setFocusCell] = useState(0);
  const [multi, setMulti] = useState(false);
  /** « Move before… »: the next square touched is where the picked ones go (a tablet does not drag). */
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  /** Looks whose generated pattern changed with the last gesture: said, never asked. */
  const [notice, setNotice] = useState("");
  const [status, setStatus] = useState({ text: "", n: 0 });
  const say = useCallback((text: string) => setStatus((s) => ({ text, n: s.n + 1 })), []);
  const [busy, setBusy] = useState(false);
  const [gone, setGoneState] = useState(false);
  const goneRef = useRef(false);
  const [ask, setAskState] = useState<Ask | null>(null);
  const askRef = useRef<Ask | null>(null);
  const setAsk = useCallback((a: Ask | null) => {
    askRef.current = a;
    setAskState(a);
  }, []);
  /** The venue is shared and the user went on once: not asked again while the window is open. */
  const sharedOk = useRef(false);
  /** « Adapt the steps » chosen for the gestures that follow, until the window closes. */
  const [alwaysAdapt, setAlwaysAdaptState] = useState(false);
  const alwaysAdaptRef = useRef(false);
  const setAlwaysAdapt = (on: boolean) => {
    alwaysAdaptRef.current = on;
    setAlwaysAdaptState(on);
  };
  const [rememberAdapt, setRememberAdapt] = useState(false);
  const history = useRef(new EditHistory<CanvasData, Rows>());
  const [, setTick] = useState(0); // the undo buttons follow the stacks
  const box = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  /** What had the focus when the window opened (« Éditer »): it gets it back. */
  const opener = useRef(typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null));
  useEffect(() => () => opener.current?.focus?.({ preventScroll: true }), []);
  /** The square to focus once the canvas is drawn again (a move rebuilds the squares). */
  const wantFocus = useRef<number | null>(0); // the first square as the window opens: the keyboard starts in it

  // ---- reading: a read-only command, so nothing is published and the editor never reloads on its own echo
  /** Bumped by every write of this editor: a read sent before it must not bring the older canvas back. */
  const writes = useRef(0);
  /** The gestures sent and not answered yet: they go one after the other. */
  const waiting = useRef(0);
  const reloadWanted = useRef(false);
  const setGone = useCallback(() => {
    goneRef.current = true;
    setGoneState(true);
    setAsk(null);
    history.current.clear();
  }, [setAsk]);
  /** Shows a canvas the server gave. `ours`: the answer to this editor's own write; otherwise a revision that is not ours means it changed elsewhere, and the local undo no longer applies. */
  const show = useCallback(
    (r: Got, ours: boolean) => {
      if (!ours && revision.current !== undefined && r.revision !== revision.current) {
        if (history.current.canUndo || history.current.canRedo) say(tc.changedElsewhere);
        history.current.clear();
      }
      revision.current = r.revision;
      canvasRef.current = r.canvas;
      setCanvasState(r.canvas);
      setWarnings(r.warnings ?? []);
      setSelection(selectionRef.current.filter((i) => i < r.canvas.cells));
      setFocusCell((f) => Math.min(f, r.canvas.cells - 1));
      setTick((n) => n + 1);
    },
    [say, setSelection, tc.changedElsewhere],
  );
  const failed = useCallback(
    (e: unknown) => {
      if (unknownCanvas(e)) setGone();
      else setError((e as Error).message);
    },
    [setGone],
  );
  const reload = useCallback((): void => {
    if (goneRef.current) return;
    if (waiting.current > 0) {
      reloadWanted.current = true; // read once the gestures on their way are answered
      return;
    }
    reloadWanted.current = false;
    const at = writes.current;
    void cmd<Got>("venue.canvas.get", { id }).then((r) => {
      if (at !== writes.current || waiting.current > 0) reloadWanted.current = true; // a write went out meanwhile: read after it
      else show(r, false);
    }, failed);
  }, [id, show, failed]);
  useEffect(() => reload(), [reload]);
  // another device, the AI or « Versions » changed it: read again (our own edits come back the same way, with our revision)
  useCommandEvents(["venue.canvas.", "history.", "show.apply", "show.revert", "backup.restore"], reload);

  /** Queues a gesture: they are sent one at a time, each reading the canvas the previous one left. A question open holds them back, and says so. */
  const chain = useRef<Promise<void>>(Promise.resolve());
  const queued = (task: () => Promise<void>) => {
    if (goneRef.current) return;
    if (askRef.current) return say(tc.answerFirst);
    waiting.current++;
    setBusy(true);
    chain.current = chain.current.then(async () => {
      try {
        if (askRef.current) say(tc.answerFirst);
        else if (!goneRef.current) await task();
      } catch (e) {
        failed(e);
      } finally {
        if (--waiting.current === 0) {
          setBusy(false);
          if (reloadWanted.current) reload();
        }
        setTick((n) => n + 1);
      }
    });
  };

  const passes = (how: How) => ({ ...(sharedOk.current ? { shared: true } : {}), ...(how.force ? { force: true } : {}) });
  /** A stale revision: the canvas changed elsewhere between our read and our write. */
  const staleOr = async (e: unknown) => {
    if (e instanceof ApiError && e.detail?.stale) {
      setError(tc.stale);
      history.current.clear();
      show(await cmd<Got>("venue.canvas.get", { id }), true);
    } else throw e;
  };
  /** Sends one gesture. A refusal that names looks opens the question; `after` runs once it is written. */
  const edit = async (ops: Op[], how: How = {}, after?: (r: EditAnswer) => void): Promise<void> => {
    const before = canvasRef.current;
    if (!before) return;
    setError("");
    setNotice("");
    writes.current++;
    try {
      const r = await cmd<EditAnswer>("venue.canvas.edit", { id, ops, revision: revision.current, ...passes(how), ...(how.adapt || alwaysAdaptRef.current ? { adapt: true } : {}) });
      const rows = Object.entries(r.steps ?? {});
      history.current.push({ before, after: r.canvas, rowsBefore: Object.fromEntries(rows.map(([k, v]) => [k, v.before])), rowsAfter: Object.fromEntries(rows.map(([k, v]) => [k, v.after])) });
      show(r, true);
      const changed = r.impact.looksAffected.filter((l) => l.reason === "cells").map((l) => l.name);
      if (changed.length) setNotice(`${tc.impactCells} ${changed.join(", ")}`);
      after?.(r);
    } catch (e) {
      const refusal = refusalOf(e);
      // an attempt that adapted keeps adapting: forcing the looks that cannot follow must not shift those that can
      if (refusal && !how.force) setAsk({ refusal, canAdapt: true, go: (h) => queued(() => edit(ops, how.adapt ? { ...h, adapt: true } : h, after)) });
      else await staleOr(e);
    }
  };
  /** Undo, redo: the canvas and the looks' steps of that step in one venue.canvas.put, written together or not at all. The step changes stack only once the server took it. */
  const putBack = async (way: "undo" | "redo", how: How = {}): Promise<void> => {
    const step = way === "undo" ? history.current.toUndo : history.current.toRedo;
    if (!step) return;
    const [target, steps] = way === "undo" ? [step.before, step.rowsBefore] : [step.after, step.rowsAfter];
    setError("");
    setNotice("");
    writes.current++;
    try {
      const put = await cmd<Put>("venue.canvas.put", { canvas: target, steps, revision: revision.current, ...passes(how) });
      if (way === "undo") history.current.undone(step);
      else history.current.redone(step);
      show(gotOf(put), true); // the revision this very write made: another one slipped in after it is not taken for ours
      say(way === "undo" ? tc.announceUndone : tc.announceRedone);
    } catch (e) {
      const refusal = refusalOf(e);
      if (refusal && !how.force) setAsk({ refusal, canAdapt: false, go: (h) => queued(() => putBack(way, h)) });
      else await staleOr(e);
    }
  };
  const undo = () => queued(() => putBack("undo"));
  const redo = () => queued(() => putBack("redo"));
  /** « Versions »: an earlier canvas put back; the local undo no longer applies. */
  const restore = (stamp: string, force = false) =>
    queued(async () => {
      setError("");
      writes.current++;
      try {
        const put = await cmd<Put>("history.restore", { collection: "canvases", id, stamp, ...passes(force ? { force: true } : {}) });
        history.current.clear();
        show(gotOf(put), true);
        say(tc.announceRestored);
      } catch (e) {
        const refusal = refusalOf(e);
        if (refusal && !force) setAsk({ refusal, canAdapt: false, go: (h) => restore(stamp, h.force === true) });
        else throw e;
      }
    });
  /** The answer to the question: adapt the steps, do it anyway, or go on (a shared venue alone). */
  const answer = (how: "adapt" | "force" | "go") => {
    const a = askRef.current;
    if (!a) return;
    if (a.refusal.shared.length) sharedOk.current = true;
    if (how === "adapt" && rememberAdapt) setAlwaysAdapt(true);
    setAsk(null);
    wantFocus.current = focusCell;
    a.go(how === "adapt" ? { adapt: true } : how === "force" ? { force: true } : {});
  };
  const cancelAsk = () => {
    setAsk(null);
    wantFocus.current = focusCell;
    setTick((n) => n + 1);
  };

  const cells = useMemo(() => (canvas ? cellTargets(canvas.cells, canvas.render) : []), [canvas]);
  const blocks = useMemo(() => (canvas ? canvasBlocks(canvas.cells, canvas.render, fixtures) : []), [canvas, fixtures]);
  const byId = useMemo(() => new Map(fixtures.map((f) => [f.id, f])), [fixtures]);
  const picked = useMemo(() => new Set(selection), [selection]);
  const present = useMemo(() => new Set(cells.flatMap((c) => c.map((x) => x.fixture))), [cells]);
  const nameOf = useCallback((fid: string) => byId.get(fid)?.name ?? fid, [byId]);
  const cellLabel = (i: number) => {
    const targets = cells[i] ?? [];
    const what = targets.length ? targets.map((x) => `${nameOf(x.fixture)} · ${x.head < 0 ? tc.whole : `${tc.head} ${x.head + 1}`}`).join(" + ") : tc.nothing;
    return `${tc.cell} ${i + 1}${t.colon} ${what}`;
  };

  /** The square to focus once redrawn — when the keyboard was on the squares (or nowhere): a gesture made from a button leaves the focus on it, to press it again. */
  const focusLater = (i: number) => {
    const el = document.activeElement;
    if (!box.current?.contains(el) || strip.current?.contains(el)) wantFocus.current = i;
    else setFocusCell(i);
  };

  // ---- the gestures: each reads the canvas and the selection when its turn comes
  const remove = () =>
    queued(async () => {
      const list = selectionRef.current;
      const c = canvasRef.current;
      if (!c || !list.length) return;
      if (list.length >= c.cells) return say(tc.keepOne); // a canvas keeps a cell: nothing is sent
      await edit([{ op: "remove", cells: list }], {}, (r) => {
        setSelection([]);
        focusLater(Math.min(list[0]!, r.canvas.cells - 1));
        say(`${list.length} ${tc.announceRemoved}`);
      });
    });
  const move = (list: number[], to: number) =>
    queued(async () => {
      const c = canvasRef.current;
      if (!c || !list.length || isNoMove(c.cells, list, to)) return;
      const n = c.cells;
      await edit([{ op: "move", cells: list, to }], {}, () => {
        const now = pickedAfterMove(n, list, to);
        setSelection(now);
        focusLater(now[0] ?? 0);
        say(`${list.length} ${tc.announceMoved}`);
      });
    });
  /** One place earlier or later, by the keyboard or the buttons: every picked square moves, a selection in several pieces keeps its gaps. */
  const nudge = (by: -1 | 1) =>
    queued(async () => {
      const c = canvasRef.current;
      const list = selectionRef.current;
      const ops = c ? shiftOps(c.cells, list, by) : [];
      if (!ops.length) return;
      const focused = wantFocus.current ?? focusCell;
      await edit(ops, {}, () => {
        const now = list.map((i) => i + by);
        setSelection(now);
        focusLater(list.includes(focused) ? focused + by : now[0]!);
        say(`${list.length} ${tc.announceMoved}`);
      });
    });
  const duplicate = () =>
    queued(async () => {
      const list = selectionRef.current;
      if (!list.length) return;
      await edit([{ op: "duplicate", cells: list }], {}, () => {
        const from = list[list.length - 1]! + 1;
        setSelection(list.map((_, k) => from + k)); // the copies, right after the last square copied
        focusLater(from);
        say(`${list.length} ${tc.announceDuplicated}`);
      });
    });
  const reverse = () =>
    queued(async () => {
      const c = canvasRef.current;
      const list = selectionRef.current;
      if (!c || (list.length > 0 && !isRun(list))) return;
      const [from, to] = list.length ? [list[0]!, list[list.length - 1]!] : [0, c.cells - 1];
      await edit([{ op: "reverse", from, to }], {}, () => say(`${to - from + 1} ${tc.announceReversed}`));
    });
  const setMeta = (change: Record<string, unknown>) => queued(() => edit([{ op: "set", ...change }]));

  // ---- picking
  const focusAt = (i: number) => {
    setFocusCell(i);
    strip.current?.querySelector<HTMLElement>(`[data-cell="${i}"]`)?.focus();
  };
  const click = (i: number, e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => {
    if (!canvas) return;
    if (placing) {
      setPlacing(false);
      return move(selectionRef.current, i);
    }
    const r = pickCells(canvas.cells, selection, anchor.current, i, { add: multi || e.ctrlKey || e.metaKey, frame: e.shiftKey });
    anchor.current = r.anchor;
    setSelection(r.selection);
    focusAt(i); // by hand: a click does not focus a button in every browser, and the keys are heard from the focus
  };
  const all = () => canvas && setSelection(Array.from({ length: canvas.cells }, (_, i) => i));

  // ---- dragging (mouse or pen: a touching finger scrolls) and the frame drawn beside the squares
  const press = useRef<{ kind: "cells" | "frame"; x: number; y: number; cells: number[]; add: boolean; rects: Rect[] | null } | null>(null);
  const dragRef = useRef<{ cells: number[]; gap: number | null } | null>(null);
  const [drag, setDragState] = useState<{ cells: number[]; gap: number | null } | null>(null);
  const [frame, setFrame] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const ghost = useRef<HTMLDivElement>(null);
  /** The click that ends a drag (or follows one cancelled) picks nothing. */
  const afterDrag = useRef(false);
  const onCellDown = (i: number) => (e: ReactPointerEvent) => {
    afterDrag.current = false;
    if (e.pointerType === "touch" || e.button !== 0 || placing || askRef.current) return;
    press.current = { kind: "cells", x: e.clientX, y: e.clientY, cells: picked.has(i) ? selection : [i], add: false, rects: null };
  };
  const onStripDown = (e: ReactPointerEvent) => {
    afterDrag.current = false;
    if (e.pointerType === "touch" || e.button !== 0 || (e.target as HTMLElement).closest("[data-cell], button")) return;
    strip.current?.focus({ preventScroll: true }); // a frame focuses nothing by itself: the keys that follow are heard here
    press.current = { kind: "frame", x: e.clientX, y: e.clientY, cells: [], add: e.ctrlKey || e.metaKey || e.shiftKey || multi, rects: null };
  };
  const loaded = canvas !== null && !gone;
  // the handlers read refs only: set once, they see every gesture
  const handlers = useRef({ move, say, tc });
  handlers.current = { move, say, tc };
  useEffect(() => {
    const el = () => strip.current;
    /** The squares' rectangles, measured once per gesture and again after the strip scrolled. */
    const rects = (p: NonNullable<typeof press.current>) => (p.rects ??= [...(el()?.querySelectorAll<HTMLElement>("[data-cell]") ?? [])].map((c) => c.getBoundingClientRect()));
    const near = (x: number, y: number) => {
      const b = el()?.getBoundingClientRect();
      return !!b && x >= b.left - DROP_MARGIN && x <= b.right + DROP_MARGIN && y >= b.top - DROP_MARGIN && y <= b.bottom + DROP_MARGIN;
    };
    let last = { x: 0, y: 0 };
    let scroller: number | undefined;
    const setDrag = (d: { cells: number[]; gap: number | null } | null) => {
      if (d && dragRef.current && d.gap === dragRef.current.gap) return; // the same gap: nothing to draw again
      dragRef.current = d;
      setDragState(d);
    };
    const aim = () => {
      const p = press.current;
      if (!p) return;
      setDrag({ cells: p.cells, gap: near(last.x, last.y) ? gapAt(last.x, last.y, rects(p)) : null });
    };
    const stop = () => {
      press.current = null;
      window.clearInterval(scroller);
      scroller = undefined;
      setFrame(null);
      setDrag(null);
    };
    const cancel = () => {
      const dragging = !!dragRef.current;
      stop();
      if (dragging) {
        afterDrag.current = true;
        handlers.current.say(handlers.current.tc.dragCancelled);
      }
    };
    const moveAt = (e: PointerEvent) => {
      const p = press.current;
      if (!p) return;
      if (p.kind === "frame") return setFrame({ x1: p.x, y1: p.y, x2: e.clientX, y2: e.clientY });
      if (!dragRef.current && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 8) return;
      last = { x: e.clientX, y: e.clientY };
      if (ghost.current) {
        ghost.current.style.left = `${e.clientX + 14}px`;
        ghost.current.style.top = `${e.clientY + 14}px`;
      }
      // near its top or bottom edge, the strip scrolls under a pointer that waits there
      scroller ??= window.setInterval(() => {
        const band = el();
        const b = band?.getBoundingClientRect();
        if (!band || !b || !press.current) return;
        const by = last.y < b.top + 28 ? -14 : last.y > b.bottom - 28 ? 14 : 0;
        if (!by) return;
        const was = band.scrollTop;
        band.scrollTop += by;
        if (band.scrollTop !== was) aim();
      }, 40);
      aim();
    };
    const up = (e: PointerEvent) => {
      const p = press.current;
      if (!p) return;
      if (p.kind === "frame") {
        const view = el()?.getBoundingClientRect();
        const framed = Math.hypot(e.clientX - p.x, e.clientY - p.y) < 4 || !view ? null : cellsInFrame(shownIn(rects(p), view), { x1: p.x, y1: p.y, x2: e.clientX, y2: e.clientY });
        stop();
        const now = selectionRef.current;
        if (!framed) return p.add ? undefined : setSelection([]);
        return setSelection(p.add ? [...new Set([...now, ...framed])].sort((a, b) => a - b) : framed);
      }
      if (!dragRef.current) return void (press.current = null);
      // let go away from the strip: nothing moves
      if (!near(e.clientX, e.clientY)) return cancel();
      const to = gapAt(e.clientX, e.clientY, rects(p));
      stop();
      afterDrag.current = true;
      window.setTimeout(() => (afterDrag.current = false), 300);
      handlers.current.move(p.cells, to);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || (!dragRef.current && press.current?.kind !== "frame")) return;
      e.stopPropagation();
      e.preventDefault();
      cancel();
    };
    const scrolled = () => press.current && (press.current.rects = null);
    const s = el();
    window.addEventListener("pointermove", moveAt);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel); // a pen lifted too far, the system taking the gesture
    window.addEventListener("keydown", key, true);
    s?.addEventListener("scroll", scrolled);
    return () => {
      window.removeEventListener("pointermove", moveAt);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key, true);
      s?.removeEventListener("scroll", scrolled);
      window.clearInterval(scroller);
    };
  }, [loaded, setSelection]); // the strip exists once the canvas is read

  // ---- keyboard: heard on the window's own box, from where the focus is (never on the page behind)
  const onStripKey = (e: ReactKeyboardEvent) => {
    if (!canvas || ask) return;
    const n = canvas.cells;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const by = e.key === "ArrowLeft" ? -1 : 1;
      if (e.altKey) return nudge(by);
      const to = Math.max(0, Math.min(n - 1, focusCell + by));
      if (e.shiftKey) {
        const r = pickCells(n, selection, anchor.current ?? focusCell, to, { add: false, frame: true });
        anchor.current = r.anchor;
        setSelection(r.selection);
      }
      focusAt(to);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      focusAt(e.key === "Home" ? 0 : n - 1);
    } else if ((e.key === " " || e.key === "Enter") && (e.target as HTMLElement).hasAttribute("data-cell")) {
      e.preventDefault();
      click(focusCell, { ctrlKey: mod, metaKey: false, shiftKey: e.shiftKey });
    } else if ((e.key === "Delete" || e.key === "Backspace") && selection.length) {
      e.preventDefault();
      remove();
    } else if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      all();
    }
  };
  const focusables = () => [...(box.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter((el) => el.tabIndex >= 0 && !el.hasAttribute("disabled") && el.offsetParent !== null);
  const onKey = (e: ReactKeyboardEvent) => {
    const el = e.target as HTMLElement;
    if (e.key === "Escape") {
      // Escape ends what is open, innermost first, and never reaches the page behind (the stage plan listens too)
      e.stopPropagation();
      if (ask) cancelAsk();
      else if (placing) setPlacing(false);
      else if (selection.length && strip.current?.contains(el)) setSelection([]);
      return;
    }
    if (e.key === "Tab") {
      const to = wrappedFocus(focusables(), document.activeElement, e.shiftKey);
      if (to) {
        e.preventDefault();
        to.focus();
      }
      return;
    }
    if (e.defaultPrevented || isField(el) || ask) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    }
  };
  useEffect(() => {
    // the focus left the window (what held it was redrawn, a press on the backdrop): Tab brings it back, Escape stays here
    const outside = (e: KeyboardEvent) => {
      if (box.current?.contains(e.target as Node)) return;
      if (e.key === "Escape") e.stopPropagation();
      if (e.key !== "Tab") return;
      e.preventDefault();
      (box.current?.querySelector<HTMLElement>(`[data-cell="${focusCell}"]`) ?? box.current?.querySelector<HTMLElement>("button"))?.focus();
    };
    document.addEventListener("keydown", outside);
    return () => document.removeEventListener("keydown", outside);
  }, [focusCell]);
  // after each drawing: the square a gesture asked for, or (the focus lost with a square redrawn, the window just opened) the current one
  useEffect(() => {
    if (!canvas || ask) return;
    const lost = !box.current?.contains(document.activeElement);
    if (wantFocus.current === null && !lost) return;
    const i = Math.min(wantFocus.current ?? focusCell, canvas.cells - 1);
    wantFocus.current = null;
    setFocusCell(i);
    strip.current?.querySelector<HTMLElement>(`[data-cell="${i}"]`)?.focus({ preventScroll: lost });
  }, [canvas, ask, focusCell]);
  // the question takes the eye and the keyboard: on a phone it opens below the fold
  const asked = ask !== null;
  useEffect(() => {
    if (!asked) return;
    setRememberAdapt(false);
    // on the question itself, never on a button: a Space or an Enter still on its way must not answer it
    panel.current?.focus({ preventScroll: true });
    panel.current?.scrollIntoView({ block: "nearest" });
  }, [asked]);

  // ---- adding fixtures
  const [chosen, setChosen] = useState<string[]>([]);
  const [manualOrder, setManualOrder] = useState(false);
  const [addAt, setAddAt] = useState<"end" | "before">("end");
  const addBefore = addAt === "before" && selection.length > 0; // without a selection there is no « before »
  const choose = (fid: string, on: boolean) => {
    const next = on ? [...chosen, fid] : chosen.filter((x) => x !== fid);
    // the default order (stage left to right when placed, else the patch) until it is changed by hand
    setChosen(manualOrder ? next : addOrder(next.flatMap((x) => byId.get(x) ?? [])).map((f) => f.id));
    if (!next.length) setManualOrder(false);
  };
  const shift = (k: number, by: -1 | 1) => {
    const next = [...chosen];
    const [x] = next.splice(k, 1);
    next.splice(k + by, 0, x!);
    setChosen(next);
    setManualOrder(true);
  };
  const add = () => {
    if (!chosen.length) return;
    const list = chosen;
    queued(async () => {
      const c = canvasRef.current;
      if (!c) return;
      const at = addBefore ? selectionRef.current[0] : undefined;
      await edit([{ op: "add", fixtures: list, ...(at !== undefined ? { at } : {}) }], {}, (r) => {
        const added = r.canvas.cells - c.cells;
        const from = at ?? c.cells;
        setSelection(Array.from({ length: added }, (_, k) => from + k));
        focusLater(from);
        setChosen([]);
        setManualOrder(false);
        say(`${added} ${tc.announceAdded}`);
      });
    });
  };

  // ---- aim the picked cells at something else (the count does not change: no look shifts)
  const [retarget, setRetarget] = useState<{ fixture: string; head: number; heads: { head: number; accent: boolean }[] } | null>(null);
  const headsAsked = useRef(0);
  const loadHeads = (fid: string) => {
    const at = ++headsAsked.current; // a slower answer for a fixture chosen before must not replace this one
    setRetarget({ fixture: fid, head: -1, heads: [] });
    void cmd<{ heads: { head: number; accent: boolean }[] }>("venue.fixture.heads", { fixture: fid }).then(
      (v) => at === headsAsked.current && setRetarget({ fixture: fid, head: -1, heads: v.heads.filter((h) => h.head >= 0) }),
      () => undefined,
    );
  };
  const aimAt = () => {
    if (!retarget) return;
    const targets = [{ fixture: retarget.fixture, head: retarget.head }];
    queued(async () => {
      const list = selectionRef.current;
      if (list.length) await edit([{ op: "retarget", cells: list, targets }], {}, () => say(`${list.length} ${tc.announceRetargeted}`));
    });
  };

  // ---- a look's preview painted on the squares
  const [allLooks, setLooks] = useState<{ id: string; name: string; canvas: string }[]>([]);
  useEffect(() => void cmd<{ id: string; name: string; canvas: string }[]>("look.list").then(setLooks, () => undefined), []);
  const [previewId, setPreviewId] = useState("");
  const [previewSteps, setPreviewSteps] = useState<(string | null)[][]>([]);
  const [previewStep, setPreviewStep] = useState(0);
  useEffect(() => {
    if (!previewId) return setPreviewSteps([]);
    let live = true;
    void cmd<Record<string, unknown>>("look.get", { id: previewId })
      .then((l) => cmd<{ steps: (string | null)[][] }>("look.preview", { look: lookOnly(l) }))
      .then((p) => live && (setPreviewSteps(p.steps), setPreviewStep((s) => Math.min(s, Math.max(0, p.steps.length - 1)))), () => live && setPreviewSteps([]));
    return () => void (live = false);
  }, [previewId, canvas]);
  const painted = previewSteps[previewStep];

  const head = (
    <header className="row canvas-editor-head">
      <h2>
        {tc.title} {canvas && <small className="hint">({canvas.cells} {tc.cells.toLowerCase()})</small>}
      </h2>
      {canvas && !gone && (
        <>
          <button title={`${t.undo} (${isMac ? "⌘" : "Ctrl+"}Z)`} aria-label={t.undo} disabled={!history.current.canUndo || asked} onClick={undo}>
            ↶
          </button>
          <button title={`${t.redo} (${isMac ? "⇧⌘" : `Ctrl+${tc.shiftKey}+`}Z)`} aria-label={t.redo} disabled={!history.current.canRedo || asked} onClick={redo}>
            ↷
          </button>
        </>
      )}
      <button className="ghost" onClick={onClose}>
        {t.close}
      </button>
    </header>
  );
  if (!canvas || gone)
    return (
      <Modal label={canvas ? `${tc.title} · ${canvas.name}` : tc.title}>
        <div className="canvas-editor" ref={box} onKeyDown={onKey}>
          {head}
          {gone ? (
            <p className="error" role="alert">
              {tc.gone}
            </p>
          ) : error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : (
            <p className="hint">…</p>
          )}
        </div>
      </Modal>
    );

  const cellCount = canvas.cells;
  const cellOf = (i: number) => {
    const owner = cells[i]?.[0]?.fixture;
    const colour = painted ? (painted[i] ?? undefined) : owner ? byId.get(owner)?.color : undefined;
    const isPicked = picked.has(i);
    const carried = drag?.cells.includes(i);
    return (
      <span key={i} className="canvas-cell-slot">
        {drag?.gap === i && <span className="canvas-gap" aria-hidden />}
        <button
          type="button"
          role="option"
          data-cell={i}
          aria-selected={isPicked}
          aria-label={cellLabel(i)}
          title={cellLabel(i)}
          tabIndex={i === focusCell ? 0 : -1}
          className={["canvas-cell", isPicked ? "picked" : "", carried ? "carried" : "", cells[i]?.length ? "" : "empty", painted ? "painted" : ""].filter(Boolean).join(" ")}
          style={colour ? { background: colour } : undefined}
          onPointerDown={onCellDown(i)}
          onClick={(e) => !afterDrag.current && click(i, e)}
          onFocus={() => setFocusCell(i)}
        >
          {i + 1}
        </button>
        {drag?.gap === cellCount && i === cellCount - 1 && <span className="canvas-gap after" aria-hidden />}
      </span>
    );
  };
  const onCanvas = allLooks.filter((l) => l.canvas === id);
  const refused = ask?.refusal;
  const brokenLooks = refused ? refused.impact.looksAffected.filter((l) => l.reason === "steps" && refused.broken.includes(l.id)) : [];
  const adaptable = ask?.canAdapt ? (refused?.adaptable ?? []) : [];
  const notAdaptable = brokenLooks.filter((l) => !adaptable.some((a) => a.id === l.id));
  const canReverse = selection.length === 0 || isRun(selection);
  const atStart = !selection.length || selection[0] === 0;
  const atEnd = !selection.length || selection[selection.length - 1] === cellCount - 1;
  const manyTargets = selection.some((i) => (cells[i]?.length ?? 0) > 1);

  return (
    <Modal label={`${tc.title} · ${canvas.name}`}>
      <div className="canvas-editor" ref={box} onKeyDown={onKey} aria-busy={busy}>
        {head}
        <div className="editor canvas-meta">
          <label className="field">
            <span>{tc.name}</span>
            <input
              key={canvas.name}
              defaultValue={canvas.name}
              aria-label={tc.name}
              onBlur={(e) => {
                const name = e.target.value.trim();
                if (!name) e.target.value = canvas.name; // a canvas keeps a name: the one it had comes back
                else if (name !== canvas.name) setMeta({ name });
              }}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            />
          </label>
          <label className="field">
            <span>{tc.shape}</span>
            <select aria-label={tc.shape} value={canvas.topology} onChange={(e) => setMeta({ topology: e.target.value })}>
              {(["line", "line-mirror", "ring", "grid", "free"] as const).map((k) => (
                <option key={k} value={k}>
                  {labelOf(t.topologies, k)}
                </option>
              ))}
            </select>
          </label>
          {canvas.topology === "grid" && (
            <label className="field">
              <span>{tc.columns}</span>
              <input
                type="number"
                min={1}
                max={cellCount}
                key={`${canvas.columns ?? 0}/${cellCount}`}
                defaultValue={canvas.columns ?? ""}
                aria-label={tc.columns}
                onBlur={(e) => {
                  const columns = Math.min(cellCount, Math.round(Number(e.target.value)));
                  if (!(columns >= 1)) e.target.value = String(canvas.columns ?? "");
                  else if (columns !== canvas.columns) setMeta({ columns });
                  else e.target.value = String(columns); // typed past the cell count: shown as it is kept
                }}
                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              />
            </label>
          )}
          {onCanvas.length > 0 && (
            <label className="field">
              <span>{tc.preview}</span>
              <select aria-label={tc.preview} value={previewId} onChange={(e) => setPreviewId(e.target.value)}>
                <option value="">{tc.previewNone}</option>
                {onCanvas.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {previewSteps.length > 1 && (
            <span className="row" role="group" aria-label={tc.previewStep}>
              <button className="ghost" aria-label={`${tc.previewStep} −`} onClick={() => setPreviewStep((s) => (s - 1 + previewSteps.length) % previewSteps.length)}>
                ◀
              </button>
              <span>
                {tc.previewStep} {previewStep + 1}/{previewSteps.length}
              </span>
              <button className="ghost" aria-label={`${tc.previewStep} +`} onClick={() => setPreviewStep((s) => (s + 1) % previewSteps.length)}>
                ▶
              </button>
            </span>
          )}
        </div>
        <p className="hint only-fine">{tc.help}</p>
        <p className="hint only-coarse">{tc.helpTouch}</p>
        {warnings.length > 0 && <p className="hint canvas-warning">⚠ {warnings.join(" · ")}</p>}
        <div className="row canvas-tools" role="toolbar" aria-label={tc.cells}>
          <button className="ghost" aria-pressed={multi} title={tc.multiHelp} onClick={() => setMulti(!multi)}>
            {tc.multi}
          </button>
          <button className="ghost" onClick={all}>
            {tc.selectAll}
          </button>
          <button className="ghost" disabled={!selection.length} onClick={() => setSelection([])}>
            {tc.selectNone}
          </button>
          <span className="hint" aria-live="polite">
            {selection.length} {tc.picked}
          </span>
          <span className="spacer" />
          <button disabled={atStart || asked} aria-label={tc.moveLeft} title={`${tc.moveLeft} (Alt+←)`} onClick={() => nudge(-1)}>
            ◀
          </button>
          <button disabled={atEnd || asked} aria-label={tc.moveRight} title={`${tc.moveRight} (Alt+→)`} onClick={() => nudge(1)}>
            ▶
          </button>
          <button disabled={!selection.length || selection.length >= cellCount || asked} aria-pressed={placing} title={tc.moveBeforeHelp} onClick={() => setPlacing(!placing)}>
            {tc.moveBefore}
          </button>
          <button disabled={!selection.length || asked} onClick={duplicate}>
            {tc.duplicate}
          </button>
          <button disabled={!canReverse || asked} title={canReverse ? undefined : tc.reverseHelp} onClick={reverse}>
            {selection.length ? tc.reverse : tc.reverseAll}
          </button>
          <button className="danger" disabled={!selection.length || selection.length >= cellCount || asked} title={selection.length >= cellCount ? tc.keepOne : undefined} onClick={remove}>
            {tc.remove}
          </button>
        </div>
        {placing && (
          <p className="canvas-placing" role="status">
            {tc.placingHelp}{" "}
            <button
              onClick={() => {
                setPlacing(false);
                move(selection, cellCount);
              }}
            >
              {tc.placeAtEnd}
            </button>{" "}
            <button className="ghost" onClick={() => setPlacing(false)}>
              {t.cancel}
            </button>
          </p>
        )}
        {alwaysAdapt && (
          <p className="hint">
            {tc.adaptingAlways}{" "}
            <button className="ghost" onClick={() => setAlwaysAdapt(false)}>
              {tc.askAgain}
            </button>
          </p>
        )}
        <div
          ref={strip}
          tabIndex={-1}
          className={["canvas-strip", drag ? "dragging" : "", placing ? "placing" : ""].filter(Boolean).join(" ")}
          role="listbox"
          aria-multiselectable="true"
          aria-label={`${tc.cells} · ${canvas.name}`}
          onKeyDown={onStripKey}
          onPointerDown={onStripDown}
        >
          {blocks.map((b) => (
            <div key={b.from} className="canvas-block" role="group" aria-label={b.label || tc.nothing} style={b.color ? { borderTopColor: b.color } : undefined}>
              <span className="canvas-block-label" aria-hidden>
                {b.label || tc.nothing}
              </span>
              <div className="canvas-block-cells">{Array.from({ length: b.to - b.from + 1 }, (_, k) => cellOf(b.from + k))}</div>
            </div>
          ))}
        </div>
        {frame && <div className="canvas-frame" aria-hidden style={{ left: Math.min(frame.x1, frame.x2), top: Math.min(frame.y1, frame.y2), width: Math.abs(frame.x2 - frame.x1), height: Math.abs(frame.y2 - frame.y1) }} />}
        <div ref={ghost} className="drag-ghost" hidden={!drag} aria-hidden>
          {drag?.gap === null ? tc.dropToCancel : `${drag?.cells.length} ${tc.dragging}`}
        </div>
        <p key={status.n} className="sr-only" role="status" aria-live="polite">
          {status.text}
        </p>
        {notice && <p className="hint canvas-notice">{notice}</p>}
        {error && (
          <p className="error" role="alert" onClick={() => setError("")}>
            {error}
          </p>
        )}
        {refused && (
          <section ref={panel} tabIndex={-1} className="canvas-impact" role="alertdialog" aria-label={brokenLooks.length ? tc.impactTitle : tc.sharedTitle} aria-describedby="canvas-impact-text">
            <h3>{brokenLooks.length ? tc.impactTitle : tc.sharedTitle}</h3>
            <div id="canvas-impact-text">
              {brokenLooks.length > 0 && <p>{tc.impactSteps}</p>}
              {adaptable.length > 0 && (
                <ul>
                  {adaptable.map((a) => (
                    <li key={a.id}>
                      <strong>{a.name}</strong>
                      {t.colon} {a.rows} {tc.rowsFollow}
                      <div className="steps-compare" aria-hidden>
                        {(["before", "after"] as const).map((k) => (
                          <div key={k}>
                            <small className="hint">{tc[k]}</small>
                            <div className="mini-steps">
                              {a[k].map((row, y) => (
                                <div key={y} className="mini-row">
                                  {row.map((c, x) => (
                                    <span key={x} className={c === "" ? "untouched" : undefined} style={c && c !== "-" ? { background: c.slice(0, 7) } : undefined} />
                                  ))}
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                      {a.rows > a.before.length && (
                        <small className="hint">
                          + {a.rows - a.before.length} {tc.moreRows}
                        </small>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {notAdaptable.length > 0 && (
                <p>
                  {ask?.canAdapt ? tc.impactNotAdaptable : tc.impactPut} {notAdaptable.map((l) => l.name).join(", ")}
                </p>
              )}
              {refused.impact.looksAffected.some((l) => l.reason === "cells") && (
                <p>
                  {tc.impactCells}{" "}
                  {refused.impact.looksAffected
                    .filter((l) => l.reason === "cells")
                    .map((l) => l.name)
                    .join(", ")}
                </p>
              )}
              {refused.shared.length > 0 && (
                <p>
                  {tc.impactShared} {refused.shared.join(", ")}. {tc.sharedOnce}
                </p>
              )}
              {adaptable.length > 0 && <p className="hint">{tc.adaptHelp}</p>}
            </div>
            {adaptable.length > 0 && (
              <label className="row">
                <input type="checkbox" checked={rememberAdapt} onChange={(e) => setRememberAdapt(e.target.checked)} />
                {tc.adaptAlways}
              </label>
            )}
            <div className="row">
              {adaptable.length > 0 && (
                <button className="primary" onClick={() => answer("adapt")}>
                  {tc.adapt}
                </button>
              )}
              {brokenLooks.length > 0 ? (
                <button className="danger" onClick={() => answer("force")}>
                  {tc.force}
                </button>
              ) : (
                <button className="primary" onClick={() => answer("go")}>
                  {tc.sharedGo}
                </button>
              )}
              <button className="ghost" onClick={cancelAsk}>
                {t.cancel}
              </button>
            </div>
          </section>
        )}
        <details className="canvas-add">
          <summary>{tc.add}</summary>
          <p className="hint">{tc.addHelp}</p>
          <div className="canvas-add-cols">
            <ul className="canvas-add-list">
              {[...fixtures]
                .sort((a, b) => a.universe - b.universe || a.address - b.address)
                .map((f) => (
                  <li key={f.id}>
                    <label className="row">
                      <input type="checkbox" checked={chosen.includes(f.id)} onChange={(e) => choose(f.id, e.target.checked)} />
                      {f.color && <span className="swatch-dot" style={{ background: f.color }} aria-hidden />}
                      {f.name}
                      {present.has(f.id) && <small className="hint">({tc.already})</small>}
                    </label>
                  </li>
                ))}
            </ul>
            {chosen.length > 0 && (
              <ol className="canvas-add-order">
                {chosen.map((fid, k) => (
                  <li key={fid}>
                    {nameOf(fid)}{" "}
                    <button className="ghost" aria-label={`${tc.earlier} ${nameOf(fid)}`} disabled={k === 0} onClick={() => shift(k, -1)}>
                      ↑
                    </button>
                    <button className="ghost" aria-label={`${tc.later} ${nameOf(fid)}`} disabled={k === chosen.length - 1} onClick={() => shift(k, 1)}>
                      ↓
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </div>
          {chosen.some((f) => present.has(f)) && <p className="hint canvas-warning">⚠ {tc.addTwice}</p>}
          <div className="row">
            <label className="field">
              <span>{tc.addAt}</span>
              <select aria-label={tc.addAt} value={addBefore ? "before" : "end"} onChange={(e) => setAddAt(e.target.value as "end" | "before")}>
                <option value="end">{tc.atEnd}</option>
                <option value="before" disabled={!selection.length}>
                  {tc.beforePicked}
                </option>
              </select>
            </label>
            <button className="primary" disabled={!chosen.length || asked} onClick={add}>
              {tc.addButton} ({chosen.length})
            </button>
          </div>
        </details>
        <details className="canvas-retarget" onToggle={(e) => !e.currentTarget.open && setRetarget(null)}>
          <summary>{tc.retarget}</summary>
          <p className="hint">{tc.retargetHelp}</p>
          <div className="row">
            <select aria-label={tc.retarget} value={retarget?.fixture ?? ""} onChange={(e) => (e.target.value ? loadHeads(e.target.value) : setRetarget(null))}>
              <option value="">—</option>
              {fixtures.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
            {retarget && (
              <select aria-label={tc.head} value={retarget.head} onChange={(e) => setRetarget({ ...retarget, head: Number(e.target.value) })}>
                <option value={-1}>{tc.whole}</option>
                {retarget.heads.map((h) => (
                  <option key={h.head} value={h.head}>
                    {tc.head} {h.head + 1}
                    {h.accent ? ` (${tc.accent})` : ""}
                  </option>
                ))}
              </select>
            )}
            <button disabled={!retarget || !selection.length || asked} onClick={aimAt}>
              {tc.retargetButton} ({selection.length})
            </button>
          </div>
          {retarget && manyTargets && <p className="hint canvas-warning">⚠ {tc.retargetMany}</p>}
        </details>
        <Versions collection="canvases" id={id} help={tc.versionsHelp} restore={(v) => restore(v.stamp)} onRestored={reload} />
      </div>
    </Modal>
  );
}
