/**
 * The manual colour layer of the runtime (T41, docs/specs/presets-songs-notes.md, « Appliquer une couleur »): the
 * colours applied by hand, one per fixture, above the looks until released, the Panic or a new look on them. The
 * fades themselves are pure (show/manual-colour.ts); this keeps the entries and lays them over a composed frame.
 */
import type { AttributeFrame, Color, Venue } from "../venue/venue.js";
import { gone, hueUnderManual, MANUAL_COLOUR_FADE_MS, manualColourOf, nextManual, settled, underManual, type ManualColour } from "./manual-colour.js";
import type { Look } from "./model.js";

/** What the colour layer reads of the show runtime. */
export interface ColourHost {
  /** The runtime clock. */
  now(): number;
  /** The cells of a canvas and the patch: which fixtures a look paints, which fixtures exist. */
  readonly venue: Pick<Venue, "cellTargets" | "fixtures">;
  /** The fixtures a look leaves out (the groups whose presets exclude it). */
  excludedFrom(look: Look): ReadonlySet<string>;
  /** The looks playing, then those still fading out on exit. */
  lightingLooks(): Iterable<Look>;
}

export class ColourLayer {
  /** Colours applied by hand (show/manual-colour.ts): above the looks, one per fixture, until released. */
  private readonly manualColours = new Map<string, ManualColour>();

  constructor(private readonly host: ColourHost) {}

  /**
   * Applies a colour by hand to fixtures (the manual colour layer): it replaces the colour the looks paint there, at
   * the brightness they paint it, fading from what showed (`fadeMs`) — until `release`, the Panic or a new look on
   * them. `hex` null releases. Returns the fixtures it changed.
   */
  set(fixtures: readonly string[], hex: string | null, fadeMs: number = MANUAL_COLOUR_FADE_MS): string[] {
    const now = this.host.now();
    const to = hex === null ? null : manualColourOf(hex);
    const done: string[] = [];
    for (const f of fixtures) {
      const prev = this.manualColours.get(f);
      if (hex === null && !prev) continue;
      if (prev && prev.hex === hex && settled(prev, now)) {
        done.push(f);
        continue;
      }
      this.manualColours.set(f, nextManual(prev, to, hex, now, fadeMs));
      done.push(f);
    }
    return done;
  }

  /** Gives the looks their colour back on these fixtures (every fixture holding one when none is given), fading. */
  release(fixtures?: Iterable<string>, fadeMs: number = MANUAL_COLOUR_FADE_MS): string[] {
    const ids = fixtures ? [...fixtures].filter((f) => this.manualColours.get(f)?.to) : [...this.manualColours].filter(([, m]) => m.to).map(([f]) => f);
    return this.set(ids, null, fadeMs);
  }

  /** A look launched (or launched again) takes back the fixtures it paints (decisions C2, T41): their colour fades back to the looks. */
  releaseUnder(look: Look): string[] {
    return this.release(this.fixturesPainted(look));
  }

  /** Drops every manual colour at once (the Panic: safety first, no fade). */
  clear(): string[] {
    const ids = [...this.manualColours].filter(([, m]) => m.to).map(([f]) => f);
    this.manualColours.clear();
    return ids;
  }

  /** Forgets every entry, fading or not (another show opens). */
  reset(): void {
    this.manualColours.clear();
  }

  /** Drops the entries whose fade back to the looks is over: on a real frame only (strictBounds samples ahead, I1). */
  prune(now: number): void {
    for (const [f, m] of this.manualColours) if (gone(m, now)) this.manualColours.delete(f);
  }

  /**
   * Whether a look playing (or still fading out) paints a fixture (review 2, I-2): a colour applied by hand shows only
   * where a look lights it (decision C1). Read from the looks themselves, not from one frame's level: a chase or a
   * flash dark at that instant still lights the fixture.
   */
  paintedByLooks(fixture: string): boolean {
    return [...this.host.lightingLooks()].some((l) => this.fixturesPainted(l).has(fixture));
  }

  /** The colour a fixture holds by hand (`#rrggbb`), if any (a release fading out holds none). */
  colourOf(fixture: string): string | undefined {
    return this.manualColours.get(fixture)?.hex ?? undefined;
  }

  /** The colours held by hand now, by fixture: a release fading out holds none. */
  held(): Record<string, string> {
    return Object.fromEntries([...this.manualColours].flatMap(([f, m]) => (m.hex ? [[f, m.hex] as const] : [])));
  }

  /** Puts colours held by hand back (panic.undo), at once (review 2 m1: the undo puts back what showed, without a fade). */
  restore(colours: Record<string, string>): string[] {
    const done: string[] = [];
    const known = new Set(this.host.venue.fixtures.list().map((f) => f.id));
    for (const [f, hex] of Object.entries(colours)) if (known.has(f)) done.push(...this.set([f], hex, 0));
    return done;
  }

  /** The manual colours over what the looks paint on this frame: their colours, their wheels' hues, their tracks' layers. */
  apply(frame: AttributeFrame, now: number): void {
    if (!this.manualColours.size) return;
    const heads = (f: string, colors: ReadonlyMap<number, Color>, at = underManual): Map<number, Color> => {
      const m = this.manualColours.get(f)!;
      return new Map([...colors].map(([h, c]) => [h, at(m, c, now)]));
    };
    for (const f of this.manualColours.keys()) {
      const colors = frame.colors.get(f);
      if (colors) frame.colors.set(f, heads(f, colors));
      const by = frame.paintedBy.get(f);
      // the wheel's slot follows the hue, never a mix of two (it switches at mid-fade); its level follows the heads
      if (by) frame.paintedBy.set(f, by.map((p) => ({ ...p, heads: heads(f, p.heads), hues: heads(f, p.hues ?? p.heads, hueUnderManual) })));
      for (const layer of frame.tracks.get(f) ?? []) if (layer.colors) layer.colors = heads(f, layer.colors);
    }
  }

  /** The fixtures a look paints: its canvas's, but those its groups exclude. */
  private fixturesPainted(look: Look): Set<string> {
    const out = new Set<string>();
    if (look.technique.kind === "aucune") return out; // it only moves heads: their colour stays
    try {
      for (const cell of this.host.venue.cellTargets(look.canvas)) for (const t of cell) out.add(t.fixture);
    } catch {
      return out; // an unknown canvas paints nothing
    }
    for (const f of this.host.excludedFrom(look)) out.delete(f);
    return out;
  }
}
