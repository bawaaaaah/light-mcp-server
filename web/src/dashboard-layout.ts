/**
 * A dashboard's widgets and their placement (docs/specs/ui-dashboards.md): the kinds, their default sizes, the grid of
 * quarter cells, a drag's move or resize, a drop, the cascade that pushes down what a widget lands on, and what each
 * kind offers (its target list, its press behaviour, its colour). Pure: no DOM, no React, tested without a browser.
 */
import { isHex } from "./color.js";

/** The kinds of widget, in the palette's order: the union is derived from it, so a kind cannot be left out of the palette. */
export const KINDS = ["look", "group-fader", "grand-master", "section", "snapshot", "panic", "blackout", "tap", "stop-all", "song-nav", "label", "xy", "target", "position", "motion-lock", "preview", "channel-fader", "colours", "zones"] as const;
export type WidgetKind = (typeof KINDS)[number];
/** Look and Blackout buttons: trigger (always on), latch (on/off), momentary (on while pressed). */
export type ButtonMode = "trigger" | "latch" | "momentary" | "toggle";

export interface Widget {
  id: string;
  kind: WidgetKind;
  x: number;
  y: number;
  w: number;
  h: number;
  target?: string;
  label?: string;
  mode?: ButtonMode;
  /**
   * "#rrggbb", or "auto" (a look button takes its look's colour); absent = neutral. A named position's button (T32)
   * takes its position's colour when absent or "auto", and is neutral only with "none".
   */
  color?: string;
  /** Two presses to switch on (look, Blackout, snapshot). */
  confirm?: boolean;
}
export interface Dashboard {
  id: string;
  name: string;
  columns: number;
  widgets: Widget[];
}
interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const SIZE: Partial<Record<WidgetKind, { w: number; h: number }>> = { "group-fader": { w: 1, h: 4 }, "grand-master": { w: 1, h: 4 }, "channel-fader": { w: 1, h: 4 }, xy: { w: 3, h: 4 }, target: { w: 6, h: 6 }, preview: { w: 6, h: 4 }, colours: { w: 6, h: 3 }, zones: { w: 6, h: 3 } };
/** A new widget's size, in cells: a button is two cells wide. */
export const defaultSize = (kind: WidgetKind): { w: number; h: number } => SIZE[kind] ?? { w: 2, h: 1 };

/** A grid cell is split in quarters, so a widget can sit between the lines of the magnetic grid. */
export const SUB = 4;
export type Handle = "move" | "nw" | "ne" | "sw" | "se";
export const CORNERS: Handle[] = ["nw", "ne", "sw", "se"];

/** A widget dropped onto others pushes them down (in cascade), as in a classic dashboard editor. */
export function settle<T extends Box>(widgets: T[], movedId: string): T[] {
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

/** A drag under way: the handle held, the box at its start (cells), the pointer at its start, and a cell's size (px). */
export interface Drag {
  id: string;
  mode: Handle;
  x0: number;
  y0: number;
  w0: number;
  h0: number;
  px: number;
  py: number;
  cw: number;
  rh: number;
}

/**
 * Where a drag puts its widget, the pointer at (`clientX`, `clientY`): moved, or resized by a corner, by steps of
 * `step` cells; never narrower or shorter than a step, never out of the `columns` nor above the top.
 */
export function dragged(g: Drag, clientX: number, clientY: number, step: number, columns: number): { x: number; y: number; w: number; h: number } {
  const q = (v: number) => Math.round(v / step) * step;
  const dx = (clientX - g.px) / g.cw;
  const dy = (clientY - g.py) / g.rh;
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
  w = Math.max(step, Math.min(w, columns));
  h = Math.max(step, h);
  x = Math.max(0, Math.min(x, columns - w));
  y = Math.max(0, y);
  return { x, y, w, h };
}

/** The grid cell under a drop at (`dx`, `dy`) px from the grid's corner, snapped down to the step. */
export function dropCell(dx: number, dy: number, cw: number, rh: number, step: number): { x: number; y: number } {
  const q = (v: number) => Math.max(0, Math.floor(v / step) * step);
  return { x: q(dx / cw), y: q(dy / rh) };
}

/** A new widget: where it is dropped (what is under it goes down), or under the others. */
export function added(d: Dashboard, kind: WidgetKind, id: string, at?: { x: number; y: number }, target?: string): Widget[] {
  const size = defaultSize(kind);
  const y = at?.y ?? d.widgets.reduce((m, w) => Math.max(m, w.y + w.h), 0);
  const x = Math.max(0, Math.min(at?.x ?? 0, d.columns - size.w));
  return settle([...d.widgets, { id, kind, x, y, ...size, ...(target ? { target } : {}) }], id);
}

/** What a widget drives, chosen in its menu: which of the show's lists it picks from. */
export type TargetList = "looks" | "groups" | "faders" | "snapshots" | "targets" | "positions";
const TARGETS: Partial<Record<WidgetKind, TargetList>> = { look: "looks", "channel-fader": "faders", "group-fader": "groups", xy: "groups", "motion-lock": "groups", colours: "groups", zones: "groups", snapshot: "snapshots", target: "targets", position: "positions" };
export const targetListOf = (kind: WidgetKind): TargetList | undefined => TARGETS[kind];

/** A look or Blackout button: it has a press mode. */
export const pressable = (w: Widget): boolean => w.kind === "look" || w.kind === "blackout";
/** A held button is already deliberate: no second press for momentary ones. */
export const confirmable = (w: Widget): boolean => (pressable(w) && w.mode !== "momentary") || w.kind === "snapshot";
/** A button a finger may hold long for its menu: not what one holds or drags anyway (momentary buttons, faders, pads). */
export const holdable = (w: Widget): boolean => (pressable(w) ? (w.mode ?? "latch") !== "momentary" : ["section", "label", "stop-all", "tap", "song-nav", "snapshot", "position"].includes(w.kind));

/** The colour a widget shows: its own, or its look's for « auto »; a position's button its position's unless « none ». */
export function colorOf(w: Widget, lookSwatch: (id: string) => string | undefined, positionColor: (id: string | undefined) => string | undefined): string | undefined {
  return isHex(w.color) ? w.color : w.kind === "position" ? (w.color === "none" ? undefined : positionColor(w.target)) : w.color === "auto" ? lookSwatch(w.target ?? "") : undefined;
}
/** Neutral, said per kind: a position's button needs « none » (absent is its position's colour). */
export const neutral = (w: Widget): boolean => (w.kind === "position" ? w.color === "none" : !w.color);
export const autoColored = (w: Widget): boolean => w.color === "auto" || (w.kind === "position" && !w.color);
/** What several widgets share for `k` (`fallback` for absent), or undefined when they differ. */
export const shared = <K extends keyof Widget>(k: K, ws: Widget[], fallback?: Widget[K]): Widget[K] | undefined => (new Set(ws.map((w) => w[k] ?? fallback)).size === 1 ? (ws[0]![k] ?? fallback) : undefined);
