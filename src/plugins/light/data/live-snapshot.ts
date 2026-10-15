/**
 * Resume after a restart (docs/specs/data-cli-sdk.md, « Reprise »): what is playing (looks,
 * Blackout, setlist/song/section) is written about once a second; at start-up it is restored only
 * when it is recent — a crash or a quick restart during a service resumes, a restart the next day
 * does not light the stage by surprise.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const LiveSnapshotSchema = z.object({
  at: z.number(),
  show: z.string(),
  looks: z.array(z.string()).default([]),
  blackout: z.boolean().default(false),
  setlist: z.string().optional(),
  song: z.string().optional(),
  section: z.string().optional(),
  /** Active rule program. */
  program: z.string().optional(),
});
export type LiveSnapshot = z.infer<typeof LiveSnapshotSchema>;

/** Five minutes: long enough for a crash and a restart, short enough not to surprise the next day. */
export const RESUME_MAX_AGE_MS = 5 * 60_000;

export class LiveSnapshotFile {
  private last = "";
  private lastAt = 0;

  constructor(
    readonly file: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Writes the snapshot when it changed (atomic rename); the time stamp is refreshed at most every 30 s otherwise. */
  save(s: Omit<LiveSnapshot, "at">): void {
    const key = JSON.stringify(s);
    const t = this.now();
    if (key === this.last && t - this.lastAt < 30_000) return;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...s, at: t }, null, 2));
    renameSync(tmp, this.file);
    this.last = key;
    this.lastAt = t;
  }

  /** The snapshot of this show when it is recent enough to resume, else undefined. */
  load(show: string, maxAgeMs = RESUME_MAX_AGE_MS): LiveSnapshot | undefined {
    try {
      const s = LiveSnapshotSchema.parse(JSON.parse(readFileSync(this.file, "utf8")));
      return s.show === show && this.now() - s.at <= maxAgeMs ? s : undefined;
    } catch {
      return undefined;
    }
  }
}
