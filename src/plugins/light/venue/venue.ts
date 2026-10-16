/**
 * Venue (docs/specs/venue-fixtures-stage.md): fixture definitions, patch, canvases and their
 * rendering onto the venue's kit, and the attribute → DMX conversion.
 *
 * The engine never handles DMX channels: it produces an AttributeFrame (colour per cell, intensity
 * per fixture, raw values for special channels) and the venue converts it. A show written on a
 * canvas therefore plays on another venue's kit unchanged — only the canvas rendering differs.
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { FolderStore, Collection } from "../data/store.js";
import { findDefinition, findMode, parseQxf, type ColorComponent, type FixtureDefinition, type FixtureMode } from "./qxf-import.js";
import type { Position } from "../engine/move.js";
import { displayHex } from "../engine/display.js";
import { patchOverlaps, overlapMessage, type PatchedRange } from "./patch-check.js";

export const PatchedFixtureSchema = z.object({
  id: z.string(),
  name: z.string(),
  manufacturer: z.string(),
  model: z.string(),
  mode: z.string(),
  universe: z.number().int().min(1),
  address: z.number().int().min(1).max(512), // 1-based DMX start address
  role: z.string().optional(),
  tags: z.array(z.string()).default([]),
  position: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional(),
  mount: z.enum(["floor", "stand", "truss", "hung", "wall", "pillar", "ceiling"]).optional(),
  /** Zone the fixture aims at (stage model). */
  target: z.string().optional(),
  /** Moving heads: orientation and calibration (docs/specs/venue-fixtures-stage.md, « Lyres »). */
  orientation: z
    .object({
      /** Heading of the fixture's front, degrees from the audience, clockwise seen from above. */
      yaw: z.number().default(0),
      invertPan: z.boolean().default(false),
      invertTilt: z.boolean().default(false),
      swapPanTilt: z.boolean().default(false),
      /** Calibration offsets in degrees. */
      panOffset: z.number().default(0),
      tiltOffset: z.number().default(0),
    })
    .optional(),
  notes: z.string().optional(),
});
export type PatchedFixture = z.infer<typeof PatchedFixtureSchema>;

/** One canvas cell's target: a fixture head (or the whole fixture when it has no heads). */
export const CellTargetSchema = z.object({ fixture: z.string(), head: z.number().int().min(-1).default(-1) });

export const CanvasSchema = z.object({
  id: z.string(),
  name: z.string(),
  topology: z.enum(["line", "line-mirror", "ring", "grid", "free"]).default("line"),
  cells: z.number().int().min(1).max(4096),
  /** Grid only. */
  columns: z.number().int().min(1).optional(),
  /** Rendering on this venue's kit: cell index → targets (a cell can drive several heads). */
  render: z.array(z.object({ from: z.number().int().min(0), to: z.number().int().min(0), targets: z.array(CellTargetSchema) })).default([]),
  notes: z.string().optional(),
});
export type Canvas = z.infer<typeof CanvasSchema>;

export type Color = Partial<Record<ColorComponent, number>>; // components 0..1

export interface AttributeFrame {
  /** fixtureId → head (-1 = whole fixture) → colour */
  colors: Map<string, Map<number, Color>>;
  /** fixtureId → intensity 0..1 (from groups/masters; default 1) */
  intensity: Map<string, number>;
  /** fixtureId → channel offset (0-based in the mode) → raw DMX value */
  raw: Map<string, Map<number, number>>;
  /** fixtureId → logical pan/tilt (0..1, 0.5 = centre); moving heads not listed rest at the centre. */
  positions: Map<string, Position>;
}

export const emptyFrame = (): AttributeFrame => ({ colors: new Map(), intensity: new Map(), raw: new Map(), positions: new Map() });

/** A 8- or 16-bit channel pair. */
export interface CoarseFine {
  coarse: number;
  fine?: number;
}

export interface ResolvedFixture {
  patch: PatchedFixture;
  def: FixtureDefinition;
  mode: FixtureMode;
  /** Head index → component → channel offset. Index -1 holds the components of a head-less fixture. */
  heads: Map<number, Partial<Record<ColorComponent, number>>>;
  dimmers: number[];
  strobes: number[];
  /** Moving heads: pan/tilt channels and travel in degrees (540/270 when the definition is silent). */
  pan?: CoarseFine;
  tilt?: CoarseFine;
  panMax: number;
  tiltMax: number;
  /** Colour wheel: channel offset and its coloured slots. */
  wheel?: { offset: number; slots: { value: number; color: Color }[] };
  /** Shutter channels and their « open » value, written when nothing else drives them. */
  shutterOpen: Map<number, number>;
  /** No colour mixing: the painted colour's level drives the dimmer (lamp + wheel, plain dimmer). */
  lampOnly: boolean;
}

const hexColor = (hex: string): Color => ({ red: parseInt(hex.slice(1, 3), 16) / 255, green: parseInt(hex.slice(3, 5), 16) / 255, blue: parseInt(hex.slice(5, 7), 16) / 255 });
const levelOf = (c: Color) => Math.max(0, ...Object.values(c).map((v) => v ?? 0));

/** Wheel slot closest to a colour (by chromaticity, the level goes to the dimmer). */
function nearestSlot(slots: { value: number; color: Color }[], c: Color): number {
  const norm = (x: Color) => {
    const l = levelOf(x) || 1;
    return [(x.red ?? 0) + (x.white ?? 0), (x.green ?? 0) + (x.white ?? 0), (x.blue ?? 0) + (x.white ?? 0)].map((v) => v / l);
  };
  const target = norm(c);
  let best = slots[0]!;
  let bestD = Infinity;
  for (const slot of slots) {
    const d = norm(slot.color).reduce((acc, v, i) => acc + (v - target[i]!) ** 2, 0);
    if (d < bestD) [best, bestD] = [slot, d];
  }
  return best.value;
}


export class Venue {
  readonly definitions: FixtureDefinition[] = [];
  readonly fixtures: Collection<PatchedFixture>;
  readonly canvases: Collection<Canvas>;
  private resolved = new Map<string, ResolvedFixture | { error: string }>();
  /** Names, sizes and dates of the .qxf files last read, and the errors they gave. */
  private definitionStamp = "";
  private definitionErrors: string[] = [];

  constructor(
    readonly store: FolderStore,
    private definitionDirs: string[],
  ) {
    this.refreshDefinitions();
    this.fixtures = store.collection("fixtures", PatchedFixtureSchema);
    this.canvases = store.collection("canvases", CanvasSchema);
    store.onChange(() => this.resolved.clear());
  }

  /** Points the venue at another folder (the venue of another show) and reads it. */
  retarget(root: string, backupRoot: string | undefined, definitionDirs: string[]): void {
    this.definitionDirs = definitionDirs;
    this.definitionStamp = "";
    this.definitionErrors = [];
    this.store.retarget(root, backupRoot);
    this.refreshDefinitions();
  }

  /**
   * Reads the .qxf folders again when a file was added, removed or changed since the last read: a
   * definition dropped into data/fixtures/ while the server runs is used by the next import or
   * library listing, without a restart. Cheap when nothing changed (one stat per file).
   */
  refreshDefinitions(): void {
    const files = this.definitionDirs.flatMap((dir) =>
      existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith(".qxf")).map((f) => path.join(dir, f)) : [],
    );
    const stamp = files
      .map((f) => {
        const st = statSync(f);
        return `${f}:${st.size}:${st.mtimeMs}`;
      })
      .join("\n");
    if (stamp === this.definitionStamp) return;
    this.definitionStamp = stamp;
    this.definitions.length = 0;
    this.store.loadErrors.splice(0, this.store.loadErrors.length, ...this.store.loadErrors.filter((e) => !this.definitionErrors.includes(e)));
    this.definitionErrors = [];
    for (const f of files) {
      try {
        this.definitions.push(parseQxf(readFileSync(f, "utf8")));
      } catch (err) {
        this.definitionErrors.push(`définition ${path.basename(f)} : ${(err as Error).message}`);
      }
    }
    this.store.loadErrors.push(...this.definitionErrors);
    this.resolved.clear();
  }

  definitionFor(manufacturer: string, model: string): FixtureDefinition | undefined {
    return findDefinition(this.definitions, manufacturer, model);
  }

  /**
   * What is wrong with a channel given by fixture + offset (raw channels of faders and looks):
   * unpatched fixture, or a channel beyond its mode. Without a definition the count is unknown: fine.
   */
  channelProblem(c: { fixture: string; offset: number }): string | undefined {
    if (!this.fixtures.get(c.fixture)) return `projecteur inconnu ${c.fixture}`;
    const r = this.resolve(c.fixture);
    if (!("error" in r) && c.offset >= r.mode.channels.length) return `${c.fixture} n'a que ${r.mode.channels.length} canaux (canal ${c.offset + 1} demandé)`;
    return undefined;
  }

  /** Each patched fixture's DMX footprint (one channel when its definition is missing). */
  patchRanges(): PatchedRange[] {
    return this.fixtures.list().map((f) => {
      const r = this.resolve(f.id);
      return { id: f.id, name: f.name, universe: f.universe, address: f.address, channels: "error" in r ? 1 : r.mode.channels.length, kind: `${f.manufacturer}|${f.model}|${f.mode}` };
    });
  }

  /** Channels shared by two fixtures (twins on one address aside), each said as people read it. */
  patchProblems(onlyFor?: string): { a: string; b: string; universe: number; from: number; to: number; message: string }[] {
    const name = (id: string) => this.fixtures.get(id)?.name ?? id;
    return patchOverlaps(this.patchRanges())
      .filter((o) => !onlyFor || o.a === onlyFor || o.b === onlyFor)
      .map((o) => ({ ...o, message: overlapMessage(o, name) }));
  }

  /** Patched fixtures whose definition (.qxf) is not in the library: their channels are not decoded. */
  missingDefinitions(): { id: string; name: string; model: string }[] {
    return this.fixtures.list().flatMap((f) => {
      const r = this.resolve(f.id);
      return "error" in r ? [{ id: f.id, name: f.name, model: `${f.manufacturer} ${f.model} (${f.mode})` }] : [];
    });
  }

  resolve(fixtureId: string): ResolvedFixture | { error: string } {
    const cached = this.resolved.get(fixtureId);
    if (cached) return cached;
    const patch = this.fixtures.get(fixtureId);
    let result: ResolvedFixture | { error: string };
    if (!patch) result = { error: `fixture inconnue : ${fixtureId}` };
    else {
      const def = this.definitionFor(patch.manufacturer, patch.model);
      const mode = def ? findMode(def, patch.mode) : undefined;
      if (!def || !mode) result = { error: `définition manquante : ${patch.manufacturer} ${patch.model} (${patch.mode})` };
      else {
        const heads = new Map<number, Partial<Record<ColorComponent, number>>>();
        const dimmers: number[] = [];
        const strobes: number[] = [];
        const shutterOpen = new Map<number, number>();
        let pan: CoarseFine | undefined;
        let tilt: CoarseFine | undefined;
        let wheel: ResolvedFixture["wheel"];
        mode.channels.forEach((name, offset) => {
          const ch = def.channels.get(name);
          if (ch?.attribute === "intensity") dimmers.push(offset);
          if (ch?.attribute === "strobe") {
            strobes.push(offset);
            const open = ch.capabilities.find((c) => /ShutterOpen/.test(c.preset ?? "") || /^(shutter )?open$/i.test(c.name));
            if (open) shutterOpen.set(offset, open.min);
          }
          if (ch?.attribute === "pan" || ch?.attribute === "tilt") {
            const pair = ch.attribute === "pan" ? (pan ??= { coarse: -1 }) : (tilt ??= { coarse: -1 });
            if (ch.fine) pair.fine ??= offset;
            else if (pair.coarse < 0) pair.coarse = offset;
          }
          if (ch?.attribute === "colorWheel" && !wheel) {
            const slots = ch.capabilities.filter((c) => c.color).map((c) => ({ value: c.min, color: hexColor(c.color!) }));
            if (slots.length) wheel = { offset, slots };
          }
        });
        if (pan && pan.coarse < 0) pan = undefined;
        if (tilt && tilt.coarse < 0) tilt = undefined;
        if (mode.heads.length) {
          mode.heads.forEach((offsets, h) => {
            const comps: Partial<Record<ColorComponent, number>> = {};
            for (const off of offsets) {
              const c = def.channels.get(mode.channels[off] ?? "")?.color;
              if (c && comps[c] === undefined) comps[c] = off;
            }
            heads.set(h, comps);
          });
        } else {
          const comps: Partial<Record<ColorComponent, number>> = {};
          mode.channels.forEach((name, off) => {
            const c = def.channels.get(name)?.color;
            if (c && comps[c] === undefined) comps[c] = off;
          });
          heads.set(-1, comps);
        }
        const lampOnly = [...heads.values()].every((c) => Object.keys(c).length === 0);
        result = { patch, def, mode, heads, dimmers, strobes, pan, tilt, panMax: mode.panMax ?? def.panMax ?? 540, tiltMax: mode.tiltMax ?? def.tiltMax ?? 270, wheel, shutterOpen, lampOnly };
      }
    }
    this.resolved.set(fixtureId, result);
    return result;
  }

  /** Targets of each cell of a canvas (index → targets). */
  cellTargets(canvasId: string): { fixture: string; head: number }[][] {
    const canvas = this.canvases.get(canvasId);
    if (!canvas) throw new Error(`canevas inconnu : ${canvasId}`);
    const cells: { fixture: string; head: number }[][] = Array.from({ length: canvas.cells }, () => []);
    for (const r of canvas.render) for (let i = r.from; i <= Math.min(r.to, canvas.cells - 1); i++) cells[i]!.push(...r.targets.map((t) => ({ fixture: t.fixture, head: t.head })));
    return cells;
  }

  /** Writes canvas cell colours into a frame. */
  paintCanvas(frame: AttributeFrame, canvasId: string, cellColors: (Color | null)[]): void {
    const targets = this.cellTargets(canvasId);
    cellColors.forEach((color, i) => {
      if (!color) return;
      for (const t of targets[i] ?? []) {
        let heads = frame.colors.get(t.fixture);
        if (!heads) frame.colors.set(t.fixture, (heads = new Map()));
        heads.set(t.head, color);
      }
    });
  }

  /**
   * Converts an attribute frame to DMX. Dimmer channels carry the intensity; fixtures without a
   * dimmer get their colours scaled instead ("scènes sans intensité": the level always comes from
   * the masters). A fixture written as a whole (head -1) paints every head.
   */
  toDmx(frame: AttributeFrame, buffers: Uint8Array[]): string[] {
    const errors: string[] = [];
    for (const patch of this.fixtures.list()) {
      const r = this.resolve(patch.id);
      if ("error" in r) {
        if (frame.colors.has(patch.id) || frame.raw.has(patch.id)) errors.push(r.error);
        continue;
      }
      const buf = buffers[patch.universe - 1];
      if (!buf) continue;
      const base = patch.address - 1;
      const write = (offset: number, value: number) => {
        const i = base + offset;
        if (i >= 0 && i < 512) buf[i] = Math.max(0, Math.min(255, Math.round(value)));
      };
      const intensity = frame.intensity.get(patch.id) ?? 1;
      const hasDimmer = r.dimmers.length > 0;
      const painted = frame.colors.get(patch.id);
      for (const [off, v] of r.shutterOpen) write(off, v);
      if (r.lampOnly) {
        // Lamp-only fixtures are lit by what the looks paint on them, at its level.
        const color = painted?.get(-1) ?? painted?.values().next().value;
        for (const d of r.dimmers) write(d, color ? intensity * levelOf(color) * 255 : 0);
        if (r.wheel && color) write(r.wheel.offset, nearestSlot(r.wheel.slots, color));
      } else for (const d of r.dimmers) write(d, intensity * 255);
      const colorScale = hasDimmer ? 1 : intensity;
      if (r.pan || r.tilt) this.writePosition(r, frame.positions.get(patch.id) ?? { pan: 0.5, tilt: 0.5 }, write);
      if (painted && !r.lampOnly) {
        for (const [h, comps] of r.heads) {
          const color = painted.get(h) ?? painted.get(-1);
          if (!color) continue;
          for (const [comp, off] of Object.entries(comps) as [ColorComponent, number][]) write(off, (color[comp] ?? 0) * 255 * colorScale);
        }
      }
      for (const [off, v] of frame.raw.get(patch.id) ?? []) write(off, v);
    }
    return errors;
  }

  /** Logical position → pan/tilt channels (inversion, swap, 16-bit). */
  private writePosition(r: ResolvedFixture, p: Position, write: (offset: number, value: number) => void): void {
    const o = r.patch.orientation;
    let pan = o?.invertPan ? 1 - p.pan : p.pan;
    let tilt = o?.invertTilt ? 1 - p.tilt : p.tilt;
    if (o?.swapPanTilt) [pan, tilt] = [tilt, pan];
    const put = (ch: CoarseFine | undefined, v: number) => {
      if (!ch) return;
      const v16 = Math.round(Math.max(0, Math.min(1, v)) * 65535);
      write(ch.coarse, v16 >> 8);
      if (ch.fine !== undefined) write(ch.fine, v16 & 255);
    };
    put(r.pan, pan);
    put(r.tilt, tilt);
  }

  /**
   * What each fixture shows, read back from the DMX output (after rules, console parks and
   * Blackout): one screen colour per head (or one for a head-less fixture), dimmer applied.
   * For the live 2D preview.
   */
  displayColors(buffers: readonly Uint8Array[]): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const patch of this.fixtures.list()) {
      const r = this.resolve(patch.id);
      const buf = buffers[patch.universe - 1];
      if ("error" in r || !buf) continue;
      const at = (off: number) => (buf[patch.address - 1 + off] ?? 0) / 255;
      const dimmer = r.dimmers.length ? Math.max(...r.dimmers.map(at)) : 1;
      if (r.lampOnly) {
        if (!r.dimmers.length) continue;
        let color: Color = { white: 1 };
        if (r.wheel) {
          const v = buf[patch.address - 1 + r.wheel.offset] ?? 0;
          const slot = [...r.wheel.slots].reverse().find((s) => v >= s.value);
          if (slot) color = slot.color;
        }
        out[patch.id] = [displayHex(Object.fromEntries(Object.entries(color).map(([k, x]) => [k, (x ?? 0) * dimmer])) as Color)];
        continue;
      }
      out[patch.id] = [...r.heads.values()].map((comps) => {
        const c: Color = {};
        for (const [comp, off] of Object.entries(comps) as [ColorComponent, number][]) c[comp] = at(off) * dimmer;
        return displayHex(c);
      });
    }
    return out;
  }

  /** DMX slots (0-based, per universe) holding pan/tilt: kept on Blackout so heads do not swing. */
  positionSlots(): Map<number, number[]> {
    const out = new Map<number, number[]>();
    for (const patch of this.fixtures.list()) {
      const r = this.resolve(patch.id);
      if ("error" in r) continue;
      const offs = [r.pan?.coarse, r.pan?.fine, r.tilt?.coarse, r.tilt?.fine].filter((x): x is number => x !== undefined);
      if (!offs.length) continue;
      const list = out.get(patch.universe) ?? [];
      list.push(...offs.map((o) => patch.address - 1 + o));
      out.set(patch.universe, list);
    }
    return out;
  }
}
