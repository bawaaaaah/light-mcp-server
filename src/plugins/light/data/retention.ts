/**
 * Automatic backups and how long copies are kept (docs/specs/data-cli-sdk.md, « Sauvegardes »).
 * Pure: the plugin lists the files and applies the answer.
 *
 * - One automatic `.lightshow` per show and per day at most, when the show changed since the last
 *   one (or when it has none yet); the newest AUTO_KEEP are kept, older automatic ones go. Backups
 *   made by hand, or before a reset or a restore, are never removed.
 * - The copy kept of every object at each change (FolderStore history) is pruned only when it is
 *   both older than HISTORY_DAYS and beyond the HISTORY_KEEP newest of its store.
 */
export const AUTO_KEEP = 14;
export const HISTORY_DAYS = 90;
export const HISTORY_KEEP = 500;
const DAY_MS = 86_400_000;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** `<show>-YYYY-MM-DD_hh-mm-ss-auto.lightshow`: the stamp sorts as the date. */
const autoName = (show: string) => new RegExp(`^${escape(show)}-(\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2})-auto\\.lightshow$`);

/** The automatic backups of a show, newest first (another show whose id starts the same is not mixed in). */
export function autoBackupsOf(files: string[], show: string): string[] {
  const re = autoName(show);
  return files.filter((f) => re.test(f)).sort((a, b) => b.localeCompare(a));
}

/** When an automatic backup was written, from its name (local time, as the name was made). */
export function autoBackupTime(file: string, show: string): Date | undefined {
  const m = autoName(show).exec(file);
  if (!m) return undefined;
  const [date, time] = m[1]!.split("_") as [string, string];
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const [h, mi, s] = time.split("-").map(Number) as [number, number, number];
  return new Date(y, mo - 1, d, h, mi, s);
}

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** Whether today's automatic backup is due: none yet, or the show changed and the last one is from another day. */
export function autoBackupDue(now: Date, last: Date | undefined, changedSince: boolean): boolean {
  if (!last) return true;
  return changedSince && !sameDay(now, last);
}

/** The automatic backups of a show beyond the newest `keep`. */
export function autoBackupsToPrune(files: string[], show: string, keep = AUTO_KEEP): string[] {
  return autoBackupsOf(files, show).slice(keep);
}

/** When a history entry was written, from its folder name (`2026-10-15T14-27-46-738Z-1a2b3c`, UTC). */
export function historyTime(stamp: string): number | undefined {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(stamp);
  if (!m) return undefined;
  const t = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isNaN(t) ? undefined : t;
}

/** History entries (folder names of one store) old enough and beyond the newest `keep`. */
export function historyToPrune(stamps: string[], now: Date, days = HISTORY_DAYS, keep = HISTORY_KEEP): string[] {
  return stamps
    .map((s) => ({ s, t: historyTime(s) }))
    .filter((x): x is { s: string; t: number } => x.t !== undefined)
    .sort((a, b) => b.t - a.t)
    .slice(keep)
    .filter((x) => now.getTime() - x.t > days * DAY_MS)
    .map((x) => x.s);
}
