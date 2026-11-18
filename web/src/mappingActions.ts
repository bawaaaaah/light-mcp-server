/**
 * What a MIDI mapping does, as the editor offers it (docs/specs/midi.md): the action and its target read back from a
 * mapping, and the on/off commands built from them. Pure: shared by the mapping editor and the widget menu, and
 * tested without a browser.
 */
import { plain } from "./plain.js";

/** The input types a mapping answers (midi/mapping.ts `MappingSchema`). */
export const MIDI_TYPES = ["note", "cc", "programchange", "pitchbend"] as const;
export type MidiType = (typeof MIDI_TYPES)[number];

/** What midi.learn answers (commands/midi-commands.ts): a note, a CC, a program change or a pitch bend (number 0), with the port it came on. */
export interface LearntInput {
  type: MidiType;
  channel: number;
  number: number;
  port: string;
}

export interface MappingDraft {
  id: string;
  label: string;
  input: { type: MidiType; channel: number; number: number; port?: string };
  mode: "trigger" | "latch" | "momentary" | "toggle";
  /** Raw value a CC (or a note's velocity) must exceed to answer (0..126); 0 = immediate. */
  threshold?: number;
  /** A CC in « toggle » or « trigger »: an equal value within 150 ms of the one before is ignored (midi/mapping.ts). */
  ignoreRepeats?: boolean;
  on: { command: string; args: Record<string, unknown> };
  off?: { command: string; args: Record<string, unknown> };
  levelArg?: string;
  /** The raw range mapped to a level (midi/mapping.ts `scale`): a wheel's range reads `inMin` (`wheelRangeOf`). */
  scale?: { inMin?: number; inMax?: number; outMin?: number; outMax?: number; curve?: "linear" | "log" | "exp" };
  feedback: "none" | "note" | "cc";
}
/** A CC or a pitch bend answers every value above its threshold, like a fader (midi/mapping.ts); a note or a program change is a press. */
export const answersEveryValue = (type: MidiType): boolean => type === "cc" || type === "pitchbend";

/** A wheel at rest sends its centre (8192), 64 in the top 7 bits the threshold reads: above it, the wheel is pushed. */
export const PITCHBEND_REST = 64;

/** What a pitch bend takes away from an input with a number, given back when another type is chosen again. */
export interface KeptInput {
  number: number;
  threshold: number;
  feedback: MappingDraft["feedback"];
  /** The scale's raw start: a wheel's « upper half » (64) must not stay on a note's velocity. */
  inMin: number;
}
export const keptOf = (m: MappingDraft): KeptInput => ({ number: m.input.number, threshold: m.threshold ?? 0, feedback: m.feedback, inMin: m.scale?.inMin ?? 0 });

/** Actions whose control is a level (its value scaled, `levelArg`), not a button. */
export const isLevelAction = (action: Action): boolean => action === "dca" || action === "fader" || action === "grandmaster";

/**
 * A pitch bend's threshold for an action: a button answers above the wheel's rest (else the wheel at rest is engaged: a
 * flash stuck on), a level follows the whole wheel (0: the rest is no step to jump). A threshold chosen for a button is kept.
 */
export const bendThreshold = (threshold: number | undefined, action: Action): number => (isLevelAction(action) ? 0 : threshold || PITCHBEND_REST);

/**
 * The draft with another input type. A pitch bend is the channel's wheel: number 0 (the mapper ignores it), its threshold
 * (`bendThreshold`), no LED feedback (it would go to note 0). Back from a pitch bend, the number, threshold, feedback and
 * scale start it had before (`kept`) return.
 */
export function withInputType(m: MappingDraft, type: MidiType, action: Action, kept: KeptInput = keptOf(m)): MappingDraft {
  if (type === "pitchbend") return { ...m, input: { ...m.input, type, number: 0 }, threshold: bendThreshold(m.threshold, action), feedback: "none" };
  if (m.input.type !== "pitchbend") return { ...m, input: { ...m.input, type } };
  return { ...m, input: { ...m.input, type, number: kept.number }, threshold: kept.threshold, feedback: kept.feedback, ...(m.scale ? { scale: { ...m.scale, inMin: kept.inMin } } : {}) };
}

/**
 * How a wheel drives a level (decision of 2026-11-17): « upper », its upper half (centre = 0 %, top = 100 %, the lower half
 * does nothing), by default; « full », its whole travel (bottom = 0 %, centre = 50 %, top = 100 %). Stored as the scale's
 * raw start (`scale.inMin`, 64 or 0, on the top 7 bits); any other start, written by hand, is « custom » and left as it is.
 */
export type WheelRange = "upper" | "full" | "custom";
export function wheelRangeOf(m: MappingDraft): WheelRange {
  const inMin = m.scale?.inMin ?? 0;
  return inMin === PITCHBEND_REST ? "upper" : inMin === 0 ? "full" : "custom";
}
export const withWheelRange = (m: MappingDraft, range: WheelRange): MappingDraft => (range === "custom" ? m : { ...m, scale: { ...m.scale, inMin: range === "upper" ? PITCHBEND_REST : 0 } });

/** Actions offered; the editor builds the on/off commands and the level argument from them. */
export const ACTIONS = ["look", "dca", "grandmaster", "fader", "flash", "section", "program", "snapshot", "song.next", "song.prev", "setlist.next", "setlist.prev", "look.stopall", "tempo.tap", "panic", "blackout", "freeze", "position", "colour"] as const;
export type Action = (typeof ACTIONS)[number];
/** Target meaning « no program » (program.select with id null). */
export const NO_PROGRAM = "-";

export function actionOf(m: MappingDraft): { action: Action; target: string } {
  const id = plain(m.on.args.id);
  if (m.on.command === "look.go") return { action: "look", target: id };
  if (m.on.command === "group.level") return { action: "dca", target: id };
  if (m.on.command === "fader.level") return { action: "fader", target: id };
  if (m.on.command === "grandmaster.set") return { action: "grandmaster", target: "" };
  if (m.on.command === "group.flash") return { action: "flash", target: id };
  if (m.on.command === "snapshot.recall") return { action: "snapshot", target: plain(m.on.args.id) };
  // a named position (T32): a recall, nothing to switch off
  if (m.on.command === "position.preset.go") return { action: "position", target: plain(m.on.args.id) };
  // a saved colour applied by hand (T41): to a group's fixtures, or every fixture (the group is read by colourGroupOf)
  if (m.on.command === "colour.apply") return { action: "colour", target: plain(m.on.args.id) };
  if (m.on.command === "program.select") return { action: "program", target: m.on.args.id === null ? NO_PROGRAM : plain(m.on.args.id) };
  // « Figer les lyres » (T26): every head, or a group's
  if (m.on.command === "motion.freeze") return { action: "freeze", target: plain(m.on.args.group) };
  if (m.on.command === "song.section.go") return { action: "section", target: `${plain(m.on.args.song)}/${plain(m.on.args.section)}` };
  return { action: (ACTIONS as readonly string[]).includes(m.on.command) ? (m.on.command as Action) : "look", target: "" };
}

/** The group a colour mapping colours (T41), empty for every fixture. */
export const colourGroupOf = (m: MappingDraft): string => (m.on.command === "colour.apply" ? plain(m.on.args.group) : "");

/** `colourGroup`: for the « colour » action, the group whose fixtures it colours ("" = every fixture; absent: the mapping's own). */
export function build(m: MappingDraft, action: Action, target: string, colourGroup?: string): MappingDraft {
  const base = { ...m, off: undefined, levelArg: undefined, threshold: m.threshold ?? 0 };
  switch (action) {
    case "look":
      return { ...base, on: { command: "look.go", args: { id: target } }, off: m.mode === "trigger" ? undefined : { command: "look.stop", args: { id: target } } };
    case "dca":
      return { ...base, on: { command: "group.level", args: { id: target } }, levelArg: "level" };
    case "fader":
      return { ...base, on: { command: "fader.level", args: { id: target } }, levelArg: "level" };
    case "grandmaster":
      return { ...base, on: { command: "grandmaster.set", args: {} }, levelArg: "level" };
    case "flash":
      // from a note, held while pressed; a CC or a pitch bend keeps its mode (a button may toggle or hold it, as the mapper plays it)
      return { ...base, mode: answersEveryValue(m.input.type) ? m.mode : "momentary", on: { command: "group.flash", args: { id: target, on: true } }, off: { command: "group.flash", args: { id: target, on: false } } };
    case "section": {
      const [song, section] = target.split("/");
      return { ...base, on: { command: "song.section.go", args: { song, section } } };
    }
    case "program":
      return { ...base, mode: "trigger", on: { command: "program.select", args: { id: target === NO_PROGRAM ? null : target } } };
    case "snapshot":
      return { ...base, mode: "trigger", on: { command: "snapshot.recall", args: { id: target } } };
    case "position":
      return { ...base, mode: "trigger", on: { command: "position.preset.go", args: { id: target } } };
    case "colour": {
      // the fixtures it colours: the group the editor chose (colourGroup), else the one the mapping had, else all
      const group = colourGroup ?? colourGroupOf(m);
      return { ...base, mode: "trigger", on: { command: "colour.apply", args: { id: target, ...(group ? { group } : {}) } } };
    }
    case "blackout":
      return { ...base, on: { command: "blackout", args: { on: true } }, off: m.mode === "trigger" ? undefined : { command: "blackout", args: { on: false } } };
    case "freeze": {
      // « Figer les lyres » (T26): every head, a group, or the fixtures of a mapping written by hand (kept, as its level)
      const prev = m.on.command === "motion.freeze" ? m.on.args : {};
      const scope = target ? { group: target } : Array.isArray(prev.fixtures) ? { fixtures: prev.fixtures } : {};
      const level = prev.level === "hard" ? { level: "hard" } : {};
      if (m.mode === "trigger") {
        // a note (or a program change) in « Déclencher »: each press switches (the server's toggle); a CC answers every
        // value above its threshold (a pitch bend too), a toggle would flicker the lock: a CC only freezes (decision I3)
        return { ...base, on: { command: "motion.freeze", args: { ...scope, ...level, ...(answersEveryValue(m.input.type) ? {} : { toggle: true }) } } };
      }
      // « Bascule », « Marche / arrêt », « Momentané »: freeze when it turns on, unfreeze when it turns off (the mapping
      // engine alternates on and off); from MIDI the unfreeze loosens only a soft lock (decision V1)
      return { ...base, on: { command: "motion.freeze", args: { ...scope, ...level } }, off: { command: "motion.unfreeze", args: { ...scope } } };
    }
    default:
      return { ...base, on: { command: action, args: {} } };
  }
}

export const newMapping = (): MappingDraft => ({ id: "", label: "", input: { type: "note", channel: 1, number: 36 }, mode: "trigger", on: { command: "look.go", args: { id: "" } }, feedback: "note" });

