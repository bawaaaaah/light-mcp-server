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
 * CC / pitch bend drive a level directly (absolute), with optional pickup (soft takeover).
 */
import { z } from "zod";
import type { MidiMessage } from "./parse.js";

/** The virtual port of the DJ's numbered commands (OS2L `cmd` n → CC n, its 0..1 value → 0..127). */
export const OS2L_PORT = "OS2L";

export const CommandCallSchema = z.object({ command: z.string(), args: z.record(z.unknown()).default({}) });
export type CommandCall = z.infer<typeof CommandCallSchema>;

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
  mode: z.enum(["trigger", "latch", "momentary"]).default("trigger"),
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
    .default({}),
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

interface MappingState {
  active: boolean;
  held: boolean;
  level: number;
  /** pickup: true once the physical control met the current value */
  caught: boolean;
}

export class MidiMapper {
  private mappings: Mapping[] = [];
  private readonly state = new Map<string, MappingState>();

  setMappings(mappings: Mapping[]): void {
    this.mappings = mappings.map((m) => MappingSchema.parse(m));
    for (const id of [...this.state.keys()]) if (!this.mappings.some((m) => m.id === id)) this.state.delete(id);
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
    const out: MappingOutput = { calls: [], feedback: [] };
    for (const m of this.mappings) {
      if (!this.matches(m, msg, port)) continue;
      const s = this.st(m.id);
      const before = { active: s.active, level: s.level };

      if (m.input.type === "cc" || m.input.type === "pitchbend") {
        const raw = msg.type === "cc" ? msg.value : msg.type === "pitchbend" ? msg.value >> 7 : 0;
        const level = scaleValue(raw, m.scale);
        if (m.pickup && !s.caught) {
          if (Math.abs(level - s.level) > 0.03) continue;
          s.caught = true;
        }
        s.level = level;
        s.active = level > 0;
        out.calls.push(withLevel(m.on, m.levelArg, level));
      } else if (m.input.type === "programchange") {
        s.active = true;
        out.calls.push(m.on);
      } else if (msg.type === "noteon") {
        const level = scaleValue(msg.velocity, m.scale);
        if (m.mode === "trigger") {
          s.active = true;
          s.level = level;
          out.calls.push(withLevel(m.on, m.levelArg, level));
        } else if (m.mode === "latch") {
          s.active = !s.active;
          s.level = s.active ? level : 0;
          if (s.active) out.calls.push(withLevel(m.on, m.levelArg, level));
          else if (m.off) out.calls.push(withLevel(m.off, m.levelArg, 0));
        } else {
          // momentary: first press turns on; a re-press while held updates the level only
          s.level = level;
          if (!s.held || m.levelArg) out.calls.push(withLevel(m.on, m.levelArg, level));
          s.held = true;
          s.active = true;
        }
      } else if (msg.type === "noteoff") {
        if (m.mode === "momentary" && s.held) {
          s.held = false;
          s.active = false;
          s.level = 0;
          out.calls.push(m.off ? withLevel(m.off, m.levelArg, 0) : withLevel(m.on, m.levelArg, 0));
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
