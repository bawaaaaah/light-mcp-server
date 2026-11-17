/**
 * What a MIDI mapping does, as the editor offers it (docs/specs/midi.md): the action and its target read back from a
 * mapping, and the on/off commands built from them. Pure: shared by the mapping editor and the widget menu, and
 * tested without a browser.
 */
import { plain } from "./plain.js";

/** What midi.learn answers (commands/midi-commands.ts): a note, a CC or a program change, with the port it came on. */
export interface LearntInput {
  type: "note" | "cc" | "programchange";
  channel: number;
  number: number;
  port: string;
}

export interface MappingDraft {
  id: string;
  label: string;
  input: { type: "note" | "cc" | "programchange" | "pitchbend"; channel: number; number: number; port?: string };
  mode: "trigger" | "latch" | "momentary" | "toggle";
  /** Raw value a CC (or a note's velocity) must exceed to answer (0..126); 0 = immediate. */
  threshold?: number;
  on: { command: string; args: Record<string, unknown> };
  off?: { command: string; args: Record<string, unknown> };
  levelArg?: string;
  feedback: "none" | "note" | "cc";
}
/** The input types a mapping answers (midi/mapping.ts `MappingSchema`). */
export const MIDI_TYPES = ["note", "cc", "programchange", "pitchbend"] as const satisfies readonly MappingDraft["input"]["type"][];

/** A CC or a pitch bend answers every value above its threshold, like a fader (midi/mapping.ts); a note or a program change is a press. */
export const answersEveryValue = (type: MappingDraft["input"]["type"]): boolean => type === "cc" || type === "pitchbend";

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
      return { ...base, mode: "momentary", on: { command: "group.flash", args: { id: target, on: true } }, off: { command: "group.flash", args: { id: target, on: false } } };
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

