/** The day's automatic backup of the open show and venue (data/retention.ts), written only when something changed. */
import { runAutoBackup, type FileServices } from "../commands/file-commands.js";

/** First look for the day's automatic backup after start (a short test server never writes one), then hourly. */
const AUTO_BACKUP_FIRST_MS = 5 * 60_000;
const AUTO_BACKUP_EVERY_MS = 3600_000;

export class AutoBackup {
  private changed = false;
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly files: FileServices) {}

  /** Any change of these stores (a show switch reloads them: a change too) makes the day's automatic backup due. */
  watch(stores: readonly { onChange(fn: () => void): unknown }[]): void {
    for (const store of stores) store.onChange(() => (this.changed = true));
  }

  /** A first look a few minutes in, then every hour. */
  start(check: () => void): void {
    this.timers = [setTimeout(check, AUTO_BACKUP_FIRST_MS), setInterval(check, AUTO_BACKUP_EVERY_MS)];
    for (const t of this.timers) t.unref();
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
  }

  /** Writes the day's automatic backup when due, and prunes old copies; never stops the show for it. */
  run(now: Date): string | undefined {
    try {
      const file = runAutoBackup(this.files, this.changed, now);
      if (file) {
        this.changed = false;
        console.log(`Sauvegarde automatique : data/backups/${file}`);
      }
      return file;
    } catch (err) {
      console.warn(`Sauvegarde automatique impossible : ${(err as Error).message}`);
      return undefined;
    }
  }
}
