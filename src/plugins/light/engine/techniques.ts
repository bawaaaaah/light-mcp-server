/**
 * Parametric techniques (docs/specs/engine-effects-timing.md, « Bibliothèque de techniques »):
 * each one generates the sequence of canvas states (one colour per cell, per step). Pure
 * functions — the player handles timing, attack and order.
 *
 * Mirror: on a `line-mirror` canvas, techniques paint the left half and fold it (cell k = cell
 * n-1-k), so colour radiates from the centre, like the user's own generator.
 */
import { z } from "zod";
import type { Color } from "../venue/venue.js";
import { say } from "../../../core/lang.js";

export type CellState = Color | null; // null: cell not driven by this technique
export type Step = CellState[];

export const TechniqueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("plat"), color: z.string() }),
  z.object({ kind: z.literal("damier"), colors: z.tuple([z.string(), z.string()]), block: z.number().int().min(1).default(4) }),
  z.object({
    kind: z.literal("palette"),
    colors: z.array(z.string()).min(3),
    block: z.number().int().min(1).default(4),
    /** Each block draws its colour at random at every step, instead of the hues turning in order. */
    random: z.boolean().optional(),
  }),
  z.object({ kind: z.literal("creux"), colors: z.tuple([z.string(), z.string()]), block: z.number().int().min(1).default(4), width: z.number().int().min(1).default(1), floor: z.number().min(0).max(1).default(0) }),
  z.object({
    kind: z.literal("masques"),
    colors: z.tuple([z.string(), z.string()]),
    block: z.number().int().min(1).default(4),
    /** One string per step: "#" lit, "-" off, one char per block (or per cell). */
    masks: z.array(z.string()).min(1),
    floor: z.number().min(0).max(1).default(0),
  }),
  z.object({
    kind: z.literal("masques-colores"),
    block: z.number().int().min(1).default(4),
    /** Letter → colour (or null = off). */
    map: z.record(z.string(), z.string().nullable()),
    patterns: z.array(z.string()).min(1),
  }),
  z.object({ kind: z.literal("respiration"), colors: z.array(z.string()).min(1), steps: z.number().int().min(2).default(4), depth: z.number().min(0).max(1).default(0.3) }),
  z.object({ kind: z.literal("orage"), base: z.string(), flash: z.string().default("#ffff28"), calm: z.number().int().min(1).default(30), strikes: z.number().int().min(1).default(12) }),
  z.object({ kind: z.literal("flamme"), colors: z.array(z.string()).min(1), steps: z.number().int().min(2).default(9) }),
  z.object({ kind: z.literal("flash"), color: z.string().default("#ffffff"), steps: z.number().int().min(1).default(4) }),
  /**
   * Waveform effect (grandMA-like phaser on colour level): each cell's level follows a waveform;
   * `spread` = phase spread across the canvas in cycles, `blocks` groups cells, `wings` mirrors the
   * phase from the centre. `resolution` frames per cycle — the player's cadence sets the speed
   * (e.g. every 1/4 beat × 16 frames = one cycle per 4 beats).
   */
  z.object({
    kind: z.literal("onde"),
    colors: z.array(z.string()).min(1),
    wave: z.enum(["sine", "triangle", "saw", "ramp", "square", "random"]).default("sine"),
    depth: z.number().min(0).max(1).default(1),
    spread: z.number().min(0).max(4).default(1),
    blocks: z.number().int().min(1).default(1),
    wings: z.boolean().default(false),
    reverse: z.boolean().default(false),
    /** The blocks take their phase in a shuffled order rather than along the canvas (grandMA « shuffle »). */
    shuffle: z.boolean().optional(),
    resolution: z.number().int().min(2).max(64).default(16),
  }),
  /** No colour: the look only moves heads (position presets, Move FX). */
  z.object({ kind: z.literal("aucune") }),
  /** Imported or hand-made raw steps (hex per cell, "-" for off, "" for untouched). */
  z.object({ kind: z.literal("pas"), steps: z.array(z.array(z.string())).min(1) }),
]);
export type Technique = z.infer<typeof TechniqueSchema>;

/** "#ff960f" or "#ff960f+w40" → colour (0..1 components). */
export function hexToColor(hex: string): Color {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})(?:\+w(\d{1,3}))?$/i.exec(hex.trim());
  if (!m) throw new Error(say(`couleur invalide : ${hex}`, `invalid colour: ${hex}`));
  const c: Color = { red: parseInt(m[1]!, 16) / 255, green: parseInt(m[2]!, 16) / 255, blue: parseInt(m[3]!, 16) / 255 };
  if (m[4]) c.white = Number(m[4]) / 255;
  return c;
}

export const OFF: Color = { red: 0, green: 0, blue: 0, white: 0 };

export function scaleColor(c: Color, k: number): Color {
  return Object.fromEntries(Object.entries(c).map(([key, v]) => [key, (v ?? 0) * k])) as Color;
}

/** Deterministic pseudo-random (mulberry32) so a technique renders the same steps every time. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 0..n-1 in a shuffled order, the same for the same `n` and `seed` (Fisher-Yates). */
export function shuffled(n: number, seed: number): number[] {
  const r = rng(seed);
  const out = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** A seed from text, so the same choices draw the same way every time. */
export function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Steps drawn at random: enough for no repeat to be heard, looped by the player like any other. */
const RANDOM_STEPS = 16;

function fold(half: CellState[], cells: number): Step {
  return Array.from({ length: cells }, (_, k) => half[k < cells / 2 ? k : cells - 1 - k] ?? null);
}

/** Paints one value per block across `n` cells. */
function byBlock(n: number, block: number, colorOfBlock: (b: number) => CellState): CellState[] {
  return Array.from({ length: n }, (_, k) => colorOfBlock(Math.floor(k / block)));
}

/** Generates the steps of a technique for a canvas of `cells` cells. */
export function generateSteps(t: Technique, cells: number, mirror: boolean): Step[] {
  const span = mirror ? Math.ceil(cells / 2) : cells;
  const out = (half: CellState[]): Step => (mirror ? fold(half, cells) : half);
  switch (t.kind) {
    case "plat":
      return [Array.from({ length: cells }, () => hexToColor(t.color))];
    case "damier": {
      const [a, b] = t.colors.map(hexToColor) as [Color, Color];
      return [0, 1].map((swap) => out(byBlock(span, t.block, (blk) => ((blk + swap) % 2 === 0 ? a : b))));
    }
    case "palette": {
      const cols = t.colors.map(hexToColor);
      if (t.random) {
        // each block draws a colour of the palette, never the one it has: still never dark
        const r = rng(seedOf(t.colors.join()) + span);
        const blocks = Math.ceil(span / t.block);
        let last = Array.from({ length: blocks }, (_, b) => b % cols.length);
        return Array.from({ length: RANDOM_STEPS }, () => {
          last = last.map((c) => (c + 1 + Math.floor(r() * (cols.length - 1))) % cols.length);
          return out(byBlock(span, t.block, (blk) => cols[last[blk]!]!));
        });
      }
      // Each block takes a hue shifted by one per step; nothing ever goes dark.
      return cols.map((_, step) => out(byBlock(span, t.block, (blk) => cols[(blk + step) % cols.length]!)));
    }
    case "creux": {
      // Rotation breaks the mirror on purpose: the travelling hole carries the energy.
      const [a, b] = t.colors.map(hexToColor) as [Color, Color];
      const blocks = Math.ceil(cells / t.block);
      return Array.from({ length: blocks }, (_, step) =>
        byBlock(cells, t.block, (blk) => {
          const base = blk % 2 === 0 ? a : b;
          return (blk - step + blocks) % blocks < t.width ? scaleColor(base, t.floor) : base;
        }),
      );
    }
    case "masques": {
      const [a, b] = t.colors.map(hexToColor) as [Color, Color];
      return t.masks.map((mask) => {
        const m = mask.replace(/\s/g, "");
        const perCell = m.length >= span;
        return out(
          Array.from({ length: span }, (_, k) => {
            const blk = Math.floor(k / t.block);
            const lit = (perCell ? m[k] : m[blk]) !== "-";
            const base = blk % 2 === 0 ? a : b;
            return lit ? base : scaleColor(base, t.floor);
          }),
        );
      });
    }
    case "masques-colores":
      return t.patterns.map((pattern) => {
        const p = pattern.replace(/\s/g, "");
        return byBlock(cells, t.block, (blk) => {
          const hex = t.map[p[blk % p.length] ?? ""];
          return hex ? hexToColor(hex) : OFF;
        });
      });
    case "respiration": {
      const cols = t.colors.map(hexToColor);
      return Array.from({ length: t.steps }, (_, step) => {
        const phase = step / t.steps;
        return out(
          Array.from({ length: span }, (_, k) => {
            const c = cols[(k + step) % cols.length]!;
            const level = 1 - t.depth * (0.5 + 0.5 * Math.cos(2 * Math.PI * (phase + k / Math.max(1, span))));
            return scaleColor(c, level);
          }),
        );
      });
    }
    case "orage": {
      const base = hexToColor(t.base);
      const flash = hexToColor(t.flash);
      const calmStep: Step = Array.from({ length: cells }, () => base);
      const r = rng(cells * 7919 + t.strikes);
      const strikes = Array.from({ length: t.strikes }, () => {
        const target = Math.floor(r() * cells);
        return calmStep.map((c, k) => (k === target ? flash : c));
      });
      return [...Array.from({ length: t.calm }, () => calmStep), ...strikes];
    }
    case "flamme": {
      const cols = t.colors.map(hexToColor);
      const r = rng(cells * 104729 + t.steps);
      return Array.from({ length: t.steps }, () => Array.from({ length: cells }, () => scaleColor(cols[Math.floor(r() * cols.length)]!, 0.55 + 0.45 * r())));
    }
    case "flash": {
      const c = hexToColor(t.color);
      return Array.from({ length: t.steps }, (_, s) => Array.from({ length: cells }, () => (s % 2 === 0 ? c : OFF)));
    }
    case "onde": {
      const cols = t.colors.map(hexToColor);
      const r = rng(cells * 31 + t.resolution);
      const randomTable = Array.from({ length: t.resolution }, () => r());
      const wave = (phase: number): number => {
        const p = ((phase % 1) + 1) % 1;
        switch (t.wave) {
          case "sine":
            return 0.5 - 0.5 * Math.cos(2 * Math.PI * p);
          case "triangle":
            return p < 0.5 ? p * 2 : 2 - p * 2;
          case "saw":
            return 1 - p;
          case "ramp":
            return p;
          case "square":
            return p < 0.5 ? 1 : 0;
          case "random":
            return randomTable[Math.floor(p * t.resolution)]!;
        }
      };
      const groups = Math.ceil(cells / t.blocks);
      const ranks = Math.max(1, t.wings ? Math.ceil(groups / 2) : groups);
      const order = t.shuffle ? shuffled(ranks, seedOf(t.colors.join()) + ranks) : undefined;
      return Array.from({ length: t.resolution }, (_, frame) =>
        Array.from({ length: cells }, (_, k) => {
          let g = Math.floor(k / t.blocks);
          if (t.wings) g = Math.min(g, groups - 1 - g);
          const offset = ((order ? order[g]! : g) / ranks) * t.spread;
          const phase = frame / t.resolution + (t.reverse ? offset : -offset);
          const level = 1 - t.depth + t.depth * wave(phase);
          return scaleColor(cols[g % cols.length]!, level);
        }),
      );
    }
    case "aucune":
      return [Array.from({ length: cells }, () => null)];
    case "pas":
      return t.steps.map((row) => Array.from({ length: cells }, (_, k) => {
        const v = row[k] ?? "";
        return v === "" ? null : v === "-" ? OFF : hexToColor(v);
      }));
  }
}
