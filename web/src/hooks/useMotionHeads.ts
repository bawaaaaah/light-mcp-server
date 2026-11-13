import { useCallback, useEffect, useRef, useState } from "react";
import { cmd } from "../api";
import { control } from "../ws";
import type { Position } from "../../../src/plugins/light/engine/move";
import type { HeadMotionEntry } from "../../../src/plugins/light/show/motion-report";

export type { Position };
export type MotionHead = HeadMotionEntry & { name?: string; manual: Position | null };
export type MotionTarget = { fixtures?: string[]; group?: string };

type Listener = (heads: MotionHead[]) => void;
type Scope = { target: MotionTarget; ids: Set<string>; loaded: boolean };
type Subscriber = { key: string; listener: Listener; last: MotionHead[] };
type ReadJob = { key: string; target: MotionTarget; scope?: Scope };

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
    const subscriber: Subscriber = { key, listener, last: [] };
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
      } else if (event.name === "panic" || ["show.open", "show.create", "show.apply", "show.revert"].includes(event.name)) {
        this.reloadScopes();
      } else if (event.name === "group.put" || event.name === "venue.fixture.put") {
        // Membership and selectors may have changed; fader moves (group.level) deliberately do not re-read anything.
        this.reloadScopes();
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
        if (motionAtStart !== this.motionSequence) {
          // Never drop the only read that carries `manual`: run the same job again after the newer topic state.
          this.enqueue(job);
          return;
        }
        this.apply(job, list);
      })
      .catch(() => {
        // A later topic, command, reconnect or active poll retries; no unhandled rejection reaches the UI.
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

  private apply(job: ReadJob, list: MotionHead[]): void {
    for (const entry of list) this.heads.set(entry.id, entry);
    if (!job.scope) return;
    job.scope.ids = new Set(list.map((entry) => entry.id));
    job.scope.loaded = true;
    if (!job.scope.target.fixtures && !job.scope.target.group) {
      const known = new Set(job.scope.ids);
      for (const id of this.heads.keys()) if (!known.has(id)) this.heads.delete(id);
    }
  }

  private canMove(): boolean {
    if (Date.now() < this.gestureUntil) return true;
    for (const scope of this.scopes.values()) {
      for (const id of scope.ids) {
        const motion = this.heads.get(id)?.motion;
        if (!motion) continue;
        for (const axis of [motion.pan, motion.tilt]) {
          if (axis.moving || axis.layer === "look" || axis.layer === "target") return true;
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

  private headsOf(subscriber: Subscriber): MotionHead[] {
    const scope = this.scopes.get(subscriber.key);
    if (!scope?.loaded) return [];
    return [...scope.ids].flatMap((id) => {
      const head = this.heads.get(id);
      return head ? [head] : [];
    });
  }

  private notify(subscriber: Subscriber): void {
    const next = this.headsOf(subscriber);
    const same = next.length === subscriber.last.length && next.every((head, i) => head === subscriber.last[i]);
    if (same) return;
    subscriber.last = next;
    subscriber.listener(next);
  }

  private notifyAll(): void {
    for (const subscriber of this.subscribers.values()) this.notify(subscriber);
  }
}

const store = new MotionHeadsStore();

/** The scoped motion report shared by all mounted consumers. */
export function useMotionHeads(target: MotionTarget = {}): { heads: MotionHead[]; refresh: () => void; markGesture: () => void } {
  const key = targetKey(target);
  const current = useRef(target);
  current.current = target;
  const [heads, setHeads] = useState<MotionHead[]>([]);
  useEffect(() => store.subscribe(key, current.current, setHeads), [key]);
  const refresh = useCallback(() => store.refresh(key), [key]);
  const markGesture = useCallback(() => store.markGesture(), []);
  return { heads, refresh, markGesture };
}
