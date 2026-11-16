/**
 * A store of the web read by one command and kept fresh by the command events (T44): the named positions, the colour
 * presets and the colours applied, the targets. One subscription to the commands while someone listens, one read in
 * flight and at most one more after it, a first read that failed tried again, and the listeners told only when the
 * state really changed. Pure: the command, the control channel and the timers are given (page-store.ts in a page), so
 * it runs without one.
 */

/** What the store reads through: `cmd` of api.ts and `control` of ws.ts in a page. */
export interface CommandStoreDeps<H = unknown> {
  cmd: <T>(name: string, args?: unknown) => Promise<T>;
  control: {
    subscribe: (topic: string, handler: (data: unknown) => void) => () => void;
    onStatus: (fn: (up: boolean) => void) => () => void;
  };
  setTimer: (fn: () => void, ms: number) => H;
  clearTimer: (handle: H) => void;
}

/** A read finished: its number (reads are numbered as they start) and how to ask for one more after it. */
export interface ReadContext {
  read: number;
  readAgain: () => void;
}

export interface CommandStoreOptions<State, Answer> {
  /** The command that reads the state (`position.preset.list`). */
  command: string;
  initial: State;
  /** Successful commands after which it reads again: those starting with one of these. */
  prefixes: readonly string[];
  /** Commands among them that change nothing it shows (the read itself, a recall). */
  ignore?: readonly string[];
  /** Other control topics after which it reads again, whatever they carry. */
  topics?: readonly string[];
  /** A successful command handled otherwise (a burst of target.set): true when it was. Asked before `prefixes`. */
  onCommand?: (name: string) => boolean;
  /**
   * The next state from an answer: `previous` itself when nothing changed (nobody is told). Called only while the
   * store knows nothing newer than this read.
   */
  map: (answer: Answer, previous: State, context: ReadContext) => State;
  /** Given: a first read that failed is tried again after `retryMs`, while someone listens, until this is true. */
  loaded?: (state: State) => boolean;
  retryMs?: number;
  /** Nobody listens any more (a timer of its own to clear). */
  onStop?: () => void;
}

export interface CommandStore<State> {
  subscribe: (listener: () => void) => () => void;
  get: () => State;
  /** Reads again now (after a command this screen sent: its answer is awaited, the event may come later). */
  refresh: () => void;
  /** Puts a state known otherwise (a command's answer); the listeners told when it is another object. */
  set: (state: State) => void;
  /** The number of the latest read started (0: none yet). */
  lastRead: () => number;
}

/** A first read that failed (the server restarting, a lost link) is tried again after this long. */
export const RETRY_MS = 2000;

export function createCommandStore<State, Answer, H = unknown>(options: CommandStoreOptions<State, Answer>, deps: CommandStoreDeps<H>): CommandStore<State> {
  const { command, prefixes, topics = [], onCommand, map, loaded, retryMs = RETRY_MS, onStop } = options;
  const ignore = new Set(options.ignore ?? []);
  const listeners = new Set<() => void>();
  let state = options.initial;
  let reading = false;
  let again = false;
  let started = 0;
  let retry: { handle: H } | undefined;
  let stop: (() => void) | undefined;

  const set = (next: State): void => {
    if (next === state) return;
    state = next;
    for (const fn of [...listeners]) fn();
  };

  const scheduleRetry = (): void => {
    // never read yet: tried again, or the screens would wait on « … » for good
    if (!loaded || loaded(state) || !listeners.size || retry) return;
    retry = {
      handle: deps.setTimer(() => {
        retry = undefined;
        if (listeners.size) refresh();
      }, retryMs),
    };
  };

  const refresh = (): void => {
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    const read = ++started;
    void deps
      .cmd<Answer>(command)
      .then((answer) => set(map(answer, state, { read, readAgain: () => (again = true) })))
      .catch(scheduleRetry)
      .finally(() => {
        reading = false;
        if (again && listeners.size) {
          again = false;
          refresh();
        }
      });
  };

  const start = (): void => {
    const offs = [
      deps.control.subscribe("light:command", (data) => {
        const e = data as { name: string; ok: boolean };
        if (!e.ok || onCommand?.(e.name)) return;
        if (!ignore.has(e.name) && prefixes.some((p) => e.name.startsWith(p))) refresh();
      }),
      ...topics.map((topic) => deps.control.subscribe(topic, () => refresh())),
      deps.control.onStatus((up) => up && refresh()),
    ];
    stop = () => {
      for (const off of offs) off();
    };
    refresh();
  };

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    if (listeners.size === 1) start();
    return () => {
      listeners.delete(listener);
      if (listeners.size) return;
      stop?.();
      stop = undefined;
      // nobody listens any more: a read asked meanwhile, or a retry, is not owed to anyone
      again = false;
      if (retry) deps.clearTimer(retry.handle);
      retry = undefined;
      onStop?.();
    };
  };

  return { subscribe, get: () => state, refresh, set, lastRead: () => started };
}

/**
 * The rows of a new list, each kept as the same object when it did not change (a widget subscribed to one row
 * re-renders only when that one does); `rows` itself when nothing changed, order included.
 */
export function keepRows<R extends { id: string }>(rows: R[], list: R[]): R[] {
  const before = new Map(rows.map((r) => [r.id, r]));
  let changed = list.length !== rows.length;
  const next = list.map((r, i) => {
    const old = before.get(r.id);
    if (old && JSON.stringify(old) === JSON.stringify(r)) {
      if (rows[i] !== old) changed = true;
      return old;
    }
    changed = true;
    return r;
  });
  return changed ? next : rows;
}

/** `next` when it differs from `previous` once serialised, else `previous` (nobody told). */
export const unlessSame = <T>(previous: T, next: T): T => (JSON.stringify(next) === JSON.stringify(previous) ? previous : next);
