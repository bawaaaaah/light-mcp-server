/**
 * Pinned note registry (docs/specs/midi.md, « Registre de notes »): a note given to an action never
 * changes meaning, so a clip already placed in Ableton keeps triggering the same thing. A released
 * note stays reserved. Collisions are never resolved silently: they throw, for a human decision.
 */
import { z } from "zod";
import { say } from "../../../core/lang.js";

export const BandSchema = z.object({ id: z.string(), from: z.number().int().min(0).max(127), to: z.number().int().min(0).max(127), channel: z.number().int().min(1).max(16).default(1) });
export type Band = z.infer<typeof BandSchema>;

export const NoteRegistrySchema = z.object({
  id: z.literal("notes-registry").default("notes-registry"),
  bands: z.array(BandSchema).default([]),
  /** action key → { band, channel, note } */
  pinned: z.record(z.string(), z.object({ band: z.string(), channel: z.number().int(), note: z.number().int() })).default({}),
  /** notes no longer used but kept reserved: "channel:note" → former action key */
  reserved: z.record(z.string(), z.string()).default({}),
});
export type NoteRegistryData = z.infer<typeof NoteRegistrySchema>;

export class NoteCollision extends Error {}

export class NoteRegistry {
  constructor(readonly data: NoteRegistryData = NoteRegistrySchema.parse({})) {}

  private taken(channel: number): Set<number> {
    const used = new Set<number>();
    for (const p of Object.values(this.data.pinned)) if (p.channel === channel) used.add(p.note);
    for (const key of Object.keys(this.data.reserved)) {
      const [c, n] = key.split(":").map(Number);
      if (c === channel) used.add(n!);
    }
    return used;
  }

  /** Returns the action's pinned note, assigning the first free note of its band if new. */
  assign(actionKey: string, bandId: string): { channel: number; note: number } {
    const band = this.data.bands.find((b) => b.id === bandId);
    if (!band) throw new Error(say(`bande de notes inconnue : ${bandId}`, `unknown note band: ${bandId}`));
    const existing = this.data.pinned[actionKey];
    if (existing) {
      if (existing.band !== bandId || existing.note < band.from || existing.note > band.to) {
        throw new NoteCollision(say(`« ${actionKey} » est épinglé sur la note ${existing.note} (bande ${existing.band}), hors de la bande ${bandId} : arbitrage humain requis`, `“${actionKey}” is pinned on note ${existing.note} (band ${existing.band}), outside band ${bandId}: a person has to decide`));
      }
      return { channel: existing.channel, note: existing.note };
    }
    const used = this.taken(band.channel);
    for (let n = band.from; n <= band.to; n++) {
      if (!used.has(n)) {
        this.data.pinned[actionKey] = { band: bandId, channel: band.channel, note: n };
        return { channel: band.channel, note: n };
      }
    }
    throw new NoteCollision(`bande ${bandId} pleine (${band.from}-${band.to})`);
  }

  /** Pins a precise note (manual choice). Throws if another action holds or reserved it. */
  pin(actionKey: string, bandId: string, note: number): void {
    const band = this.data.bands.find((b) => b.id === bandId);
    if (!band) throw new Error(say(`bande de notes inconnue : ${bandId}`, `unknown note band: ${bandId}`));
    const holder = Object.entries(this.data.pinned).find(([k, p]) => k !== actionKey && p.channel === band.channel && p.note === note);
    if (holder) throw new NoteCollision(say(`la note ${note} est déjà épinglée sur « ${holder[0]} »`, `note ${note} is already pinned on “${holder[0]}”`));
    const reservedFor = this.data.reserved[`${band.channel}:${note}`];
    if (reservedFor && reservedFor !== actionKey) throw new NoteCollision(say(`la note ${note} est réservée (anciennement « ${reservedFor} »)`, `note ${note} is reserved (formerly “${reservedFor}”)`));
    delete this.data.reserved[`${band.channel}:${note}`];
    this.data.pinned[actionKey] = { band: bandId, channel: band.channel, note };
  }

  /** The action disappeared: its note stays reserved so existing clips do not change meaning. */
  release(actionKey: string): void {
    const p = this.data.pinned[actionKey];
    if (!p) return;
    delete this.data.pinned[actionKey];
    this.data.reserved[`${p.channel}:${p.note}`] = actionKey;
  }

  lookup(channel: number, note: number): string | undefined {
    return Object.entries(this.data.pinned).find(([, p]) => p.channel === channel && p.note === note)?.[0];
  }
}
