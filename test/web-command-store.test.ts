import { expect } from "chai";
import { createCommandStore, keepRows, RETRY_MS, unlessSame, type CommandStoreDeps, type CommandStoreOptions } from "../web/src/command-store.js";

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** A command channel, a control channel and timers moved by hand. */
function fakeDeps() {
  const calls: { name: string; resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];
  const topics = new Map<string, Set<(data: unknown) => void>>();
  const status = new Set<(up: boolean) => void>();
  const timers = new Map<number, { ms: number; fn: () => void }>();
  let next = 1;
  const deps: CommandStoreDeps<number> = {
    cmd: <T>(name: string) => new Promise<T>((resolve, reject) => calls.push({ name, resolve: resolve as (v: unknown) => void, reject })),
    control: {
      subscribe: (topic, handler) => {
        const set = topics.get(topic) ?? new Set();
        topics.set(topic, set);
        set.add(handler);
        return () => set.delete(handler);
      },
      onStatus: (fn) => {
        status.add(fn);
        return () => status.delete(fn);
      },
    },
    setTimer: (fn, ms) => {
      const id = next++;
      timers.set(id, { ms, fn });
      return id;
    },
    clearTimer: (id) => void timers.delete(id),
  };
  return {
    deps,
    calls,
    timers,
    /** Answers the oldest read still pending. */
    async answer(value: unknown) {
      calls.shift()!.resolve(value);
      await settle();
    },
    async fail() {
      calls.shift()!.reject(new Error("down"));
      await settle();
    },
    emit(topic: string, data: unknown) {
      for (const fn of [...(topics.get(topic) ?? [])]) fn(data);
    },
    command(name: string, ok = true) {
      this.emit("light:command", { name, ok });
    },
    up() {
      for (const fn of [...status]) fn(true);
    },
    async runTimers() {
      const due = [...timers.entries()];
      timers.clear();
      for (const [, t] of due) t.fn();
      await settle();
    },
    listening: () => [...topics.values()].reduce((n, s) => n + s.size, 0) + status.size,
  };
}

type Rows = { rows: { id: string; v: number }[]; loaded: boolean };
const options = (extra: Partial<CommandStoreOptions<Rows, { id: string; v: number }[]>> = {}): CommandStoreOptions<Rows, { id: string; v: number }[]> => ({
  command: "thing.list",
  initial: { rows: [], loaded: false },
  prefixes: ["thing.", "show."],
  ignore: ["thing.list", "thing.go"],
  loaded: (s) => s.loaded,
  map: (list, previous) => {
    const rows = keepRows(previous.rows, list);
    return previous.loaded && rows === previous.rows ? previous : { rows, loaded: true };
  },
  ...extra,
});

/** The web's stores read by one command (T44): one read in flight, one more after it, a retry before the first load. */
describe("command store (web)", () => {
  it("reads once when the first listener comes, and tells the listeners only when the state changed", async () => {
    const f = fakeDeps();
    const store = createCommandStore(options(), f.deps);
    let told = 0;
    store.subscribe(() => told++);
    store.subscribe(() => told++);
    expect(f.calls.map((c) => c.name)).to.deep.equal(["thing.list"]);
    await f.answer([{ id: "a", v: 1 }]);
    expect(told).to.equal(2);
    expect(store.get()).to.deep.equal({ rows: [{ id: "a", v: 1 }], loaded: true });
    const first = store.get();
    store.refresh();
    await f.answer([{ id: "a", v: 1 }]);
    expect(told).to.equal(2);
    expect(store.get()).to.equal(first);
  });

  it("marks an empty first answer as loaded", async () => {
    const f = fakeDeps();
    const store = createCommandStore(options(), f.deps);
    let told = 0;
    store.subscribe(() => told++);
    await f.answer([]);
    expect(store.get().loaded).to.equal(true);
    expect(told).to.equal(1);
  });

  it("keeps the identity of the rows that did not change", async () => {
    const f = fakeDeps();
    const store = createCommandStore(options(), f.deps);
    store.subscribe(() => undefined);
    await f.answer([
      { id: "a", v: 1 },
      { id: "b", v: 1 },
    ]);
    const [a] = store.get().rows;
    store.refresh();
    await f.answer([
      { id: "a", v: 1 },
      { id: "b", v: 2 },
    ]);
    expect(store.get().rows[0]).to.equal(a);
    expect(store.get().rows[1]).to.deep.equal({ id: "b", v: 2 });
  });

  it("keeps one read in flight and one more after it, however many commands come", async () => {
    const f = fakeDeps();
    const store = createCommandStore(options(), f.deps);
    store.subscribe(() => undefined);
    f.command("thing.put");
    f.command("show.open");
    store.refresh();
    expect(f.calls).to.have.length(1);
    await f.answer([]);
    expect(f.calls).to.have.length(1);
    await f.answer([]);
    expect(f.calls).to.have.length(0);
  });

  it("reads again after a successful command of its prefixes, never after a failed, ignored or foreign one", async () => {
    const f = fakeDeps();
    const store = createCommandStore(options(), f.deps);
    store.subscribe(() => undefined);
    await f.answer([]);
    f.command("thing.put", false);
    f.command("thing.list");
    f.command("thing.go");
    f.command("other.put");
    expect(f.calls).to.have.length(0);
    f.command("thing.put");
    expect(f.calls).to.have.length(1);
  });

  it("reads again when the link comes back up, and after its extra topics", async () => {
    const f = fakeDeps();
    const store = createCommandStore(options({ topics: ["light:song"] }), f.deps);
    store.subscribe(() => undefined);
    await f.answer([]);
    f.up();
    await f.answer([]);
    f.emit("light:song", {});
    expect(f.calls).to.have.length(1);
  });

  it("hands a command to onCommand first: handled there, it reads nothing", async () => {
    const f = fakeDeps();
    const seen: string[] = [];
    const store = createCommandStore(options({ onCommand: (name) => (seen.push(name), name === "thing.set") }), f.deps);
    store.subscribe(() => undefined);
    await f.answer([]);
    f.command("thing.set");
    expect(f.calls).to.have.length(0);
    f.command("thing.put");
    expect(f.calls).to.have.length(1);
    expect(seen).to.deep.equal(["thing.set", "thing.put"]);
  });

  it("tries a failed first read again after 2 s while someone listens, never once loaded", async () => {
    const f = fakeDeps();
    const store = createCommandStore(options(), f.deps);
    store.subscribe(() => undefined);
    await f.fail();
    expect([...f.timers.values()].map((t) => t.ms)).to.deep.equal([RETRY_MS]);
    await f.runTimers();
    expect(f.calls).to.have.length(1);
    await f.answer([]);
    store.refresh();
    await f.fail();
    expect(f.timers.size).to.equal(0);
  });

  it("never tries again without `loaded`", async () => {
    const f = fakeDeps();
    const { loaded: _loaded, ...rest } = options();
    const store = createCommandStore(rest, f.deps);
    store.subscribe(() => undefined);
    await f.fail();
    expect(f.timers.size).to.equal(0);
  });

  it("stops when nobody listens: no subscription, no retry, no read owed", async () => {
    const f = fakeDeps();
    let stopped = 0;
    const store = createCommandStore(options({ onStop: () => stopped++ }), f.deps);
    const off = store.subscribe(() => undefined);
    await f.fail();
    expect(f.timers.size).to.equal(1);
    store.refresh();
    store.refresh();
    expect(f.calls).to.have.length(1);
    off();
    expect(f.listening()).to.equal(0);
    expect(f.timers.size).to.equal(0);
    expect(stopped).to.equal(1);
    await f.answer([]);
    expect(f.calls).to.have.length(0);
    // listened to again: subscribed again and read again
    store.subscribe(() => undefined);
    expect(f.listening()).to.be.greaterThan(0);
    expect(f.calls).to.have.length(1);
  });

  it("gives map the number of its read and a way to read once more", async () => {
    const f = fakeDeps();
    const reads: number[] = [];
    const store = createCommandStore(
      options({
        map: (list, previous, { read, readAgain }) => {
          reads.push(read);
          if (read === 1) readAgain();
          return unlessSame(previous, { rows: list, loaded: true });
        },
      }),
      f.deps,
    );
    store.subscribe(() => undefined);
    expect(store.lastRead()).to.equal(1);
    await f.answer([]);
    expect(f.calls).to.have.length(1);
    expect(store.lastRead()).to.equal(2);
    await f.answer([]);
    expect(reads).to.deep.equal([1, 2]);
    expect(f.calls).to.have.length(0);
  });

  it("set tells the listeners only for another state", () => {
    const f = fakeDeps();
    const store = createCommandStore(options(), f.deps);
    let told = 0;
    store.subscribe(() => told++);
    store.set(store.get());
    expect(told).to.equal(0);
    store.set({ rows: [], loaded: true });
    expect(told).to.equal(1);
  });

  it("keepRows gives the same array back when nothing changed, order included", () => {
    const a = { id: "a", v: 1 };
    const b = { id: "b", v: 1 };
    const rows = [a, b];
    expect(keepRows(rows, [{ ...a }, { ...b }])).to.equal(rows);
    const swapped = keepRows(rows, [{ ...b }, { ...a }]);
    expect(swapped).to.not.equal(rows);
    expect(swapped[0]).to.equal(b);
    expect(keepRows(rows, [{ ...a }])).to.deep.equal([a]);
  });
});
