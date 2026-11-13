import { useCallback, useEffect, useRef, useState } from "react";
import { cmd } from "../api";
import { control } from "../ws";
import type { Position } from "../../../src/plugins/light/engine/move";
import type { HeadMotionEntry } from "../../../src/plugins/light/show/motion-report";

export type { Position };
export type MotionHead = HeadMotionEntry & { name?: string; manual: Position | null };
export type MotionTarget = { fixtures?: string[]; group?: string };

/** The heads of one scope; `loaded` stays false until the server resolved that scope once. */
export type MotionScope = { heads: MotionHead[]; loaded: boolean };
type Listener = (scope: MotionScope) => void;
type Scope = { target: MotionTarget; ids: Set<string>; loaded: boolean };
/** `last` starts undefined: a new subscriber is always told its scope, even an empty one. */
type Subscriber = { key: string; listener: Listener; last: MotionScope | undefined };
/** `retried`: a read overtaken by the topic is replayed once, never in an unbounded loop. */
type ReadJob = { key: string; target: MotionTarget; scope?: Scope; retried?: boolean };

/** Commands after which a scope may resolve to other heads (membership, selectors, patch, another show). */
const GROUP_VALUE_ONLY = new Set(["group.level", "group.mute", "group.flash"]);
const reloadsScopes = (name: string): boolean =>
  name === "panic" ||
  ["show.open", "show.create", "show.apply", "show.revert", "show.reset", "venue.grouping.apply"].includes(name) ||
  name.startsWith("show.venue.") ||
  name.startsWith("history.") ||
  name.startsWith("venue.fixture.") ||
  (name.startsWith("group.") && !GROUP_VALUE_ONLY.has(name));

/** Same tolerance as the pad: a 16-bit read back of the asked point is that point. */
const POINT_TOLERANCE = 1.5 / 255;
/** Reads in a row with the same sent position after which a head held by hand is taken as stopped short (a console, a fader). */
const STILL_READS = 2;
const sameSent = (a: Position | null, b: Position | null): boolean => a !== null && b !== null && a.pan === b.pan && a.tilt === b.tilt;

const targetKey = (target: MotionTarget): string => (target.fixtures ? `fixtures:${[...target.fixtures].sort().join(",")}` : target.group ? `group:${target.group}` : "all");

/**
 * One motion report for every pad and fixture panel. Scoped reads resolve groups on the server; while anything can
 * move, a single poll reads the union of all scopes. The control topic is subscribed once, never once per widget.
 */
class MotionHeadsStore {
  private readonly subscribers = new Map<number, Subscriber>();
  private readonly scopes = new Map<string, Scope>();
  private readonly heads = new Map<string, MotionHead>();
  private readonly queue = new Map<string, ReadJob>();
  /** Per head, how many position.list answers in a row brought the same sent position. */
  private readonly stillReads = new Map<string, number>();
  private nextSubscriber = 1;
  private generation = 0;
  private reading = false;
  private motionSequence = 0;
  private gestureUntil = 0;
  private timer: number | undefined;
  private stopTopic: (() => void) | undefined;
  private stopCommands: (() => void) | undefined;
  private stopStatus: (() => void) | undefined;

  subscribe(key: string, target: MotionTarget, listener: Listener): () => void {
    const id = this.nextSubscriber++;
    const subscriber: Subscriber = { key, listener, last: undefined };
    this.subscribers.set(id, subscriber);
    let scope = this.scopes.get(key);
    if (!scope) {
      scope = { target, ids: new Set(), loaded: false };
      this.scopes.set(key, scope);
      this.enqueue({ key: `scope:${key}`, target, scope });
    }
    if (this.subscribers.size === 1) this.start();
    this.notify(subscriber);
    this.pump();
    return () => {
      this.subscribers.delete(id);
      if (![...this.subscribers.values()].some((other) => other.key === key)) {
        this.scopes.delete(key);
        this.queue.delete(`scope:${key}`);
      }
      if (this.subscribers.size) {
        this.schedule();
        return;
      }
      this.generation += 1;
      if (this.timer !== undefined) window.clearTimeout(this.timer);
      this.timer = undefined;
      this.queue.clear();
      this.scopes.clear();
      this.heads.clear();
      this.stillReads.clear();
      this.stopTopic?.();
      this.stopCommands?.();
      this.stopStatus?.();
      this.stopTopic = this.stopCommands = this.stopStatus = undefined;
    };
  }

  refresh(key: string): void {
    const scope = this.scopes.get(key);
    if (!scope) return;
    this.enqueue({ key: `scope:${key}`, target: scope.target, scope });
    this.pump();
  }

  markGesture(): void {
    this.gestureUntil = Date.now() + 1000;
    this.stillReads.clear(); // a new gesture: a head held short before may move again
    this.schedule();
  }

  private start(): void {
    this.stopTopic = control.subscribe("light:motion", (data) => {
      this.motionSequence += 1;
      const report = (data as { heads: HeadMotionEntry[] }).heads;
      for (const entry of report) {
        const old = this.heads.get(entry.id);
        // `sent` in this throttled ownership topic may predate the last position.list answer: it is not a position feed.
        this.heads.set(entry.id, { ...old, ...entry, sent: old?.sent ?? entry.sent, name: old?.name, manual: old?.manual ?? null });
      }
      this.notifyAll();
      // The topic has no `manual`: read it back instead of leaving a stale position after a release.
      this.enqueueAggregate();
      this.pump();
    });
    this.stopCommands = control.subscribe("light:command", (data) => {
      const event = data as { name: string; ok: boolean; target?: string };
      if (!event.ok) return;
      if (event.name.startsWith("position.")) {
        // A pad's own gesture is already represented locally and followed by the one-second bounded poll.
        if (Date.now() < this.gestureUntil) return;
        this.enqueueAggregate();
      } else if (event.name === "group.delete") {
        const key = `group:${event.target ?? ""}`;
        const removed = this.scopes.get(key);
        if (removed) {
          removed.ids.clear();
          removed.loaded = true;
          this.queue.delete(`scope:${key}`);
        }
        for (const [otherKey, scope] of this.scopes) if (otherKey !== key && scope.target.group) this.enqueue({ key: `scope:${otherKey}`, target: scope.target, scope });
        this.notifyAll();
      } else if (event.name === "venue.fixture.delete") {
        const id = event.target;
        if (id) {
          this.heads.delete(id);
          for (const scope of this.scopes.values()) scope.ids.delete(id);
          this.queue.delete("aggregate");
          this.notifyAll();
        }
        this.reloadScopes(); // a group selecting it by role or tag may resolve differently now
      } else if (reloadsScopes(event.name)) {
        // Membership and selectors may have changed; fader moves (group.level, mute, flash) deliberately re-read nothing.
        this.reloadScopes();
      } else return;
      this.pump();
    });
    this.stopStatus = control.onStatus((up) => {
      if (!up) return;
      this.reloadScopes();
      this.pump();
    });
  }

  private reloadScopes(): void {
    for (const [key, scope] of this.scopes) this.enqueue({ key: `scope:${key}`, target: scope.target, scope });
  }

  private enqueue(job: ReadJob): void {
    this.queue.set(job.key, job);
  }

  private enqueueAggregate(): void {
    if (!this.subscribers.size) return;
    const all = [...this.scopes.values()].find((scope) => !scope.target.fixtures && !scope.target.group);
    if (all) {
      // Its first scoped read is already the complete read; do not issue the same initial request twice.
      if (all.loaded) this.enqueue({ key: "aggregate", target: {}, scope: all });
      return;
    }
    const ids = new Set<string>();
    for (const scope of this.scopes.values()) for (const id of scope.ids) ids.add(id);
    if (ids.size) this.enqueue({ key: "aggregate", target: { fixtures: [...ids].sort() } });
  }

  private pump(): void {
    if (this.reading || !this.subscribers.size) return;
    const job = this.queue.values().next().value as ReadJob | undefined;
    if (!job) {
      this.schedule();
      return;
    }
    this.queue.delete(job.key);
    this.reading = true;
    const generation = this.generation;
    const motionAtStart = this.motionSequence;
    void cmd<MotionHead[]>("position.list", job.target)
      .then((list) => {
        if (generation !== this.generation) return;
        const overtaken = motionAtStart !== this.motionSequence;
        // Overtaken by the topic: still apply what only this answer carries (manual, name, sent, membership), keep the
        // newer layers and owners, and read again once — never in a loop that a busy topic would starve.
        this.apply(job, list, overtaken);
        // never over a newer read of the same key queued meanwhile: it already asks for what this retry would
        if (overtaken && !job.retried && !this.queue.has(job.key)) this.enqueue({ ...job, retried: true });
      })
      .catch(() => {
        if (generation !== this.generation) return;
        // An aggregate read refused (a fixture gone from a scope): resolve the scopes again rather than retry it.
        if (job.key === "aggregate") this.reloadScopes();
        else if (job.scope) {
          // A scope that no longer resolves (its fixture gone after another show opened): it shows no head, and the poll
          // has nothing left to read there — never a refused read again every 200 ms. A later command or topic reloads it.
          job.scope.ids.clear();
          job.scope.loaded = true;
        }
        // Otherwise a later topic, command, reconnect or active poll retries; no unhandled rejection reaches the UI.
      })
      .finally(() => {
        this.reading = false;
        if (generation !== this.generation) {
          // A new page may have subscribed while this obsolete request was finishing: start its queued read.
          this.pump();
          return;
        }
        this.notifyAll();
        this.pump();
        this.schedule();
      });
  }

  private apply(job: ReadJob, list: MotionHead[], keepTopic = false): void {
    for (const entry of list) {
      const old = this.heads.get(entry.id);
      this.stillReads.set(entry.id, old && sameSent(old.sent, entry.sent) ? (this.stillReads.get(entry.id) ?? 0) + 1 : 0);
      const topic = keepTopic ? old : undefined;
      // The topic owns the layer stack, owner, lock and rest; position.list alone carries manual, name and a fresh sent.
      this.heads.set(entry.id, topic ? { ...entry, motion: topic.motion, rest: topic.rest } : entry);
    }
    if (!job.scope) return;
    job.scope.ids = new Set(list.map((entry) => entry.id));
    job.scope.loaded = true;
    if (!job.scope.target.fixtures && !job.scope.target.group) {
      const known = new Set(job.scope.ids);
      for (const id of this.heads.keys()) if (!known.has(id)) this.heads.delete(id);
    }
  }

  /**
   * Poll only while a position really changes: a glide, a moving shape or raw steps, a local gesture in the last second,
   * or a head held by hand still on its way to the asked point (a speed rule slows it down) — until its sent position
   * stays the same over two reads (a DMX console or a fader holding the axis): the poll never runs forever.
   */
  private canMove(): boolean {
    if (Date.now() < this.gestureUntil) return true;
    for (const scope of this.scopes.values()) {
      for (const id of scope.ids) {
        const head = this.heads.get(id);
        const motion = head?.motion;
        if (!head || !motion) continue;
        for (const axis of ["pan", "tilt"] as const) {
          const status = motion[axis];
          if (status.moving || status.animated) return true;
          const { manual, sent } = head;
          if (status.layer === "manual" && manual && sent && Math.abs(manual[axis] - sent[axis]) > POINT_TOLERANCE && (this.stillReads.get(id) ?? 0) < STILL_READS) return true;
        }
      }
    }
    return false;
  }

  private schedule(): void {
    if (this.timer !== undefined || !this.subscribers.size || !this.canMove()) return;
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      if (!this.canMove()) return;
      this.enqueueAggregate();
      this.pump();
    }, 200);
  }

  private scopeOf(subscriber: Subscriber): MotionScope {
    const scope = this.scopes.get(subscriber.key);
    if (!scope?.loaded) return { heads: [], loaded: false };
    const heads = [...scope.ids].flatMap((id) => {
      const head = this.heads.get(id);
      return head ? [head] : [];
    });
    return { heads, loaded: true };
  }

  private notify(subscriber: Subscriber): void {
    const next = this.scopeOf(subscriber);
    const last = subscriber.last;
    const same = last !== undefined && last.loaded === next.loaded && next.heads.length === last.heads.length && next.heads.every((head, i) => head === last.heads[i]);
    if (same) return;
    subscriber.last = next;
    subscriber.listener(next);
  }

  private notifyAll(): void {
    for (const subscriber of this.subscribers.values()) this.notify(subscriber);
  }
}

const store = new MotionHeadsStore();

const NOT_LOADED: MotionScope = { heads: [], loaded: false };

/** The scoped motion report shared by all mounted consumers; `loaded` is false until this target was resolved once. */
export function useMotionHeads(target: MotionTarget = {}): MotionScope & { refresh: () => void; markGesture: () => void } {
  const key = targetKey(target);
  const current = useRef(target);
  current.current = target;
  const [scope, setScope] = useState<MotionScope & { key: string }>({ ...NOT_LOADED, key });
  useEffect(() => store.subscribe(key, current.current, (next) => setScope({ ...next, key })), [key]);
  const refresh = useCallback(() => store.refresh(key), [key]);
  const markGesture = useCallback(() => store.markGesture(), []);
  // Until the new target's first answer, never show the previous target's heads.
  const shown = scope.key === key ? scope : NOT_LOADED;
  return { heads: shown.heads, loaded: shown.loaded, refresh, markGesture };
}
