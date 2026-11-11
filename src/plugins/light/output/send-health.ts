/**
 * Send results per target host over a recent window: a total error counter cannot tell a node that
 * stopped answering from a one-off hiccup, nor which host is the problem. Pure: the clock is passed in,
 * a monotonic one (performance.now()): a wall clock set back would otherwise hold old events in the window.
 */
export const HEALTH_WINDOW_MS = 10_000;
/** Fewest sends in the window before a host can be called failing (a single lost packet says nothing). */
export const HEALTH_MIN_SENDS = 5;
/** A host is failing when more than this share of its sends in the window failed. */
export const HEALTH_FAIL_RATIO = 0.5;

export interface HostHealth {
  host: string;
  sends: number;
  errors: number;
  failing: boolean;
}

export interface HealthOptions {
  windowMs?: number;
  minSends?: number;
  ratio?: number;
}

/** Failing: at least `minSends` sends and more than `ratio` of them failed. */
export function isFailing(sends: number, errors: number, minSends = HEALTH_MIN_SENDS, ratio = HEALTH_FAIL_RATIO): boolean {
  return sends >= minSends && errors > sends * ratio;
}

export class SendHealth {
  private readonly events = new Map<string, { at: number; ok: boolean }[]>();

  constructor(private readonly options: HealthOptions = {}) {}

  record(host: string, ok: boolean, nowMs: number): void {
    const list = this.events.get(host) ?? [];
    this.prune(host, list, nowMs);
    list.push({ at: nowMs, ok });
    this.events.set(host, list);
  }

  /**
   * Keeps the events of the window. The list is in time order unless the clock went back: then the
   * events « after » now date from before the jump and go too, or they would never leave the window.
   */
  private prune(host: string, list: { at: number }[], nowMs: number): void {
    const from = nowMs - (this.options.windowMs ?? HEALTH_WINDOW_MS);
    if (list.length && list[list.length - 1]!.at > nowMs) {
      const kept = list.filter((e) => e.at >= from && e.at <= nowMs);
      list.splice(0, list.length, ...kept);
    }
    let drop = 0;
    while (drop < list.length && list[drop]!.at < from) drop += 1;
    if (drop) list.splice(0, drop);
    if (!list.length) this.events.delete(host);
  }

  /** Every host sent to in the window, with its counts. */
  hosts(nowMs: number): HostHealth[] {
    const out: HostHealth[] = [];
    for (const [host, list] of [...this.events]) {
      this.prune(host, list, nowMs);
      if (!list.length) continue;
      const errors = list.filter((e) => !e.ok).length;
      out.push({ host, sends: list.length, errors, failing: isFailing(list.length, errors, this.options.minSends, this.options.ratio) });
    }
    return out.sort((a, b) => a.host.localeCompare(b.host));
  }
}
