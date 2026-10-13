/**
 * Venue (docs/specs/venue-fixtures-stage.md): fixture definitions, patch, canvases and their
 * rendering onto the venue's kit, and the attribute → DMX conversion.
 *
 * The engine never handles DMX channels: it produces an AttributeFrame (colour per cell, intensity
 * per fixture, raw values for special channels) and the venue converts it. A show written on a
 * canvas therefore plays on another venue's kit unchanged — only the canvas rendering differs.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { FolderStore, Collection } from "../data/store.js";
import { findMode, parseQxf, type ColorComponent, type FixtureDefinition, type FixtureMode } from "./qxf-import.js";

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
}

export const emptyFrame = (): AttributeFrame => ({ colors: new Map(), intensity: new Map(), raw: new Map() });

export interface ResolvedFixture {
  patch: PatchedFixture;
  def: FixtureDefinition;
  mode: FixtureMode;
  /** Head index → component → channel offset. Index -1 holds the components of a head-less fixture. */
  heads: Map<number, Partial<Record<ColorComponent, number>>>;
  dimmers: number[];
  strobes: number[];
}

const sameName = (a: string, b: string) => a.toLowerCase().replace(/[^a-z0-9]/g, "") === b.toLowerCase().replace(/[^a-z0-9]/g, "");

export class Venue {
  readonly definitions: FixtureDefinition[] = [];
  readonly fixtures: Collection<PatchedFixture>;
  readonly canvases: Collection<Canvas>;
  private resolved = new Map<string, ResolvedFixture | { error: string }>();

  constructor(
    readonly store: FolderStore,
    definitionDirs: string[],
  ) {
    for (const dir of definitionDirs) {
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".qxf"))) {
        try {
          this.definitions.push(parseQxf(readFileSync(path.join(dir, f), "utf8")));
        } catch (err) {
          store.loadErrors.push(`définition ${f} : ${(err as Error).message}`);
        }
      }
    }
    this.fixtures = store.collection("fixtures", PatchedFixtureSchema);
    this.canvases = store.collection("canvases", CanvasSchema);
    store.onChange(() => this.resolved.clear());
  }

  definitionFor(manufacturer: string, model: string): FixtureDefinition | undefined {
    return this.definitions.find((d) => sameName(d.manufacturer, manufacturer) && sameName(d.model, model));
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
        mode.channels.forEach((name, offset) => {
          const ch = def.channels.get(name);
          if (ch?.attribute === "intensity") dimmers.push(offset);
          if (ch?.attribute === "strobe") strobes.push(offset);
        });
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
        result = { patch, def, mode, heads, dimmers, strobes };
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
      for (const d of r.dimmers) write(d, intensity * 255);
      const colorScale = hasDimmer ? 1 : intensity;
      const painted = frame.colors.get(patch.id);
      if (painted) {
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
}
