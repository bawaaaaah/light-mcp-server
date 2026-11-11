import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";
import { ApiError, cmd } from "../api";
import { useT } from "../App";
import { useCommandEvents } from "../hooks/useTopic";
import { Modal } from "./Modal";
import { Versions } from "./Versions";
import { canvasBlocks, type CanvasRender } from "../canvas-blocks";
import { addOrder, cellsInFrame, cellTargets, EditHistory, gapAt, isNoMove, pickCells, pickedAfterMove, type EditStep } from "../canvas-edit-view";
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
interface EditAnswer {
  canvas: CanvasData;
  revision: string;
  impact: { cellsBefore: number; cellsAfter: number; shifted: boolean; looksAffected: AffectedLook[] };
  adaptable: Adaptable[];
  adapted: string[];
  warnings?: string[];
}
/** A refusal of venue.canvas.edit (or put) that names what it would break. */
interface Refusal {
  message: string;
  impact: EditAnswer["impact"];
  broken: string[];
  shared: string[];
  adaptable: Adaptable[];
}
type Op = Record<string, unknown> & { op: string };
type FullLook = Record<string, unknown> & { id: string };
type Step = EditStep<CanvasData, FullLook>;

const refusalOf = (e: unknown): Refusal | undefined => {
  if (!(e instanceof ApiError) || !e.detail?.impact) return undefined;
  const d = e.detail as unknown as Omit<Refusal, "message">;
  return { message: e.message, impact: d.impact, broken: d.broken ?? [], shared: d.shared ?? [], adaptable: d.adaptable ?? [] };
};
/** A look as look.put takes it back: what look.get adds (whether it plays, its swatch) left out. */
const lookOnly = (l: FullLook): FullLook => {
  const { active: _a, swatch: _s, ...rest } = l;
  return rest as FullLook;
};
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * The canvas editor (docs/specs/venue-fixtures-stage.md, « Éditer un canevas », T13): a window opened from the
 * canvas list of the Venue page. One square per cell, grouped by fixture; pick by click, Ctrl/⌘, Shift, a frame
 * or the keyboard; drag (mouse or pen) to move; Delete to remove; add fixtures; ↶ ↷. Every gesture is one
 * venue.canvas.edit, saved at once; undo puts the previous canvas back (and the steps of the looks it adapted).
 * When looks of exact steps would no longer line up, the server refuses: the editor names them and offers to
 * adapt their steps (with a preview) or to do it anyway.
 */
export function CanvasEditor({ id, fixtures, onClose }: { id: string; fixtures: EditorFixture[]; onClose: () => void }): ReactElement {
  const t = useT();
  const tc = t.canvasEditor;
  const [canvas, setCanvas] = useState<CanvasData | null>(null);
  const revision = useRef<string | undefined>(undefined);
  const [selection, setSelection] = useState<number[]>([]);
  const anchor = useRef<number | undefined>(undefined);
  const [focusCell, setFocusCell] = useState(0);
  const [multi, setMulti] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ ops: Op[]; refusal: Refusal; after?: (r: EditAnswer) => void } | null>(null);
  const history = useRef(new EditHistory<CanvasData, FullLook>());
  const [, setTick] = useState(0); // the undo buttons follow the stacks
  const strip = useRef<HTMLDivElement>(null);

  /**
   * Bumped by every write of this editor: a read sent before it answers with the canvas as it was, and must not
   * bring that older revision back (the next gesture would be refused as stale).
   */
  const writes = useRef(0);
  /** Reads the canvas and its revision (an edit with no operation, nothing written). */
  const reload = useCallback(() => {
    const at = writes.current;
    return cmd<EditAnswer>("venue.canvas.edit", { id, ops: [], dryRun: true }).then(
        (r) => {
          if (at !== writes.current) return; // a write went out meanwhile: its own answer (or a later read) says the truth
          revision.current = r.revision;
          setCanvas(r.canvas);
          setSelection((s) => s.filter((i) => i < r.canvas.cells));
        },
        (e: Error) => setError(/canevas inconnu|unknown canvas/.test(e.message) ? tc.gone : e.message),
      );
  }, [id, tc.gone]);
  useEffect(() => void reload(), [reload]);
  // another device or the AI changed it: read again (our own edits come back the same way, harmlessly)
  useCommandEvents(["venue.canvas.", "history."], () => void reload());

  const cells = useMemo(() => (canvas ? cellTargets(canvas.cells, canvas.render) : []), [canvas]);
  const blocks = useMemo(() => (canvas ? canvasBlocks(canvas.cells, canvas.render, fixtures) : []), [canvas, fixtures]);
  const nameOf = useCallback((fid: string) => fixtures.find((f) => f.id === fid)?.name ?? fid, [fixtures]);
  const cellLabel = (i: number) => {
    const targets = cells[i] ?? [];
    const what = targets.length ? targets.map((x) => `${nameOf(x.fixture)} · ${x.head < 0 ? tc.whole : `${tc.head} ${x.head + 1}`}`).join(" + ") : tc.nothing;
    return `${tc.cell} ${i + 1}${t.colon} ${what}`;
  };

  /** Sends one gesture. A refusal that names looks opens the question; `after` runs once it is written. */
  const edit = async (ops: Op[], opts: { adapt?: true; force?: true } = {}, after?: (r: EditAnswer) => void): Promise<void> => {
    if (!canvas || busy) return;
    setBusy(true);
    setError("");
    try {
      // the looks whose steps it adapts are read whole first: undo puts them back
      const adaptIds = opts.adapt ? (pending?.refusal.adaptable.map((a) => a.id) ?? []) : [];
      const looksBefore = await Promise.all(adaptIds.map((l) => cmd<FullLook>("look.get", { id: l }).then(lookOnly)));
      writes.current++;
      const r = await cmd<EditAnswer>("venue.canvas.edit", { id, ops, revision: revision.current, ...opts });
      const looksAfter = await Promise.all(r.adapted.map((l) => cmd<FullLook>("look.get", { id: l }).then(lookOnly)));
      history.current.push({ before: canvas, after: r.canvas, looksBefore: looksBefore.filter((l) => r.adapted.includes(l.id)), looksAfter });
      revision.current = r.revision;
      setCanvas(r.canvas);
      setPending(null);
      if (r.warnings?.length) setError(r.warnings.join(" · "));
      after?.(r);
    } catch (e) {
      const refusal = refusalOf(e);
      if (refusal && !opts.force) setPending({ ops, refusal, ...(after ? { after } : {}) });
      else if (e instanceof ApiError && e.detail?.stale) {
        setError(tc.stale);
        await reload();
      } else setError((e as Error).message);
    } finally {
      setBusy(false);
      setTick((n) => n + 1);
    }
  };

  /** Puts a whole canvas back (undo, redo): checked by the server as any put; a refusal is asked about. */
  const putBack = async (step: Step, way: "undo" | "redo") => {
    const [looks, target] = way === "undo" ? [step.looksBefore, step.before] : [step.looksAfter, step.after];
    writes.current++;
    for (const l of looks) await cmd("look.put", { look: l });
    try {
      await cmd("venue.canvas.put", { canvas: target });
    } catch (e) {
      const refusal = refusalOf(e);
      if (!refusal || !confirm(`${refusal.message}\n\n${tc.force}`)) throw e;
      await cmd("venue.canvas.put", { canvas: target, force: true });
    }
    await reload();
  };
  const undo = async () => {
    const s = history.current.undo();
    if (!s || busy) return;
    setBusy(true);
    try {
      await putBack(s, "undo");
    } catch (e) {
      history.current.restoreUndo(s);
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setTick((n) => n + 1);
    }
  };
  const redo = async () => {
    const s = history.current.redo();
    if (!s || busy) return;
    setBusy(true);
    try {
      await putBack(s, "redo");
    } catch (e) {
      history.current.restoreRedo(s);
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setTick((n) => n + 1);
    }
  };

  // ---- the gestures
  const remove = (list = selection) => {
    if (!list.length) return;
    void edit([{ op: "remove", cells: list }], {}, () => {
      setSelection([]);
      setStatus(`${list.length} ${tc.announceRemoved}`);
    });
  };
  const move = (list: number[], to: number) => {
    if (!canvas || !list.length || isNoMove(canvas.cells, list, to)) return;
    const n = canvas.cells;
    void edit([{ op: "move", cells: list, to }], {}, () => {
      const now = pickedAfterMove(n, list, to);
      setSelection(now);
      setFocusCell(now[0] ?? 0);
      setStatus(`${list.length} ${tc.announceMoved}`);
    });
  };
  /** One cell earlier or later, by the keyboard or the buttons (a touch screen does not drag). */
  const nudge = (by: -1 | 1) => {
    if (!canvas || !selection.length) return;
    const first = selection[0]!;
    const last = selection[selection.length - 1]!;
    if (by < 0 && first > 0) move(selection, first - 1);
    if (by > 0 && last < canvas.cells - 1) move(selection, last + 2);
  };
  const duplicate = () => selection.length && void edit([{ op: "duplicate", cells: selection }]);
  const reverse = () => {
    if (!canvas) return;
    const [from, to] = selection.length > 1 ? [selection[0]!, selection[selection.length - 1]!] : [0, canvas.cells - 1];
    void edit([{ op: "reverse", from, to }]);
  };
  const setMeta = (change: Record<string, unknown>) => void edit([{ op: "set", ...change }]);

  // ---- picking
  const click = (i: number, e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => {
    if (!canvas) return;
    const r = pickCells(canvas.cells, selection, anchor.current, i, { add: multi || e.ctrlKey || e.metaKey, frame: e.shiftKey });
    anchor.current = r.anchor;
    setSelection(r.selection);
    setFocusCell(i);
  };

  // ---- dragging (mouse or pen: a touching finger scrolls) and the frame drawn beside the squares
  const press = useRef<{ kind: "cells" | "frame"; x: number; y: number; cells: number[]; add: boolean } | null>(null);
  const [drag, setDrag] = useState<{ cells: number[]; gap: number } | null>(null);
  const [frame, setFrame] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const ghost = useRef<HTMLDivElement>(null);
  const afterDrag = useRef(false);
  const rects = () => [...(strip.current?.querySelectorAll<HTMLElement>("[data-cell]") ?? [])].map((el) => el.getBoundingClientRect());
  const onCellDown = (i: number) => (e: ReactPointerEvent) => {
    if (e.pointerType === "touch" || e.button !== 0) return;
    press.current = { kind: "cells", x: e.clientX, y: e.clientY, cells: selection.includes(i) ? selection : [i], add: false };
  };
  const onStripDown = (e: ReactPointerEvent) => {
    if (e.pointerType === "touch" || e.button !== 0 || (e.target as HTMLElement).closest("[data-cell]")) return;
    press.current = { kind: "frame", x: e.clientX, y: e.clientY, cells: [], add: e.ctrlKey || e.metaKey || e.shiftKey || multi };
  };
  useEffect(() => {
    const moveAt = (e: PointerEvent) => {
      const p = press.current;
      if (!p) return;
      if (p.kind === "frame") {
        setFrame({ x1: p.x, y1: p.y, x2: e.clientX, y2: e.clientY });
        return;
      }
      if (!drag && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 8) return;
      if (ghost.current) {
        ghost.current.style.left = `${e.clientX + 14}px`;
        ghost.current.style.top = `${e.clientY + 14}px`;
      }
      setDrag({ cells: p.cells, gap: gapAt(e.clientX, e.clientY, rects()) });
    };
    const up = (e: PointerEvent) => {
      const p = press.current;
      press.current = null;
      if (!p) return;
      if (p.kind === "frame") {
        setFrame(null);
        if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < 4) {
          if (!p.add) setSelection([]);
          return;
        }
        const inside = cellsInFrame(rects(), { x1: p.x, y1: p.y, x2: e.clientX, y2: e.clientY });
        setSelection((s) => (p.add ? [...new Set([...s, ...inside])].sort((a, b) => a - b) : inside));
        return;
      }
      if (!drag) return;
      setDrag(null);
      afterDrag.current = true;
      window.setTimeout(() => (afterDrag.current = false), 300);
      move(p.cells, gapAt(e.clientX, e.clientY, rects()));
    };
    window.addEventListener("pointermove", moveAt);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", moveAt);
      window.removeEventListener("pointerup", up);
    };
  });

  // ---- keyboard: on the strip (a roving focus), and ⌘Z / ⇧⌘Z anywhere in the window but a text field
  const focusAt = (i: number) => {
    setFocusCell(i);
    strip.current?.querySelector<HTMLElement>(`[data-cell="${i}"]`)?.focus();
  };
  const onStripKey = (e: ReactKeyboardEvent) => {
    if (!canvas) return;
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
    } else if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      click(focusCell, { ctrlKey: mod, metaKey: false, shiftKey: e.shiftKey });
    } else if (e.key === "Escape" && selection.length) {
      e.stopPropagation();
      setSelection([]);
    }
  };
  useEffect(() => {
    // on the window: a click on a square does not focus it in every browser (Safari), and a frame focuses nothing
    const keys = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if ((el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")) || pending) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        void (e.shiftKey ? redo() : undo());
      } else if ((e.key === "Delete" || e.key === "Backspace") && selection.length) {
        e.preventDefault();
        remove();
      } else if (mod && e.key.toLowerCase() === "a" && canvas) {
        e.preventDefault();
        setSelection(Array.from({ length: canvas.cells }, (_, i) => i));
      }
    };
    window.addEventListener("keydown", keys);
    return () => window.removeEventListener("keydown", keys);
  });

  // ---- adding fixtures
  const [chosen, setChosen] = useState<string[]>([]);
  const [manualOrder, setManualOrder] = useState(false);
  const [addAt, setAddAt] = useState<"end" | "before">("end");
  const choose = (fid: string, on: boolean) => {
    const next = on ? [...chosen, fid] : chosen.filter((x) => x !== fid);
    // the default order (stage left to right when placed, else the patch) until it is changed by hand
    setChosen(manualOrder ? next : addOrder(next.map((x) => fixtures.find((f) => f.id === x)!).filter(Boolean)).map((f) => f.id));
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
    const at = addAt === "before" && selection.length ? selection[0] : undefined;
    const count = canvas?.cells ?? 0;
    void edit([{ op: "add", fixtures: chosen, ...(at !== undefined ? { at } : {}) }], {}, (r) => {
      const added = r.canvas.cells - count;
      const from = at ?? count;
      setSelection(Array.from({ length: added }, (_, k) => from + k));
      setChosen([]);
      setManualOrder(false);
      setStatus(`${added} ${tc.announceAdded}`);
    });
  };

  // ---- aim the picked cells at something else (the count does not change: no look shifts)
  const [retarget, setRetarget] = useState<{ fixture: string; head: number; heads: { head: number; accent: boolean }[] } | null>(null);
  const loadHeads = (fid: string) =>
    void cmd<{ heads: { head: number; accent: boolean }[] }>("venue.fixture.heads", { fixture: fid }).then(
      (v) => setRetarget({ fixture: fid, head: -1, heads: v.heads.filter((h) => h.head >= 0) }),
      () => setRetarget({ fixture: fid, head: -1, heads: [] }),
    );

  // ---- a look's preview painted on the squares
  const [allLooks, setLooks] = useState<{ id: string; name: string; canvas: string }[]>([]);
  useEffect(() => void cmd<{ id: string; name: string; canvas: string }[]>("look.list").then(setLooks, () => undefined), []);
  const [previewId, setPreviewId] = useState("");
  const [previewSteps, setPreviewSteps] = useState<(string | null)[][]>([]);
  const [previewStep, setPreviewStep] = useState(0);
  useEffect(() => {
    if (!previewId) return setPreviewSteps([]);
    let live = true;
    void cmd<FullLook>("look.get", { id: previewId })
      .then((l) => cmd<{ steps: (string | null)[][] }>("look.preview", { look: lookOnly(l) }))
      .then((p) => live && (setPreviewSteps(p.steps), setPreviewStep((s) => Math.min(s, Math.max(0, p.steps.length - 1)))), () => live && setPreviewSteps([]));
    return () => void (live = false);
  }, [previewId, canvas]);
  const painted = previewSteps[previewStep];

  if (!canvas)
    return (
      <Modal label={tc.title}>
        <div className="canvas-editor">
          <header className="row">
            <h2>{tc.title}</h2>
            <button className="ghost" onClick={onClose}>
              {t.close}
            </button>
          </header>
          {error ? <p className="error">{error}</p> : <p className="hint">…</p>}
        </div>
      </Modal>
    );

  const cellCount = canvas.cells;
  const cellOf = (i: number) => {
    const owner = cells[i]?.[0]?.fixture;
    const colour = painted ? (painted[i] ?? undefined) : owner ? fixtures.find((f) => f.id === owner)?.color : undefined;
    const picked = selection.includes(i);
    const carried = drag?.cells.includes(i);
    return (
      <span key={i} className="canvas-cell-slot">
        {drag?.gap === i && <span className="canvas-gap" aria-hidden />}
        <button
          type="button"
          role="option"
          data-cell={i}
          aria-selected={picked}
          aria-label={cellLabel(i)}
          title={cellLabel(i)}
          tabIndex={i === focusCell ? 0 : -1}
          className={["canvas-cell", picked ? "picked" : "", carried ? "carried" : "", cells[i]?.length ? "" : "empty", painted ? "painted" : ""].filter(Boolean).join(" ")}
          style={colour ? { background: colour } : undefined}
          onPointerDown={onCellDown(i)}
          onClick={(e) => !afterDrag.current && click(i, e)}
          onFocus={() => setFocusCell(i)}
        >
          {i + 1}
        </button>
        {drag?.gap === cellCount && i === cellCount - 1 && <span className="canvas-gap" aria-hidden />}
      </span>
    );
  };
  const onCanvas = allLooks.filter((l) => l.canvas === id);
  const refused = pending?.refusal;

  return (
    <Modal label={`${tc.title} · ${canvas.name}`}>
      <div className="canvas-editor">
        <header className="row canvas-editor-head">
          <h2>
            {tc.title} <small className="hint">({cellCount} {tc.cells.toLowerCase()})</small>
          </h2>
          <span className="spacer" />
          <button title={`${t.undo} (${isMac ? "⌘" : "Ctrl+"}Z)`} aria-label={t.undo} disabled={!history.current.canUndo || busy} onClick={() => void undo()}>
            ↶
          </button>
          <button title={`${t.redo} (${isMac ? "⇧⌘" : "Ctrl+Maj+"}Z)`} aria-label={t.redo} disabled={!history.current.canRedo || busy} onClick={() => void redo()}>
            ↷
          </button>
          <button className="ghost" onClick={onClose}>
            {t.close}
          </button>
        </header>
        <div className="editor canvas-meta">
          <label className="field">
            <span>{tc.name}</span>
            <input key={canvas.name} defaultValue={canvas.name} aria-label={tc.name} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== canvas.name && setMeta({ name: e.target.value.trim() })} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
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
              <input type="number" min={1} max={cellCount} key={canvas.columns ?? 0} defaultValue={canvas.columns ?? ""} aria-label={tc.columns} onBlur={(e) => Number(e.target.value) >= 1 && Number(e.target.value) !== canvas.columns && setMeta({ columns: Math.round(Number(e.target.value)) })} />
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
        <p className="hint">{tc.help}</p>
        <div className="row canvas-tools" role="toolbar" aria-label={tc.cells}>
          <button className="ghost" aria-pressed={multi} title={tc.multiHelp} onClick={() => setMulti(!multi)}>
            {tc.multi}
          </button>
          <button className="ghost" onClick={() => setSelection(Array.from({ length: cellCount }, (_, i) => i))}>
            {tc.selectAll}
          </button>
          <button className="ghost" disabled={!selection.length} onClick={() => setSelection([])}>
            {tc.selectNone}
          </button>
          <span className="hint" aria-live="polite">
            {selection.length} {tc.picked}
          </span>
          <span className="spacer" />
          <button disabled={!selection.length || busy || selection[0] === 0} aria-label={tc.moveLeft} title={`${tc.moveLeft} (Alt+←)`} onClick={() => nudge(-1)}>
            ◀
          </button>
          <button disabled={!selection.length || busy || selection[selection.length - 1] === cellCount - 1} aria-label={tc.moveRight} title={`${tc.moveRight} (Alt+→)`} onClick={() => nudge(1)}>
            ▶
          </button>
          <button disabled={!selection.length || busy} onClick={duplicate}>
            {tc.duplicate}
          </button>
          <button disabled={busy} onClick={reverse}>
            {tc.reverse}
          </button>
          <button className="danger" disabled={!selection.length || busy || selection.length >= cellCount} onClick={() => remove()}>
            {tc.remove}
          </button>
        </div>
        <div ref={strip} className="canvas-strip" role="listbox" aria-multiselectable="true" aria-label={`${tc.cells} · ${canvas.name}`} onKeyDown={onStripKey} onPointerDown={onStripDown}>
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
          {drag?.cells.length} {tc.dragging}
        </div>
        <p className="sr-only" role="status" aria-live="polite">
          {status}
        </p>
        {error && (
          <p className="error" role="alert" onClick={() => setError("")}>
            {error}
          </p>
        )}
        {refused && (
          <section className="canvas-impact" role="alertdialog" aria-label={tc.impactTitle}>
            <h3>{tc.impactTitle}</h3>
            {refused.broken.length > 0 && (
              <>
                <p>{tc.impactSteps}</p>
                <ul>
                  {refused.adaptable.map((a) => (
                    <li key={a.id}>
                      <strong>{a.name}</strong>
                      <div className="steps-compare">
                        {(["before", "after"] as const).map((k) => (
                          <div key={k}>
                            <small className="hint">{tc[k]}</small>
                            <div className="mini-steps" aria-hidden>
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
              </>
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
                {tc.impactShared} {refused.shared.join(", ")}
              </p>
            )}
            {refused.broken.length > 0 && <p className="hint">{tc.adaptHelp}</p>}
            <div className="row">
              {refused.broken.length > 0 && (
                // on a shared venue, the other shows were named above: adapting goes ahead for them too
                <button className="primary" disabled={busy} onClick={() => void edit(pending.ops, { adapt: true, ...(refused.shared.length ? { force: true } : {}) }, pending.after)}>
                  {tc.adapt}
                </button>
              )}
              <button className="danger" disabled={busy} onClick={() => void edit(pending.ops, { force: true }, pending.after)}>
                {tc.force}
              </button>
              <button className="ghost" onClick={() => setPending(null)}>
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
          <div className="row">
            <label className="field">
              <span>{tc.addAt}</span>
              <select aria-label={tc.addAt} value={addAt} onChange={(e) => setAddAt(e.target.value as "end" | "before")}>
                <option value="end">{tc.atEnd}</option>
                <option value="before" disabled={!selection.length}>
                  {tc.beforePicked}
                </option>
              </select>
            </label>
            <button className="primary" disabled={!chosen.length || busy} onClick={add}>
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
            <button disabled={!retarget || !selection.length || busy} onClick={() => retarget && void edit([{ op: "retarget", cells: selection, targets: [{ fixture: retarget.fixture, head: retarget.head }] }])}>
              {tc.retarget.replace("…", "")} ({selection.length})
            </button>
          </div>
        </details>
        <Versions collection="canvases" id={id} onRestored={() => void reload()} />
      </div>
    </Modal>
  );
}
