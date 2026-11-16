import { useSyncExternalStore } from "react";
import { unlessSame } from "../command-store";
import { createPageStore } from "../page-store";

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
const EMPTY: ColourPresets = { presets: [], favorites: [], loaded: false };

/**
 * The colour presets, read once for every screen showing them (the Show page, the look editor, the fixture panel, the
 * Live's widgets): one subscription to the commands, one colour.preset.list in flight and one more after it.
 */
export const colourPresetsStore = createPageStore<ColourPresets, { presets: ColourPresetRow[]; favorites: string[] }>({
  command: "colour.preset.list",
  initial: EMPTY,
  prefixes: PREFIXES,
  ignore: ["colour.preset.list"],
  loaded: (s) => s.loaded,
  map: (r, previous) => {
    const byId = new Map(r.presets.map((p) => [p.id, p]));
    return unlessSame(previous, { presets: r.presets, favorites: r.favorites.flatMap((id) => byId.get(id) ?? []), loaded: true });
  },
});

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
export const appliedStore = createPageStore<ColoursApplied, ColoursApplied>({
  command: "colour.applied",
  initial: NOTHING_APPLIED,
  prefixes: APPLIED_PREFIXES,
  ignore: ["colour.applied"],
  // the song follower starts a section's look outside any command (review 2, I-1): its look takes its fixtures' colour back
  topics: ["light:song"],
  map: (next, previous) => unlessSame(previous, next),
});

/** The colours applied by hand now (refreshed on the commands that change them). */
export function useColoursApplied(): ColoursApplied {
  return useSyncExternalStore(appliedStore.subscribe, appliedStore.get);
}
