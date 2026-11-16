import { useSyncExternalStore } from "react";
import { cmd } from "../api";
import { control } from "../ws";

/** A colour preset as colour.preset.list gives it (T41; docs/specs/presets-songs-notes.md, « Presets de couleur »). */
export interface ColourPresetRow {
  id: string;
  name: string;
  color: string;
  notes?: string;
  /** Stored in the open show, or in the personal library of this machine (every show sees it). */
  origin: "show" | "personal";
  /** A show preset of the id of a personal one: that one is hidden while it is there. */
  over?: "personal";
  /** Its rank among the favourites, carried by the preset (a personal one is a favourite in every show); absent: not one. */
  favorite?: number;
  /** MIDI mappings and song cues naming it. */
  usedBy: string[];
}

export interface ColourPresets {
  presets: ColourPresetRow[];
  /** The favourites the open show sees, in their order (by rank, then name). */
  favorites: ColourPresetRow[];
  loaded: boolean;
}

/** Commands after which the presets or the favourites may have changed (the presets themselves, a show opened or restored, a version put back). */
const PREFIXES = ["colour.preset.", "show.", "history.", "backup.", "midi.mapping.", "song."];
const READS_NOTHING = new Set(["colour.preset.list"]);
const RETRY_MS = 2000;
const EMPTY: ColourPresets = { presets: [], favorites: [], loaded: false };

/**
 * The colour presets, read once for every screen showing them (the Show page, the look editor, the fixture panel, the
 * Live's widgets): one subscription to the commands, one colour.preset.list in flight and one more after it.
 */
class ColourPresetsStore {
  private state: ColourPresets = EMPTY;
  private readonly listeners = new Set<() => void>();
  private reading = false;
  private again = false;
  private stop: (() => void) | undefined;
  private retry: number | undefined;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size) return;
      this.stop?.();
      this.stop = undefined;
      this.again = false;
      window.clearTimeout(this.retry);
      this.retry = undefined;
    };
  };

  get = (): ColourPresets => this.state;

  refresh = (): void => {
    if (this.reading) {
      this.again = true;
      return;
    }
    this.reading = true;
    void cmd<{ presets: ColourPresetRow[]; favorites: string[] }>("colour.preset.list")
      .then((r) => {
        const byId = new Map(r.presets.map((p) => [p.id, p]));
        const next = { presets: r.presets, favorites: r.favorites.flatMap((id) => byId.get(id) ?? []), loaded: true };
        if (JSON.stringify(next) === JSON.stringify(this.state)) return;
        this.state = next;
        for (const fn of [...this.listeners]) fn();
      })
      .catch(() => {
        if (!this.state.loaded && this.listeners.size && this.retry === undefined)
          this.retry = window.setTimeout(() => {
            this.retry = undefined;
            if (this.listeners.size) this.refresh();
          }, RETRY_MS);
      })
      .finally(() => {
        this.reading = false;
        if (this.again && this.listeners.size) {
          this.again = false;
          this.refresh();
        }
      });
  };

  private start(): void {
    const offEvents = control.subscribe("light:command", (d) => {
      const e = d as { name: string; ok: boolean };
      if (e.ok && !READS_NOTHING.has(e.name) && PREFIXES.some((p) => e.name.startsWith(p))) this.refresh();
    });
    const offStatus = control.onStatus((up) => up && this.refresh());
    this.stop = () => {
      offEvents();
      offStatus();
    };
    this.refresh();
  }
}

export const colourPresetsStore = new ColourPresetsStore();

/** Every colour preset the open show sees, and its favourites in their order; `loaded` false until the first answer. */
export function useColourPresets(): ColourPresets & { refresh: () => void } {
  const state = useSyncExternalStore(colourPresetsStore.subscribe, colourPresetsStore.get);
  return { ...state, refresh: colourPresetsStore.refresh };
}

/** The colours applied by hand now (colour.applied): by fixture, by group, and over every fixture. */
export interface ColoursApplied {
  fixtures: Record<string, string>;
  groups: Record<string, string>;
  all?: string;
}

/** Commands after which a colour applied by hand may have come or gone (a look launched takes its fixtures' back). */
const APPLIED_PREFIXES = ["colour.apply", "colour.release", "look.", "panic", "snapshot.", "show.", "backup.", "song."];
const NOTHING_APPLIED: ColoursApplied = { fixtures: {}, groups: {} };

/** The colours applied by hand, read once for every screen that marks them (the widget, the panel, the group menu). */
class AppliedStore {
  private state: ColoursApplied = NOTHING_APPLIED;
  private readonly listeners = new Set<() => void>();
  private reading = false;
  private again = false;
  private stop: (() => void) | undefined;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size) return;
      this.stop?.();
      this.stop = undefined;
      this.again = false;
    };
  };

  get = (): ColoursApplied => this.state;

  refresh = (): void => {
    if (this.reading) {
      this.again = true;
      return;
    }
    this.reading = true;
    void cmd<ColoursApplied>("colour.applied")
      .then((next) => {
        if (JSON.stringify(next) === JSON.stringify(this.state)) return;
        this.state = next;
        for (const fn of [...this.listeners]) fn();
      })
      .catch(() => undefined)
      .finally(() => {
        this.reading = false;
        if (this.again && this.listeners.size) {
          this.again = false;
          this.refresh();
        }
      });
  };

  private start(): void {
    const offEvents = control.subscribe("light:command", (d) => {
      const e = d as { name: string; ok: boolean };
      if (e.ok && e.name !== "colour.applied" && APPLIED_PREFIXES.some((p) => e.name.startsWith(p))) this.refresh();
    });
    const offStatus = control.onStatus((up) => up && this.refresh());
    this.stop = () => {
      offEvents();
      offStatus();
    };
    this.refresh();
  }
}

export const appliedStore = new AppliedStore();

/** The colours applied by hand now (refreshed on the commands that change them). */
export function useColoursApplied(): ColoursApplied {
  return useSyncExternalStore(appliedStore.subscribe, appliedStore.get);
}
