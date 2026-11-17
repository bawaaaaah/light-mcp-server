/**
 * MIDI mapping engine (docs/specs/midi.md): turns normalised MIDI messages into command
 * invocations, according to each mapping's mode, and computes the MIDI feedback to send back.
 * Pure state machine — no I/O, no clock.
 *
 * Modes (a Note On with velocity 0 is a Note Off — already normalised by parseMidi):
 *   trigger   (« Déclencher ») note on → `on` command, always; never turns off. Re-playing the same
 *             note does nothing new; release comes from the exclusive group.
 *   latch     note on toggles on/off; note off ignored.
 *   momentary (« Momentané ») active while held: note on → on (level = velocity); a new note on on
 *             the same note while held updates the level; optional aftertouch follows the level;
 *             note off → off (level 0).
 * CC / pitch bend drive a level directly (absolute), with optional pickup (soft takeover), and
 * follow the same modes as buttons — with a threshold: a CC (or pitch bend) is « engaged » while its
 * raw value is above the mapping's threshold (0..126, 0 by default = immediate), and only then
 * answers. A trigger answers while engaged and releases once below the threshold (the exclusive group
 * for button-like actions, the level for level actions); a latch switches on the idle→engaged edge,
 * follows the level while engaged and releases on the engaged→released edge; a momentary acts while
 * engaged (a fader's travel is its level); toggle flips on every value above the threshold (some
 * controllers send only CC 127, never 0) and releases below it. A released level action rests at the
 * bottom of its scale. The same threshold applies to a note's velocity: a note on at or under it does
 * not answer.
 *
 * A pitch bend to a button action (no level) plays by edges, like a key: one action when the wheel
 * crosses its threshold upwards, one release when it comes back to it or under (a toggle flips on each
 * push). A jump (an automation stepping from 20 to 100) is one push; a value repeated above the
 * threshold (Live's chase) does nothing. The pushed state is kept by mapping and by input port (a
 * keyboard and Live on one channel stay apart); a Start, Continue or Song Position on a port puts its
 * wheels back at rest without a release (the value Live sends next fires again), a port gone forgets them.
 */
import { z } from "zod";
import type { MidiMessage } from "./parse.js";

/** The virtual port of the DJ's numbered commands (OS2L `cmd` n → CC n, its 0..1 value → 0..127). */
export const OS2L_PORT = "OS2L";

export const CommandCallSchema = z.object({ command: z.string(), args: z.record(z.string(), z.unknown()).prefault({}) });
export type CommandCall = z.infer<typeof CommandCallSchema>;

/** A command argument read as an id: strings and numbers as text, anything else as "". */
export const argText = (value: unknown): string => (typeof value === "string" || typeof value === "number" ? String(value) : "");

export const MappingSchema = z.object({
  id: z.string(),
  label: z.string().default(""),
  input: z.object({
    /** Substring of the source/port name; absent = any watched input. */
    port: z.string().optional(),
    type: z.enum(["note", "cc", "programchange", "pitchbend"]),
    channel: z.number().int().min(1).max(16),
    number: z.number().int().min(0).max(127).default(0),
  }),
  mode: z.enum(["trigger", "latch", "momentary", "toggle"]).default("trigger"),
  /** Raw value the input must exceed to answer (CC, pitch bend's top 7 bits, note velocity); 0 = immediate; 127 would never answer. */
  threshold: z.number().min(0).max(126).default(0),
  /** Button: `on` (and `off`) commands. Fader: `on` with the level injected as `levelArg`. */
  on: CommandCallSchema,
  off: CommandCallSchema.optional(),
  /** For level-driven actions: name of the argument receiving the scaled level (0..1). */
  levelArg: z.string().optional(),
  scale: z
    .object({
      inMin: z.number().int().min(0).max(16383).default(0),
      inMax: z.number().int().min(0).max(16383).default(127),
      outMin: z.number().min(0).max(1).default(0),
      outMax: z.number().min(0).max(1).default(1),
      curve: z.enum(["linear", "log", "exp"]).default("linear"),
    })
    .prefault({}),
  followAftertouch: z.boolean().default(false),
  pickup: z.boolean().default(false),
  feedback: z.enum(["none", "note", "cc"]).default("note"),
  danger: z.boolean().default(false),
  notes: z.string().optional(),
});
export type Mapping = z.infer<typeof MappingSchema>;

/** Two mappings with the same key answer the same MIDI message. */
export function mappingInputKey(m: { input: { type: string; channel: number; number?: number; port?: string } }): string {
  return `${m.input.type}:${m.input.channel}:${m.input.number ?? 0}:${m.input.port ?? ""}`;
}

export interface MappingOutput {
  calls: CommandCall[];
  /** The mappings the message matched, with or without a call (a note off in latch matches and does nothing). */
  matched: { id: string; label: string; mode: Mapping["mode"] }[];
  /** Feedback MIDI messages (raw bytes) to send on the feedback port. */
  feedback: number[][];
}

function scaleValue(raw: number, s: Mapping["scale"]): number {
  const t = Math.min(1, Math.max(0, (raw - s.inMin) / Math.max(1, s.inMax - s.inMin)));
  const shaped = s.curve === "log" ? Math.log1p(9 * t) / Math.log(10) : s.curve === "exp" ? (Math.pow(10, t) - 1) / 9 : t;
  return s.outMin + shaped * (s.outMax - s.outMin);
}

function withLevel(call: CommandCall, levelArg: string | undefined, level: number): CommandCall {
  return levelArg ? { command: call.command, args: { ...call.args, [levelArg]: Math.round(level * 1000) / 1000 } } : call;
}

/** A released control rests at the bottom of its scale (outMin), not at a hard 0: an inverted fader rests at its top. */
function restLevel(m: Mapping): number {
  return scaleValue(0, m.scale);
}

/** Releasing a mapping sends its `off`, or a level action back at rest; nothing for a bare button (re-sending `on` would fire it twice). */
function release(m: Mapping, out: MappingOutput): void {
  const rest = restLevel(m);
  const call = m.off ? withLevel(m.off, m.levelArg, rest) : m.levelArg ? withLevel(m.on, m.levelArg, rest) : undefined;
  if (call) out.calls.push(call);
}

interface MappingState {
  active: boolean;
  held: boolean;
  level: number;
  /** pickup: true once the physical control met the current value */
  caught: boolean;
}

/** Between a mapping's id and a port in the keys of `MidiMapper.pushed` (neither carries it). */
const KEY_SEP = "\u0000";

export class MidiMapper {
  private mappings: Mapping[] = [];
  private readonly state = new Map<string, MappingState>();
  /** The pitch bends to a button action pushed above their threshold, by mapping and input port (`id KEY_SEP port`). */
  private readonly pushed = new Set<string>();

  setMappings(mappings: Mapping[]): void {
    this.mappings = mappings.map((m) => MappingSchema.parse(m));
    for (const id of [...this.state.keys()]) if (!this.mappings.some((m) => m.id === id)) this.state.delete(id);
    for (const key of [...this.pushed]) if (!this.mappings.some((m) => key.startsWith(`${m.id}${KEY_SEP}`))) this.pushed.delete(key);
  }

  /** A transport restart on a port (Start, Continue, Song Position): its wheels back at rest, nothing released. */
  rearm(port?: string): void {
    for (const key of [...this.pushed]) if (key.endsWith(`${KEY_SEP}${port ?? ""}`)) this.pushed.delete(key);
  }

  /** An input port gone: its wheels forgotten; every port's when none is given (the MIDI profile changed). */
  forgetPort(port?: string): void {
    if (port === undefined) this.pushed.clear();
    else this.rearm(port);
  }

  list(): Mapping[] {
    return this.mappings;
  }

  private st(id: string): MappingState {
    let s = this.state.get(id);
    if (!s) this.state.set(id, (s = { active: false, held: false, level: 0, caught: true }));
    return s;
  }

  private matches(m: Mapping, msg: MidiMessage, port?: string): boolean {
    if (m.input.port && port && !port.toLowerCase().includes(m.input.port.toLowerCase())) return false;
    // the DJ's commands (OS2L, as CCs on that port) answer only mappings made for them
    if (port === OS2L_PORT && m.input.port?.toLowerCase() !== OS2L_PORT.toLowerCase()) return false;
    switch (m.input.type) {
      case "note":
        return (
          (msg.type === "noteon" || msg.type === "noteoff" || msg.type === "polyaftertouch") && msg.channel === m.input.channel && msg.note === m.input.number
        ) || (msg.type === "channelaftertouch" && msg.channel === m.input.channel && m.followAftertouch);
      case "cc":
        return msg.type === "cc" && msg.channel === m.input.channel && msg.controller === m.input.number;
      case "programchange":
        return msg.type === "programchange" && msg.channel === m.input.channel && msg.program === m.input.number;
      case "pitchbend":
        return msg.type === "pitchbend" && msg.channel === m.input.channel;
    }
  }

  private feedbackFor(m: Mapping, s: MappingState): number[][] {
    if (m.feedback === "none") return [];
    const value = Math.round((s.active ? (m.levelArg ? s.level : 1) : 0) * 127);
    const ch = m.input.channel - 1;
    if (m.feedback === "cc") return [[0xb0 | ch, m.input.number, value]];
    return value > 0 ? [[0x90 | ch, m.input.number, value]] : [[0x80 | ch, m.input.number, 0]];
  }

  handle(msg: MidiMessage, port?: string): MappingOutput {
    const out: MappingOutput = { calls: [], feedback: [], matched: [] };
    // the transport restarted on this port (Live's play, a locate): the value it sends next is a new push
    if (msg.type === "start" || msg.type === "continue" || msg.type === "songposition") {
      this.rearm(port);
      return out;
    }
    for (const m of this.mappings) {
      if (!this.matches(m, msg, port)) continue;
      out.matched.push({ id: m.id, label: m.label, mode: m.mode });
      const s = this.st(m.id);
      const before = { active: s.active, level: s.level };
      // a note in « toggle » is a latch: each note on above the threshold flips it
      const mode = m.mode === "toggle" ? "latch" : m.mode;

      if (m.input.type === "pitchbend" && !m.levelArg && msg.type === "pitchbend") {
        // a wheel to a button: by edges, by port (a jump is one push, a repeated value nothing new)
        const key = `${m.id}${KEY_SEP}${port ?? ""}`;
        const engaged = msg.value >> 7 > m.threshold;
        if (engaged === this.pushed.has(key)) continue;
        if (engaged) {
          this.pushed.add(key);
          s.active = m.mode === "toggle" ? !s.active : true;
          s.level = s.active ? 1 : restLevel(m);
          if (s.active) out.calls.push(m.on);
          else release(m, out);
        } else {
          this.pushed.delete(key);
          // back at rest: released, except a toggle (its next push switches it)
          if (m.mode !== "toggle" && s.active) {
            s.active = false;
            s.level = restLevel(m);
            release(m, out);
          }
        }
      } else if (m.input.type === "cc" || m.input.type === "pitchbend") {
        const raw = msg.type === "cc" ? msg.value : msg.type === "pitchbend" ? msg.value >> 7 : 0;
        const level = scaleValue(raw, m.scale);
        if (m.pickup && !s.caught) {
          if (Math.abs(level - s.level) > 0.03) continue;
          s.caught = true;
        }
        const engaged = raw > m.threshold; // the raw value is the control's own domain (CC: 0..127)
        const rest = restLevel(m);
        switch (m.mode) {
          case "latch": {
            // the CC is a switch: above the threshold it is latched on, below it latched off
            if (engaged && !s.active) {
              s.active = true;
              s.level = level;
              out.calls.push(withLevel(m.on, m.levelArg, level));
            } else if (!engaged && s.active) {
              s.active = false;
              s.level = rest;
              release(m, out);
            } else if (engaged) {
              s.level = level; // latched: the level follows the control, and so does a level action
              if (m.levelArg) out.calls.push(withLevel(m.on, m.levelArg, level));
            }
            break;
          }
          case "momentary": {
            // engaged while held (above the threshold): a fader's travel is its level
            if (engaged) {
              const first = !s.held;
              s.held = true;
              s.active = true;
              s.level = level;
              if (first || m.levelArg) out.calls.push(withLevel(m.on, m.levelArg, level));
            } else if (s.held) {
              s.held = false;
              s.active = false;
              s.level = rest;
              release(m, out);
            }
            break;
          }
          case "trigger": {
            // trigger « Déclencher »: above the threshold the CC answers with its level, straight away,
            // and never latches; crossing below it releases the action once (exclusive group for
            // button-like actions, the level itself for level actions: a released fader rests)
            if (engaged) {
              s.active = true;
              s.level = level;
              out.calls.push(withLevel(m.on, m.levelArg, level));
            } else if (s.active) {
              s.active = false;
              s.level = rest;
              release(m, out);
            }
            break;
          }
          case "toggle": {
            // « Toggle »: every value above the threshold toggles the switch — on, then off, then on.
            // A value below the threshold does nothing: returning to 0 must not release nor toggle it,
            // so a CC button (127 then 0) toggles on its next activation above the threshold instead of
            // being released by its own fall.
            if (engaged) {
              s.active = !s.active;
              s.level = s.active ? level : rest;
              if (s.active) out.calls.push(withLevel(m.on, m.levelArg, level));
              else release(m, out);
            }
            break;
          }
        }
      } else if (m.input.type === "programchange") {
        // a program change carries only a high value: in « trigger » mode it always fires (unchanged),
        // in every other mode it toggles the action on (first receipt) and off (second receipt)
        if (m.mode === "trigger") {
          s.active = true;
          s.level = 1;
          out.calls.push(m.on);
        } else {
          s.active = !s.active;
          s.level = s.active ? 1 : restLevel(m);
          if (s.active) out.calls.push(m.on);
          else release(m, out);
        }
      } else if (msg.type === "noteon") {
        // a note on at or under the threshold (a light hit) does not answer
        if (msg.velocity > m.threshold) {
          const level = scaleValue(msg.velocity, m.scale);
          if (mode === "trigger") {
            s.active = true;
            s.level = level;
            out.calls.push(withLevel(m.on, m.levelArg, level));
          } else if (mode === "latch") {
            s.active = !s.active;
            s.level = s.active ? level : restLevel(m);
            if (s.active) out.calls.push(withLevel(m.on, m.levelArg, level));
            else release(m, out);
          } else {
            // momentary: first press turns on; a re-press while held updates the level only
            s.level = level;
            if (!s.held || m.levelArg) out.calls.push(withLevel(m.on, m.levelArg, level));
            s.held = true;
            s.active = true;
          }
        }
      } else if (msg.type === "noteoff") {
        if (m.mode === "momentary" && s.held) {
          s.held = false;
          s.active = false;
          s.level = restLevel(m);
          release(m, out);
        }
      } else if ((msg.type === "polyaftertouch" || msg.type === "channelaftertouch") && m.mode === "momentary" && m.followAftertouch && s.held) {
        const level = scaleValue(msg.pressure, m.scale);
        s.level = level;
        out.calls.push(withLevel(m.on, m.levelArg, level));
      }

      if (before.active !== s.active || before.level !== s.level) out.feedback.push(...this.feedbackFor(m, s));
    }
    return out;
  }

  /**
   * Re-syncs a mapping's state from the outside (UI, OSC, MCP, timeline changed the target) and
   * returns the feedback to send: feedback reflects every change, whatever its origin.
   */
  syncState(mappingId: string, active: boolean, level?: number): number[][] {
    const m = this.mappings.find((x) => x.id === mappingId);
    if (!m) return [];
    const s = this.st(mappingId);
    const nextLevel = level ?? (active ? 1 : 0);
    if (s.active === active && s.level === nextLevel) return [];
    s.active = active;
    s.level = nextLevel;
    if (m.pickup) s.caught = false;
    return this.feedbackFor(m, s);
  }

  /** Feedback of every mapping's current state (resync controllers another program has written to). */
  allFeedback(): number[][] {
    return this.mappings.flatMap((m) => this.feedbackFor(m, this.st(m.id)));
  }
}
