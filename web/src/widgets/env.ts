/**
 * What a dashboard widget is given by its page: the lists and live topics the page reads once for all its widgets, the
 * commands, the rights, and the press helpers shared by the buttons (one button armed at a time on the page).
 */
import type { Dispatch, SetStateAction } from "react";
import type { HoverPeek } from "../components/HoverPeek";
import type { PadFixture, PadZone } from "../components/TargetPad";
import type { ZoneChip } from "../components/XyPad";
import type { ExclusiveSet } from "../components/WidgetMenu";
import type { FixtureFunctions } from "../fader-functions";
import type { KnowledgeIntentions } from "../intentions";
import type { Widget } from "../dashboard-layout";
import type { Smoothing } from "../components/SmoothingField";

export interface Look {
  id: string;
  name: string;
  /** The colour that sums the look up (look.list), for « auto » buttons. */
  swatch?: string;
  active: boolean;
  danger: boolean;
  manualOnly: boolean;
  tags: string[];
}
export interface Group {
  id: string;
  name: string;
  exclusive?: boolean;
  members?: { looks: string[] };
  master?: { level: number; mute: boolean; smoothing?: Smoothing };
  limits?: { min?: number; max?: number; mode?: "clamp" | "scale" };
  effectiveLevel: number;
}
export interface ChannelFader {
  id: string;
  name: string;
  level: number;
  channels: { fixture: string; offset: number }[];
  range?: { min: number; max: number };
  smoothing?: Smoothing;
}
export interface Tempo {
  bpm: number;
  source: string;
  clockMissing: boolean;
  beats: number;
  /** MIDI clock ticks arrive (Ableton plays), followed or not. */
  clock?: boolean;
}
export interface SongState {
  song?: string;
  section?: string;
}
/** Levels of the smoothed faders still on their way (topic light:glide). */
export interface Glide {
  groups: Record<string, number>;
  faders: Record<string, number>;
  gm?: number;
}
export interface LightState {
  blackout: boolean;
  panicUndo?: boolean;
  grandMaster?: number;
  grandMasterSmoothed?: boolean;
}

export interface WidgetEnv {
  /** Arranging the widgets: the controls do not play. */
  edit: boolean;
  may: (right: string) => boolean;
  /** A control whose command the role may not run is shown, greyed, rather than refused on use. */
  locked: (right: string) => { disabled?: boolean; title?: string };
  /** Runs a command, asking again when a rule wants a confirmation; an error goes to the page's bar. */
  run: (name: string, args?: unknown) => Promise<unknown>;
  onError: (message: string) => void;
  state: LightState | null;
  tempo: Tempo | null;
  song: SongState;
  glide: Glide;
  /** The grand master as dragged, until the server says it (a fader must not jump back mid-gesture). */
  gm: number | null;
  setGm: (level: number) => void;
  lookById: Map<string, Look>;
  groupById: Map<string, Group>;
  /** The groups are read (none read yet: a widget's group is not said deleted). */
  groupsRead: boolean;
  setGroups: Dispatch<SetStateAction<Group[]>>;
  faders: ChannelFader[];
  setFaders: Dispatch<SetStateAction<ChannelFader[]>>;
  snapshots: { id: string; name: string }[];
  fixtureChannels: FixtureFunctions[];
  zoneChips: ZoneChip[];
  targetStage: { fixtures: PadFixture[]; zones: PadZone[] };
  stageBeams: boolean;
  knowledge: KnowledgeIntentions | null;
  setOf: (look: string | undefined) => ExclusiveSet | undefined;
  hoverPeek: HoverPeek;
  previewFirst: boolean;
  /** Opens a look's preview before its launch: what to show, and what starting it runs. */
  preview: (look: { id: string; name: string; fire: () => void }) => void;
  /** The button armed by a first press (« À confirmer »), if any. */
  armed: string | null;
  /** Fires at once, or arms the button `id` and fires on its second press. */
  confirmed: (id: string | undefined, fire: () => void) => void;
}

export interface WidgetProps {
  w: Widget;
  env: WidgetEnv;
}
